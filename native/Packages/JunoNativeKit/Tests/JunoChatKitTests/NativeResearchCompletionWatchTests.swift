import Foundation
import Testing
@testable import JunoChatKit

/// The research completion watcher (the web's `completion-watch.ts`): a run
/// an app saw working and now sees finished is announced once; a run that was
/// already finished is the baseline; a hand-off run that drives itself to
/// completion is found again after the app was quit.
struct NativeResearchCompletionWatchTests {
    private func summary(
        _ id: String, state: String, live: Bool, conversation: String? = "conv_1", title: String? = "Heat pumps"
    ) -> NativeResearchRunSummary {
        NativeResearchRunSummary(
            id: id, conversationID: conversation, state: state, phase: nil, live: live,
            assistantMessageID: nil, createdAt: nil, title: title
        )
    }

    @Test
    func aRunSeenWorkingAndThenFinishedIsAnnouncedOnce() {
        var watch = NativeResearchCompletionWatch()
        #expect(watch.apply([summary("rr_1", state: "investigating", live: true)]).finished.isEmpty)
        let outcome = watch.apply([summary("rr_1", state: "completed", live: false)])
        #expect(outcome.finished == [
            NativeResearchCompletion(runID: "rr_1", conversationID: "conv_1", title: "Heat pumps", kind: .ready)
        ])
        #expect(watch.apply([summary("rr_1", state: "completed", live: false)]).finished.isEmpty, "never twice")
        #expect(watch.seenLive.isEmpty)
    }

    @Test
    func anAlreadyFinishedRunIsTheBaselineNotNews() {
        var watch = NativeResearchCompletionWatch()
        let outcome = watch.apply([summary("rr_2", state: "completed", live: false)])
        #expect(outcome.finished.isEmpty)
        #expect(outcome.missing.isEmpty)
    }

    @Test
    func aStopIsNotAnnouncedAndAFailureIs() {
        var watch = NativeResearchCompletionWatch(seenLive: ["rr_3", "rr_4"])
        let outcome = watch.apply([
            summary("rr_3", state: "cancelled", live: false),
            summary("rr_4", state: "failed", live: false, title: nil),
        ])
        #expect(outcome.finished.map(\.runID) == ["rr_4"])
        #expect(outcome.finished.first?.kind == .failed)
        #expect(outcome.finished.first?.title == "Deep research", "a run with no title still says what it was")
        #expect(outcome.finished.first?.headline == "Your research did not finish")
        #expect(watch.seenLive.isEmpty)
    }

    @Test
    func aRunThatFinishedWhileTheAppWasQuitIsReadOnItsOwn() {
        // The Mac saw the hand-off run working, was quit, and opens an hour
        // later: the ten-minute list no longer carries it.
        var watch = NativeResearchCompletionWatch(seenLive: ["rr_5"])
        let outcome = watch.apply([])
        #expect(outcome.missing == ["rr_5"])
        let stillGoing = NativeResearchRun(id: "rr_5", state: "investigating", phase: .searching)
        #expect(watch.settle(stillGoing) == nil)
        #expect(watch.seenLive == ["rr_5"], "still live: still watched")
        let done = NativeResearchRun(id: "rr_5", conversationID: "conv_9", goal: "Heat pumps", state: "completed", phase: .done)
        let completion = watch.settle(done)
        #expect(completion?.kind == .ready)
        #expect(completion?.conversationID == "conv_9")
        #expect(watch.seenLive.isEmpty)
        #expect(watch.settle(done) == nil, "settled once")
    }

    @Test
    func runsTheAppIsFollowingCountAsSeenLive() {
        var watch = NativeResearchCompletionWatch()
        watch.noteLive(["rr_6"])
        #expect(watch.apply([summary("rr_6", state: "partially_completed", live: false)]).finished.map(\.kind) == [.ready])
    }

    @Test
    func theNotificationRoutesToTheReportAndCollapsesWithThePush() {
        let completion = NativeResearchCompletion(runID: "rr_7", conversationID: "conv_2", title: "Heat pumps", kind: .ready)
        #expect(completion.userInfo["path"] == "/research/rr_7")
        #expect(completion.userInfo["conversationId"] == "conv_2")
        #expect(completion.notificationIdentifier == "research-rr_7", "the server's apns-collapse-id")
        #expect(completion.threadIdentifier == "research-conv_2", "the server's thread-id")
    }

    @Test
    func theMemoryIsBounded() {
        var watch = NativeResearchCompletionWatch()
        watch.noteLive((0..<200).map { "rr_\($0)" })
        #expect(watch.seenLive.count == NativeResearchCompletionWatch.capacity)
    }
}
