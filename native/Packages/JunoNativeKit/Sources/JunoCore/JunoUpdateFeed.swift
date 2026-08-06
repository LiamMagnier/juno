import Foundation

/// What the Mac app is allowed to believe about a newer build, and how it
/// decides one is newer.
///
/// This is the pure half of the updater: decoding the feed and ordering two
/// versions. It lives in `JunoCore` so it can be tested without a network, a
/// disk or a Mac — the half that mounts disk images and replaces application
/// bundles is in `DesktopUpdater.swift`, where it can be read as the dangerous
/// thing it is.
///
/// **What this cannot check, and says so.** `docs/native/RELEASE.md` requires a
/// client to validate *signature, version/build ordering, checksum, size, HTTPS
/// origin and signing Team ID* before offering an update. Five of those six are
/// enforced — ordering and origin here, checksum and size here when the feed
/// publishes them, Team ID and Developer ID signature at install time, which is
/// the strongest gate of the set. The sixth, a signed monotonic update manifest,
/// does not exist yet: `/api/downloads` reports GitHub's latest release, and
/// GitHub's release list is not a signed feed. So this type never claims a
/// manifest was verified, and the installer refuses any bundle whose code
/// signature is not Juno's own — which is what actually stops a substituted
/// download, manifest or no manifest.
public enum JunoUpdateFeed {

    /// Where the feed lives. The same route the website's download menu reads,
    /// which is deliberate: two endpoints reporting "the current Mac build"
    /// would eventually disagree, and the one the app trusted would be the one
    /// nobody looked at.
    public static var url: URL {
        url(cacheBust: nil, channel: nil)
    }

    /// The manual menu action supplies a unique value so a CDN cannot replay
    /// the previous ten-minute `/api/downloads` response. The channel is
    /// explicit too: stable installs consume stable releases, while a `next`
    /// build may see the prerelease stream intended for it.
    public static func url(cacheBust: String?, channel: String?) -> URL {
        var components = URLComponents(
            url: JunoBackend.productionURL.appending(path: "api/downloads"),
            resolvingAgainstBaseURL: false
        )!
        var query: [URLQueryItem] = []
        if let cacheBust { query.append(URLQueryItem(name: "refresh", value: cacheBust)) }
        if let channel { query.append(URLQueryItem(name: "channel", value: channel)) }
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    /// A build the feed is offering. Every field here came off the wire; nothing
    /// is defaulted, because a size or checksum this client invented would be a
    /// check that always passes.
    public struct Candidate: Equatable, Sendable {
        public let version: String
        public let downloadURL: URL
        /// Bytes, when the release published a size.
        public let sizeBytes: Int?
        /// Lowercase hex SHA-256, when the release published a digest.
        public let sha256: String?

        public init(version: String, downloadURL: URL, sizeBytes: Int?, sha256: String?) {
            self.version = version
            self.downloadURL = downloadURL
            self.sizeBytes = sizeBytes
            self.sha256 = sha256
        }
    }

    public enum FeedError: Error, Equatable, Sendable {
        case malformed
        /// The macOS row exists but is not offering a file.
        case unavailable
        /// The asset is not served over HTTPS from GitHub's release hosts.
        case untrustedOrigin(String)
    }

    /// Reads the macOS row out of `/api/downloads`.
    ///
    /// Returns nil when the row reports nothing published — which is the current
    /// state of the world and is not an error.
    public static func macOSCandidate(from data: Data) throws -> Candidate? {
        guard let wire = try? JSONDecoder().decode(FeedWire.self, from: data) else {
            throw FeedError.malformed
        }
        guard let row = wire.downloads.first(where: { $0.platform == "macos" }) else {
            throw FeedError.malformed
        }
        guard row.available, let urlString = row.url, let version = row.version else { return nil }
        guard let url = URL(string: urlString) else { throw FeedError.malformed }
        try validateOrigin(url)
        return Candidate(
            version: version,
            downloadURL: url,
            sizeBytes: row.size,
            // GitHub publishes `sha256:…`; the prefix is dropped so callers
            // compare hex to hex.
            sha256: row.sha256.flatMap(normalizedDigest)
        )
    }

    /// HTTPS, and a GitHub release host.
    ///
    /// Narrow on purpose. The feed is a JSON document served by Juno's own
    /// backend, so a compromised or mistaken backend could otherwise point the
    /// updater at any URL on the internet, and the app would fetch and mount it.
    /// The signature check downstream would still refuse to install it, but not
    /// downloading it at all is better.
    public static func validateOrigin(_ url: URL) throws {
        guard url.scheme?.lowercased() == "https", let host = url.host()?.lowercased() else {
            throw FeedError.untrustedOrigin(url.absoluteString)
        }
        let allowed = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]
        guard allowed.contains(where: { host == $0 || host.hasSuffix(".\($0)") }) else {
            throw FeedError.untrustedOrigin(host)
        }
    }

    /// Strictly newer, by semantic version.
    ///
    /// Strict is the point: equal versions must not update (that is a reinstall
    /// loop) and lower versions must not update (that is a downgrade attack).
    /// A prerelease sorts BELOW its release, per semver — `1.2.0-beta.1` is not
    /// an update over `1.2.0`.
    public static func isNewer(_ candidate: String, than installed: String) -> Bool {
        order(candidate, installed) == .orderedDescending
    }

    static func order(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = SemanticVersion(lhs)
        let right = SemanticVersion(rhs)
        return left.compare(to: right)
    }

    private static func normalizedDigest(_ raw: String) -> String? {
        let value = raw.lowercased()
        let hex = value.hasPrefix("sha256:") ? String(value.dropFirst("sha256:".count)) : value
        guard hex.count == 64, hex.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        return hex
    }

    /// The subset of semver this project actually publishes: `MAJOR.MINOR.PATCH`
    /// with an optional `-prerelease`. Build metadata (`+sha`) is ignored, as
    /// semver says it must be.
    struct SemanticVersion {
        let numbers: [Int]
        let prerelease: String?

        init(_ raw: String) {
            var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.hasPrefix("v") || text.hasPrefix("V") { text = String(text.dropFirst()) }
            if let plus = text.firstIndex(of: "+") { text = String(text[..<plus]) }
            if let dash = text.firstIndex(of: "-") {
                prerelease = String(text[text.index(after: dash)...])
                text = String(text[..<dash])
            } else {
                prerelease = nil
            }
            numbers = text.split(separator: ".").map { Int($0) ?? 0 }
        }

        func compare(to other: SemanticVersion) -> ComparisonResult {
            for index in 0..<max(numbers.count, other.numbers.count) {
                let mine = index < numbers.count ? numbers[index] : 0
                let theirs = index < other.numbers.count ? other.numbers[index] : 0
                if mine != theirs { return mine < theirs ? .orderedAscending : .orderedDescending }
            }
            switch (prerelease, other.prerelease) {
            case (nil, nil): return .orderedSame
            case (nil, _): return .orderedDescending
            case (_, nil): return .orderedAscending
            case (let mine?, let theirs?):
                if mine == theirs { return .orderedSame }
                return mine < theirs ? .orderedAscending : .orderedDescending
            }
        }
    }

    private struct FeedWire: Decodable {
        struct Row: Decodable {
            let platform: String
            let url: String?
            let version: String?
            let size: Int?
            let available: Bool
            let sha256: String?
        }
        let downloads: [Row]
    }
}
