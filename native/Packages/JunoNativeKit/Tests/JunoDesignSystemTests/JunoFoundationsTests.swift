import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// The behaviour under the shared foundations both the overlay and the page
/// tracks build on: the window's toast center, the notifier a page posts
/// through, and the rules the page helpers decide by.
@MainActor
final class JunoFoundationsTests: XCTestCase {

    // MARK: - Toast center

    func testANewerPostReplacesTheToastOnScreen() {
        let center = JunoToastCenter()
        center.post(.success("Chat archived."))
        center.post(.error("Couldn’t archive the chat."))
        XCTAssertEqual(center.current?.title, "Couldn’t archive the chat.")
        XCTAssertEqual(center.current?.tone, .error)
    }

    func testDismissByIDLeavesADifferentToastAlone() {
        let center = JunoToastCenter()
        center.post(JunoToast(id: "library.refresh", tone: .error, title: "Couldn’t load your files"))
        center.dismiss(id: "settings.status")
        XCTAssertEqual(center.current?.id, "library.refresh")
        center.dismiss(id: "library.refresh")
        XCTAssertNil(center.current)
    }

    func testDismissWithNoIDTakesDownWhateverIsShowing() {
        let center = JunoToastCenter()
        center.post(.info("Link copied."))
        center.dismiss()
        XCTAssertNil(center.current)
    }

    func testAToastGoesAfterItsDuration() async throws {
        let clock = ToastTimerProbe()
        let center = JunoToastCenter(sleep: clock.sleep)
        center.post(JunoToast(title: "Saved.", duration: .seconds(4)))
        let timer = try XCTUnwrap(center.timer)
        await clock.waitForRequests(1)
        XCTAssertEqual(clock.durations, [.seconds(4)])
        XCTAssertNotNil(center.current)
        clock.finish(0)
        await timer.value
        XCTAssertNil(center.current)
    }

    func testTheDefaultTimerExpiresWithoutAnInjectedClock() async throws {
        let center = JunoToastCenter()
        center.post(JunoToast(title: "Saved.", duration: .milliseconds(1)))
        let timer = try XCTUnwrap(center.timer)
        await timer.value
        XCTAssertNil(center.current)
    }

    func testHoverPausesTheToastAndLeavingRestartsItsWholeDuration() async throws {
        let clock = ToastTimerProbe()
        let center = JunoToastCenter(sleep: clock.sleep)
        center.post(JunoToast(title: "Saved.", duration: .seconds(4)))
        let original = try XCTUnwrap(center.timer)
        await clock.waitForRequests(1)
        center.setHovering(true)
        clock.finish(0)
        await original.value
        XCTAssertEqual(center.current?.title, "Saved.")
        XCTAssertNil(center.timer)
        center.setHovering(false)
        let restarted = try XCTUnwrap(center.timer)
        await clock.waitForRequests(2)
        XCTAssertEqual(clock.durations, [.seconds(4), .seconds(4)])
        clock.finish(1)
        await restarted.value
        XCTAssertNil(center.current)
    }

    func testAStandingToastStaysUntilDismissed() {
        let clock = ToastTimerProbe()
        let center = JunoToastCenter(sleep: clock.sleep)
        center.post(JunoToast(tone: .warning, title: "Changed on another device.", duration: nil))
        XCTAssertNil(center.timer)
        XCTAssertTrue(clock.durations.isEmpty)
        XCTAssertNotNil(center.current)
        center.dismiss()
        XCTAssertNil(center.current)
    }

    func testTheDefaultDurationIsTheWebsFourSeconds() {
        XCTAssertEqual(JunoToast.defaultDuration, .seconds(4))
        XCTAssertEqual(JunoToast.success("Done").duration, .seconds(4))
    }

    func testRepostingAnIDRestartsItsTimer() async throws {
        let clock = ToastTimerProbe()
        let center = JunoToastCenter(sleep: clock.sleep)
        center.post(JunoToast(id: "status", title: "First", duration: .seconds(4)))
        let first = try XCTUnwrap(center.timer)
        await clock.waitForRequests(1)
        center.post(JunoToast(id: "status", title: "Second", duration: .seconds(4)))
        let second = try XCTUnwrap(center.timer)
        await clock.waitForRequests(2)
        XCTAssertTrue(first.isCancelled)
        // Complete the obsolete timer even though it was cancelled. Await its
        // actual completion: it must not dismiss the replacement with this ID.
        clock.finish(0)
        await first.value
        XCTAssertEqual(center.current?.title, "Second")
        XCTAssertEqual(clock.durations, [.seconds(4), .seconds(4)])
        clock.finish(1)
        await second.value
        XCTAssertNil(center.current)
    }

