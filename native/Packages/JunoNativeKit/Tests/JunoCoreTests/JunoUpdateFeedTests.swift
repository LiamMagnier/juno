import XCTest
@testable import JunoCore

/// The rules the Mac updater cannot be allowed to get wrong.
///
/// Everything here is about *refusing*. An updater that occasionally fails to
/// notice a new version is an inconvenience; one that installs an older build,
/// reinstalls the same build in a loop, or fetches a DMG from wherever the feed
/// happens to point is a different category of problem. The install-time
/// signature check is the real gate, but it only runs on something this file
/// already agreed to download.
final class JunoUpdateFeedTests: XCTestCase {

    private func feed(
        url: String? = "https://github.com/LiamMagnier/juno/releases/download/v0.2.0/Juno.dmg",
        version: String? = "0.2.0",
        size: Int? = 1234,
        sha256: String? = nil,
        available: Bool = true
    ) -> Data {
        let row: [String: Any] = [
            "platform": "macos",
            "label": "macOS",
            "url": url as Any,
            "version": version as Any,
            "size": size as Any,
            "sha256": sha256 as Any,
            "available": available,
        ]
        let payload: [String: Any] = [
            "downloads": [
                row,
                ["platform": "windows", "label": "Windows", "url": NSNull(), "version": NSNull(),
                 "size": NSNull(), "sha256": NSNull(), "available": false],
            ]
        ]
        return try! JSONSerialization.data(withJSONObject: payload)
    }

    // MARK: - Ordering

    func testANewerPatchIsAnUpdate() {
        XCTAssertTrue(JunoUpdateFeed.isNewer("0.1.3", than: "0.1.2"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("0.2.0", than: "0.1.9"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("1.0.0", than: "0.9.9"))
    }

    /// The reinstall loop: an equal version must never be offered, or the app
    /// downloads and installs itself every ten minutes forever.
    func testTheSameVersionIsNotAnUpdate() {
        XCTAssertFalse(JunoUpdateFeed.isNewer("0.1.2", than: "0.1.2"))
    }

    /// The downgrade: a feed that regressed — by mistake or otherwise — must not
    /// be able to move an installed build backwards.
    func testAnOlderVersionIsNotAnUpdate() {
        XCTAssertFalse(JunoUpdateFeed.isNewer("0.1.1", than: "0.1.2"))
        XCTAssertFalse(JunoUpdateFeed.isNewer("0.9.9", than: "1.0.0"))
    }

    /// Missing components are zero, so `0.2` and `0.2.0` are the same release
    /// rather than one being an update over the other.
    func testMissingComponentsCountAsZero() {
        XCTAssertFalse(JunoUpdateFeed.isNewer("0.2", than: "0.2.0"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("0.2.1", than: "0.2"))
    }

    /// Semver's rule, and it matters here: shipping `1.0.0` must not be undone
    /// by a `1.0.0-rc.1` tag that sorts later alphabetically.
    func testAPrereleaseSortsBelowItsRelease() {
        XCTAssertFalse(JunoUpdateFeed.isNewer("1.0.0-rc.1", than: "1.0.0"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("1.0.0", than: "1.0.0-rc.1"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("1.0.0-rc.2", than: "1.0.0-rc.1"))
    }

    func testALeadingVAndBuildMetadataAreIgnored() {
        XCTAssertFalse(JunoUpdateFeed.isNewer("v0.1.2+abc123", than: "0.1.2"))
        XCTAssertTrue(JunoUpdateFeed.isNewer("v0.1.3", than: "0.1.2"))
    }

    // MARK: - Origin

    func testGitHubReleaseHostsAreAccepted() throws {
        for host in [
            "https://github.com/LiamMagnier/juno/releases/download/v1/Juno.dmg",
            "https://objects.githubusercontent.com/x",
            "https://release-assets.githubusercontent.com/x",
        ] {
            XCTAssertNoThrow(try JunoUpdateFeed.validateOrigin(URL(string: host)!))
        }
    }

    /// The feed is a JSON document served by Juno's own backend. A mistaken or
    /// compromised backend must not be able to point the updater at an arbitrary
    /// host and have the app fetch and mount whatever is there.
    func testAnythingElseIsRefusedBeforeAByteIsFetched() {
        for host in [
            "http://github.com/x",                       // not HTTPS
            "https://githubXcom/x",                      // lookalike host
            "https://evil.example.com/Juno.dmg",
            "https://github.com.evil.example.com/x",     // suffix trick
        ] {
            guard let url = URL(string: host) else { continue }
            XCTAssertThrowsError(try JunoUpdateFeed.validateOrigin(url), host)
        }
    }

    // MARK: - Decoding

    func testTheMacRowBecomesACandidate() throws {
        let candidate = try JunoUpdateFeed.macOSCandidate(from: feed())
        XCTAssertEqual(candidate?.version, "0.2.0")
        XCTAssertEqual(candidate?.sizeBytes, 1234)
        XCTAssertNil(candidate?.sha256)
    }

    func testAPublishedDigestLosesItsPrefixAndKeepsItsHex() throws {
        let hex = String(repeating: "ab", count: 32)
        let candidate = try JunoUpdateFeed.macOSCandidate(from: feed(sha256: "sha256:\(hex.uppercased())"))
        XCTAssertEqual(candidate?.sha256, hex)
    }

    /// A digest that is not 64 hex characters is not a digest. Carrying it
    /// forward would give the verifier something to compare that can only fail —
    /// or, worse, something it might be tempted to skip.
    func testAMalformedDigestIsDroppedRatherThanCarried() throws {
        let candidate = try JunoUpdateFeed.macOSCandidate(from: feed(sha256: "sha256:nothex"))
        XCTAssertNil(candidate?.sha256)
    }

    /// The current state of the world: no Apple artifact is published. That is
    /// not an error, and the updater must simply have nothing to offer.
    func testAnUnavailableRowIsNotAnError() throws {
        XCTAssertNil(try JunoUpdateFeed.macOSCandidate(from: feed(url: nil, version: nil, available: false)))
    }

    func testAFeedWithoutAMacRowIsMalformed() {
        let payload = try! JSONSerialization.data(withJSONObject: ["downloads": []])
        XCTAssertThrowsError(try JunoUpdateFeed.macOSCandidate(from: payload))
    }

    func testAFeedFromTheWrongHostIsRefusedAtDecodeTime() {
        XCTAssertThrowsError(
            try JunoUpdateFeed.macOSCandidate(from: feed(url: "https://evil.example.com/Juno.dmg"))
        ) { error in
            XCTAssertEqual(error as? JunoUpdateFeed.FeedError, .untrustedOrigin("evil.example.com"))
        }
    }

    func testManualRefreshURLCarriesFreshnessAndChannelWithoutDroppingTheAPIPath() {
        let url = JunoUpdateFeed.url(cacheBust: "test-token", channel: "next")
        XCTAssertEqual(url.path, "/api/downloads")
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first(where: { $0.name == "refresh" })?.value, "test-token")
        XCTAssertEqual(query.first(where: { $0.name == "channel" })?.value, "next")
    }
}
