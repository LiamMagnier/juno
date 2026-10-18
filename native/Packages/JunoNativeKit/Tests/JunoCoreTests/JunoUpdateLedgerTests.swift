import XCTest
@testable import JunoCore

/// The apply ledger: an attempted install that did not land is counted, a
/// version that keeps failing stops being installed, and a release the feed
/// pulled is never installed or offered again.
final class JunoUpdateLedgerTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func staged(_ version: String = "1.13.0", build: String = "130", channel: String? = nil) -> JunoUpdateLedger {
        var ledger = JunoUpdateLedger()
        ledger.recordStaged(version: version, build: build, channel: channel, from: "1.12.0", at: t0)
        return ledger
    }

    // MARK: Launch reconciliation

    func testNothingStagedIsNothingPending() {
        var ledger = JunoUpdateLedger()
        XCTAssertEqual(ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0), .nothingPending)
    }

    func testRunningTheStagedBuildIsApplied() {
        var ledger = staged()
        ledger.recordInstallAttempt(at: t0)
        let outcome = ledger.reconcileLaunch(runningVersion: "1.13.0", runningBuild: "130", at: t0)
        XCTAssertEqual(outcome, .applied(version: "1.13.0"))
        XCTAssertNil(ledger.staged)
        XCTAssertEqual(ledger.failureCount(for: "1.13.0"), 0)
        XCTAssertEqual(ledger.history.last?.kind, .applied)
    }

    func testStagedButNeverAttemptedIsDiscardedNotFailed() {
        var ledger = staged()
        let outcome = ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0)
        XCTAssertEqual(outcome, .discardedUnattempted(version: "1.13.0"))
        XCTAssertEqual(ledger.failureCount(for: "1.13.0"), 0)
    }

    /// A7: a forced swap failure leaves the old app running and records
    /// failedApplies = 1; the second failure blocks the version.
    func testFailedAppliesAreCountedAndBlockAtTheLimit() {
        var ledger = staged()
        ledger.recordInstallAttempt(at: t0)
        XCTAssertEqual(
            ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0),
            .failed(version: "1.13.0", attempts: 1, blocked: false)
        )
        XCTAssertEqual(ledger.failureCount(for: "1.13.0"), 1)
        XCTAssertEqual(ledger.decision(offered: "1.13.0", installed: "1.12.0"), .install("1.13.0"))

        ledger.recordStaged(version: "1.13.0", build: "130", channel: nil, from: "1.12.0", at: t0)
        ledger.recordInstallAttempt(at: t0)
        XCTAssertEqual(
            ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0),
            .failed(version: "1.13.0", attempts: 2, blocked: true)
        )
        XCTAssertTrue(ledger.isBlocked("1.13.0"))
        XCTAssertEqual(ledger.decision(offered: "1.13.0", installed: "1.12.0"), .blocked("1.13.0"))
        // A newer build is not held back by an older one's failures.
        XCTAssertEqual(ledger.decision(offered: "1.13.1", installed: "1.12.0"), .install("1.13.1"))
    }

    func testAManualInstallOfABlockedVersionClearsItsCount() {
        var ledger = staged()
        ledger.recordInstallAttempt(at: t0)
        _ = ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0)
        ledger.recordStaged(version: "1.13.0", build: "130", channel: nil, from: "1.12.0", at: t0)
        ledger.recordInstallAttempt(at: t0)
        _ = ledger.reconcileLaunch(runningVersion: "1.13.0", runningBuild: "130", at: t0)
        XCTAssertFalse(ledger.isBlocked("1.13.0"))
    }

    func testRecordInstallAttemptWithoutStagedIsRefused() {
        var ledger = JunoUpdateLedger()
        XCTAssertFalse(ledger.recordInstallAttempt(at: t0))
    }

    // MARK: Pulled releases

    func testVerdicts() {
        XCTAssertEqual(JunoUpdateLedger.verdict(staged: "1.13.0", offered: "1.13.0"), .keep)
        XCTAssertEqual(JunoUpdateLedger.verdict(staged: "1.13.0", offered: "1.13.1"), .superseded(by: "1.13.1"))
        XCTAssertEqual(JunoUpdateLedger.verdict(staged: "1.13.0", offered: "1.12.0"), .withdrawn)
        XCTAssertEqual(JunoUpdateLedger.verdict(staged: "1.13.0", offered: nil), .withdrawn)
    }

    /// A6 (withdrawal half): a staged version the feed pulled is unstaged and
    /// never offered again.
    func testAWithdrawnStagedVersionIsUnstagedAndNeverOfferedAgain() {
        var ledger = staged()
        ledger.recordUnstaged(.withdrawn, at: t0)
        XCTAssertNil(ledger.staged)
        XCTAssertTrue(ledger.isWithdrawn("1.13.0"))
        XCTAssertEqual(ledger.decision(offered: "1.13.0", installed: "1.12.0"), .withdrawn("1.13.0"))
        XCTAssertEqual(ledger.history.last?.kind, .withdrawn)
        // A pulled release never reaches the launch check as a failure either.
        XCTAssertEqual(ledger.reconcileLaunch(runningVersion: "1.12.0", runningBuild: "120", at: t0), .nothingPending)
    }

    func testASupersededStagedVersionIsUnstagedButNotWithdrawn() {
        var ledger = staged()
        ledger.recordUnstaged(.superseded(by: "1.13.1"), at: t0)
        XCTAssertNil(ledger.staged)
        XCTAssertFalse(ledger.isWithdrawn("1.13.0"))
    }

    func testKeepLeavesTheStagedVersion() {
        var ledger = staged(channel: "next")
        ledger.recordUnstaged(.keep, at: t0)
        XCTAssertEqual(ledger.staged?.version, "1.13.0")
        XCTAssertEqual(ledger.staged?.channel, "next")
    }

    func testDecisionNeverOffersAnEqualOrOlderBuild() {
        let ledger = JunoUpdateLedger()
        XCTAssertEqual(ledger.decision(offered: nil, installed: "1.12.0"), .current)
        XCTAssertEqual(ledger.decision(offered: "1.12.0", installed: "1.12.0"), .current)
        XCTAssertEqual(ledger.decision(offered: "1.11.0", installed: "1.12.0"), .current)
    }

    // MARK: Bounds and storage

    func testHistoryAndWithdrawnListsAreBounded() {
        var ledger = JunoUpdateLedger()
        for minor in 0..<40 {
            ledger.recordStaged(version: "1.\(minor).0", build: "", channel: nil, from: "1.0.0", at: t0)
            ledger.recordUnstaged(.withdrawn, at: t0)
        }
        XCTAssertEqual(ledger.history.count, JunoUpdateLedger.historyLimit)
        XCTAssertEqual(ledger.withdrawn.count, JunoUpdateLedger.withdrawnLimit)
        XCTAssertTrue(ledger.isWithdrawn("1.39.0"))
        XCTAssertFalse(ledger.isWithdrawn("1.0.0"))
    }

    func testStoreRoundTripsAndTreatsAMissingOrCorruptFileAsEmpty() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ledger-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = JunoUpdateLedgerStore(fileURL: directory.appending(path: "updater.json"))
        XCTAssertEqual(store.load(), JunoUpdateLedger())

        var ledger = staged(channel: "next")
        ledger.recordInstallAttempt(at: t0)
        try store.save(ledger)
        XCTAssertEqual(store.load(), ledger)

        try Data("not json".utf8).write(to: store.fileURL)
        XCTAssertEqual(store.load(), JunoUpdateLedger())
    }

    func testAnOlderFileWithoutNewerKeysStillReads() throws {
        let data = Data(#"{"failedApplies":{"1.13.0":1}}"#.utf8)
        let ledger = try JSONDecoder().decode(JunoUpdateLedger.self, from: data)
        XCTAssertEqual(ledger.failureCount(for: "1.13.0"), 1)
        XCTAssertTrue(ledger.withdrawn.isEmpty)
        XCTAssertNil(ledger.staged)
    }

    // MARK: Offline

    func testOfflineErrorsAreRecognised() {
        XCTAssertTrue(JunoUpdateLedger.isOffline(URLError(.notConnectedToInternet)))
        XCTAssertTrue(JunoUpdateLedger.isOffline(URLError(.networkConnectionLost)))
        XCTAssertFalse(JunoUpdateLedger.isOffline(URLError(.badServerResponse)))
        XCTAssertFalse(JunoUpdateLedger.isOffline(JunoUpdateFeed.FeedError.malformed))
    }
}