    func testAnEmptySelectionRaisesNoBar() {
        let center = JunoToastCenter()
        center.setSelection(JunoToastSelection(count: 0, clear: {}))
        XCTAssertNil(center.selection)
        center.setSelection(JunoToastSelection(count: 3, clear: {}))
        XCTAssertEqual(center.selection?.count, 3)
        center.setSelection(nil)
        XCTAssertNil(center.selection)
    }

    func testTheNotifierPostsToItsCenterAndDoesNothingWithoutOne() {
        let center = JunoToastCenter()
        JunoToastNotifier(center: center)(.success("Chat archived."))
        XCTAssertEqual(center.current?.title, "Chat archived.")
        JunoToastNotifier().post(.error("Nowhere to go"))
        XCTAssertEqual(center.current?.title, "Chat archived.")
    }

    func testTheHostsMetricsAreTheSpecs() {
        XCTAssertEqual(JunoToastMetrics.maxWidth, 420)
        XCTAssertEqual(JunoToastMetrics.composerClearance, 12)
        XCTAssertEqual(JunoToastMetrics.bottomClearance, 24)
        // Errata 9: the web's toasts are cards, not capsules.
        XCTAssertEqual(JunoToastMetrics.cornerRadius, JunoRadius.card)
    }

    // MARK: - Segmented

    func testTheSegmentedTrackIsConcentricWithItsThumb() {
        XCTAssertEqual(JunoSegmentedMetrics.trackHeight, 32)
        XCTAssertEqual(JunoSegmentedMetrics.segmentHeight, 24)
        XCTAssertEqual(
            JunoSegmentedMetrics.trackRadius - JunoSegmentedMetrics.inset,
            JunoSegmentedMetrics.thumbRadius
        )
    }

    // MARK: - Inline rename

    func testARenameCommitsOnlyARealChange() {
        XCTAssertEqual(JunoInlineRenameField.change(from: "Draft", to: "  Budget  "), "Budget")
        XCTAssertNil(JunoInlineRenameField.change(from: "Draft", to: "Draft"))
        XCTAssertNil(JunoInlineRenameField.change(from: "Draft", to: "   "))
    }

    // MARK: - Empty state

    func testAFailureGlyphReadsAsAnError() {
        XCTAssertEqual(JunoEmptyState.tone(for: .error), .error)
        XCTAssertEqual(JunoEmptyState.tone(for: .triangleAlert), .error)
        XCTAssertEqual(JunoEmptyState.tone(for: .library), .empty)
        XCTAssertEqual(JunoEmptyState.tone(for: .search), .empty)
    }

    // MARK: - Page

    func testThePageGutterStepsWithTheWeb() {
        XCTAssertEqual(JunoPageLayout.gutter(forPageWidth: 520), 16)
        XCTAssertEqual(JunoPageLayout.gutter(forPageWidth: 640), 24)
        XCTAssertEqual(JunoPageLayout.gutter(forPageWidth: 1024), 32)
    }

    func testThePageMeasuresAreTheWebs() {
        XCTAssertEqual(JunoPageMeasure.reading.maxWidth, 768)
        XCTAssertEqual(JunoPageMeasure.wide.maxWidth, 1024)
        XCTAssertNil(JunoPageMeasure.full.maxWidth)
    }
}


/// Explicit timer completions avoid asserting inside a sub-second wall-clock
/// window on a loaded CI runner. Cancelled waits deliberately still complete.
@MainActor
private final class ToastTimerProbe {
    var durations: [Duration] = []
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var observers: [(Int, CheckedContinuation<Void, Never>)] = []

    func sleep(_ duration: Duration) async {
        await withCheckedContinuation { continuation in
            durations.append(duration)
            continuations.append(continuation)
            let ready = observers.filter { $0.0 <= durations.count }
            observers.removeAll { $0.0 <= durations.count }
            for (_, observer) in ready { observer.resume() }
        }
    }

    func waitForRequests(_ count: Int) async {
        if durations.count >= count { return }
        await withCheckedContinuation { observers.append((count, $0)) }
    }

    func finish(_ index: Int) { continuations[index].resume() }
}
