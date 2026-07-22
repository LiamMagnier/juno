import Foundation

/// The build's own identity, read from its bundle.
///
/// This exists so a build can be identified *from the device it is installed
/// on*. Two consecutive releases both reporting "0.1.0 (1)" are
/// indistinguishable once installed, which is exactly the position the previous
/// investigation got stuck in: there was no way to tell whether the corrected
/// build had ever reached the phone.
///
/// The values come from `Info.plist`, stamped there by the xcconfig chain — see
/// `native/Config/Base.xcconfig` and `native/Scripts/write-build-metadata.sh`.
/// Nothing here is secret: it is a version, a commit and a public base URL.
public struct JunoBuildInfo: Equatable, Sendable {
    /// `CFBundleShortVersionString`, e.g. `0.1.1`.
    public let version: String
    /// `CFBundleVersion`, e.g. `2`.
    public let build: String
    /// Short commit the build was made from, or `unknown` in a plain checkout.
    /// A `-dirty` suffix means the tree had uncommitted changes at build time,
    /// which is worth seeing rather than hiding.
    public let gitSHA: String
    /// The native contract this build was compiled against.
    public let contractVersion: String
    /// `debug`, `next` or `stable`.
    public let channel: String

    public init(
        version: String,
        build: String,
        gitSHA: String,
        contractVersion: String,
        channel: String
    ) {
        self.version = version
        self.build = build
        self.gitSHA = gitSHA
        self.contractVersion = contractVersion
        self.channel = channel
    }

    /// `0.1.1 (2)` — the form used in the Diagnostics header.
    public var displayVersion: String { "\(version) (\(build))" }

    /// Whether this build reports a real commit. A build that cannot say which
    /// commit it came from cannot be compared against the deployed server, so
    /// Diagnostics says so plainly rather than showing a blank.
    public var hasResolvedCommit: Bool {
        gitSHA != "unknown" && !gitSHA.isEmpty
    }

    public static func read(from bundle: Bundle) -> JunoBuildInfo {
        func string(_ key: String, default fallback: String) -> String {
            let value = bundle.object(forInfoDictionaryKey: key) as? String
            // An unsubstituted `$(FOO)` means the xcconfig variable never
            // reached the plist. Treating that as a real value would print
            // literal build syntax on screen, so it degrades to the fallback.
            guard let value, !value.isEmpty, !value.hasPrefix("$(") else {
                return fallback
            }
            return value
        }
        return JunoBuildInfo(
            version: string("CFBundleShortVersionString", default: "0.0.0"),
            build: string("CFBundleVersion", default: "0"),
            gitSHA: string("JunoGitSHA", default: "unknown"),
            contractVersion: string("JunoContractVersion", default: "unknown"),
            channel: string("JunoChannel", default: "unknown")
        )
    }

    /// The backend this build talks to — the same constant the transport
    /// dials, not a second copy that could disagree with it.
    public var apiBaseURL: String { JunoBackend.productionURLString }

    public static let current = JunoBuildInfo.read(from: .main)
}
