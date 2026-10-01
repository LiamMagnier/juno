import Foundation
import Observation
import JunoCodeCore
import JunoCodeLocal

/// A session's pull request and its CI, as the CI bar above the composer
/// shows it (CODE_AGENT_SPEC §5.3): "CI: 3 of 4 passed · `test (ubuntu)`
/// failed", with Fix it and an Auto-fix switch, off by default.
///
/// Watching starts when Juno opens a pull request or the reader links one,
/// and stops when every check settles. Fix it, and Auto-fix at most three
/// times per pull request, turn the failure into work; the push that work
/// ends in still asks, every time.
///
/// Owned by Lane E (review, ship, sessions and away).
@MainActor
@Observable
public final class PullRequestModel {
    public private(set) var pullRequest: GitHubPullRequestRef?
    public private(set) var status: CIStatusEvent?
    public private(set) var isWatching = false
    public private(set) var isFixing = false
    /// The last thing that went wrong reading CI or starting a fix, in words.
    public private(set) var problem: String?
    public private(set) var autoFix = CIAutoFixPolicy()
    /// Said once Auto-fix has used its attempts on this pull request.
    public private(set) var autoFixStopped = false

    /// Starts the work a failure becomes. Set by the session; nil in a
    /// preview, where Fix it is not offered.
    @ObservationIgnored var startFix: (@MainActor (CIFixPlan) async -> Bool)?
    /// Records each status in the transcript (`ci.status`).
    @ObservationIgnored var record: (@MainActor (CIStatusEvent) async -> Void)?
    /// Told when every check settled: the `code.ci` notification.
    @ObservationIgnored var settled: (@MainActor (CIStatusEvent) -> Void)?
    /// The recipe checks that cover a CI check, for the fix's criteria.
    @ObservationIgnored var recipeChecks: @Sendable (String) -> [String] = { _ in [] }
    @ObservationIgnored private var watch: CIWatchService?
    @ObservationIgnored private var fileURL: URL?

    public init() {}

    // MARK: Words

    /// "CI: 3 of 4 checks passed; `test (ubuntu)` failed", or nil with no
    /// pull request.
    public var barText: String? {
        guard pullRequest != nil || status != nil else { return nil }
        guard let status, !status.checks.isEmpty else {
            return isWatching ? "CI: waiting for checks to start" : "CI: no checks yet"
        }
        return "CI: " + CIStatusWords.summary(status.checks)
    }

    public var hasFailures: Bool {
        status?.checks.contains { $0.state == .failed } ?? false
    }

    public var isSettled: Bool {
        status.map { CIStatusWords.isSettled($0.checks) } ?? false
    }

    /// Attempts Auto-fix has left on this pull request.
    public var attemptsLeft: Int {
        guard let number = pullRequest?.number else { return CIAutoFixPolicy.maximumAttempts }
        return autoFix.attemptsLeft(for: number)
    }

    public var canFix: Bool { startFix != nil && hasFailures && isSettled && !isFixing }

    // MARK: Persistence

    private struct Saved: Codable {
        var pullRequest: GitHubPullRequestRef?
        var autoFix: CIAutoFixPolicy
    }

    /// Reads what was saved for the session: the linked pull request and the
    /// Auto-fix switch with its attempts.
    func bind(fileURL url: URL) {
        guard fileURL != url else { return }
        fileURL = url
        guard let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(Saved.self, from: data)
        else { return }
        pullRequest = saved.pullRequest
        autoFix = saved.autoFix
    }

    private func save() {
        guard let fileURL else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(Saved(pullRequest: pullRequest, autoFix: autoFix)) else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: Watching

    /// Links a pull request and watches its checks until they settle.
    public func watch(
        _ pullRequest: GitHubPullRequestRef,
        reader: any CIChecksReading,
        sleep: (@Sendable (TimeInterval) async throws -> Void)? = nil
    ) async {
        if self.pullRequest?.number != pullRequest.number {
            autoFixStopped = false
            status = nil
        }
        self.pullRequest = pullRequest
        problem = nil
        save()
        await watch?.stop()
        let service = sleep.map { CIWatchService(reader: reader, sleep: $0) } ?? CIWatchService(reader: reader)
        watch = service
        isWatching = true
        await service.watch(pullRequest: pullRequest.number, url: pullRequest.url) { [weak self] update in
            await self?.apply(update)
        }
    }

    public func stopWatching() async {
        await watch?.stop()
        isWatching = false
    }

    /// Waits for the watch to end (tests).
    func awaitWatch() async {
        await watch?.awaitSettled()
    }

    private func apply(_ update: CIWatchService.Update) async {
        switch update {
        case let .status(next):
            status = next
            problem = nil
            await record?(next)
        case let .settled(next):
            status = next
            problem = nil
            isWatching = false
            await record?(next)
            settled?(next)
            if autoFix.shouldFix(next) {
                _ = await startFixing(next, automatic: true)
            } else if autoFix.isEnabled, hasFailures, let number = next.pullRequestNumber,
                      autoFix.attemptsLeft(for: number) == 0
            {
                autoFixStopped = true
            }
        case let .failed(message):
            problem = "Could not read CI: \(message)"
        case let .stopped(message):
            // The watch never polls forever: no checks, a CLI that keeps
            // failing, or a day of running ends it, said in words.
            isWatching = false
            problem = message
        }
    }

    /// Sets the bar's state directly, for previews and snapshots.
    func show(
        _ pullRequest: GitHubPullRequestRef?,
        status: CIStatusEvent?,
        autoFix: CIAutoFixPolicy = CIAutoFixPolicy(),
        autoFixStopped: Bool = false,
        canFix: Bool = false
    ) {
        self.pullRequest = pullRequest
        self.status = status
        self.autoFix = autoFix
        self.autoFixStopped = autoFixStopped
        if canFix, startFix == nil { startFix = { _ in false } }
    }

    // MARK: Fixing

    public func setAutoFix(_ enabled: Bool) {
        autoFix.isEnabled = enabled
        autoFixStopped = false
        save()
    }

    /// Fix it: turns the failing checks into work now.
    @discardableResult
    public func fixIt() async -> Bool {
        guard let status, hasFailures else { return false }
        return await startFixing(status, automatic: false)
    }

    private func startFixing(_ status: CIStatusEvent, automatic: Bool) async -> Bool {
        guard let startFix, let watch, !isFixing else { return false }
        if automatic, let number = status.pullRequestNumber {
            guard autoFix.recordAttempt(for: number) else {
                autoFixStopped = true
                return false
            }
            save()
        }
        isFixing = true
        defer { isFixing = false }
        let plan = await watch.fixPlan(for: status, recipeChecks: recipeChecks)
        let started = await startFix(plan)
        if !started {
            problem = "The fix could not start: the session is busy or has no project."
        }
        return started
    }
}
