import Foundation
import XCTest
@testable import JunoAuth

#if os(macOS)
/// Pins the bug behind "every time I close the app I need to log in".
///
/// macOS keeps two keychains. A build without an embedded provisioning profile
/// — which is what `release-macos.sh` exports when there is no Developer ID
/// certificate — cannot use the data-protection one, so its writes fall back to
/// the legacy file-based store. The read path did not make the same journey:
/// it asked the data-protection store, got `errSecItemNotFound` rather than the
/// `errSecMissingEntitlement` that flips the fallback latch, and then declined
/// to look in the legacy store because there was no provisioning profile. The
/// credential was on disk and unreachable, so the app showed sign-in on every
/// launch.
///
/// These tests run against the real Security framework, because the defect was
/// in which store the real queries addressed — a fake keychain cannot have the
/// bug. The test binary is itself unsigned, so it reproduces the unentitled
/// condition exactly rather than simulating it.
final class KeychainLegacyStoreReadTests: XCTestCase {
    private let client = SystemSecurityKeychainClient()
    private var item: SecurityKeychainItem!

    override func setUp() {
        super.setUp()
        // A unique service per run: these touch the developer's real login
        // keychain, so they must never collide with Juno's own items or with a
        // concurrent run.
        item = SecurityKeychainItem(
            service: "com.liammagnier.juno.tests.legacy-read.\(UUID().uuidString)",
            account: "acct_under_test"
        )
        DataProtectionKeychainGate.shared.resetForTesting()
    }

    override func tearDown() {
        _ = try? client.delete(item)
        DataProtectionKeychainGate.shared.resetForTesting()
        super.tearDown()
    }

    /// The regression itself: write, then open the app again.
    func testACredentialWrittenInOneProcessIsReadableInTheNext() throws {
        let secret = Data("refresh-token".utf8)
        try client.upsert(secret, for: item)

        // Everything above happened in the launch that signed in. The latch is
        // process-scoped by design, so resetting it *is* quitting and reopening
        // the app — and it is the only step this test needs to fail before the
        // fix.
        DataProtectionKeychainGate.shared.resetForTesting()

        XCTAssertEqual(
            try client.read(item),
            secret,
            "The token is on disk; a relaunch has to be able to read it back."
        )
    }

    /// The same blind spot re-keyed the local database. `insertIfAbsent` must
    /// report an existing key as present, or the store gets a new key and the
    /// data encrypted with the old one becomes unreadable.
    func testAnExistingKeyIsNotTreatedAsAbsentAfterRelaunch() throws {
        let key = Data("database-key".utf8)
        XCTAssertTrue(
            try client.insertIfAbsent(key, for: item),
            "First write should report that it inserted."
        )

        DataProtectionKeychainGate.shared.resetForTesting()

        XCTAssertFalse(
            try client.insertIfAbsent(Data("a-different-key".utf8), for: item),
            "A key that already exists must never be reported as absent."
        )
        XCTAssertEqual(
            try client.read(item),
            key,
            "The original key must survive; replacing it orphans the database."
        )
    }

    /// Sign-out has to reach whichever store the token actually landed in.
    func testDeleteClearsTheCredentialTheWriteFellBackTo() throws {
        try client.upsert(Data("refresh-token".utf8), for: item)

        DataProtectionKeychainGate.shared.resetForTesting()
        XCTAssertTrue(try client.delete(item), "Sign-out should find the item.")

        DataProtectionKeychainGate.shared.resetForTesting()
        XCTAssertNil(
            try client.read(item),
            "A signed-out token must not stay readable on disk."
        )
    }
}
#endif
