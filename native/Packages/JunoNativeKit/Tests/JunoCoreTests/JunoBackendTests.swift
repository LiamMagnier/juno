import Foundation
import Testing

@testable import JunoCore

@Suite struct JunoBackendTests {
    /// `productionURL` force-unwraps, so a malformed literal would trap at
    /// launch. This is the check that keeps that from ever shipping.
    @Test func productionURLParses() {
        #expect(JunoBackend.productionURL.absoluteString == "https://chat.liams.dev")
        #expect(JunoBackend.productionURL.scheme == "https")
        #expect(JunoBackend.productionURL.host() == "chat.liams.dev")
    }

    /// The specific corruption that an xcconfig round-trip produced twice:
    /// `//` stripped as a comment, leaving `https:chat.liams.dev`, which parses
    /// as a URL but has no host and silently talks to nothing.
    @Test func productionURLKeepsItsAuthoritySlashes() {
        #expect(JunoBackend.productionURLString.contains("://"))
        #expect(JunoBackend.productionURL.host() != nil)
    }

    /// Diagnostics must report the URL the transport dials, not a copy.
    @Test func buildInfoReportsTheSameBackend() {
        let info = JunoBuildInfo(
            version: "0.1.1", build: "2", gitSHA: "abc123",
            contractVersion: "1.3.0", channel: "stable"
        )
        #expect(info.apiBaseURL == JunoBackend.productionURLString)
        #expect(info.displayVersion == "0.1.1 (2)")
        #expect(info.hasResolvedCommit)
    }

    /// An unsubstituted `$(FOO)` must never reach the screen as if it were a
    /// real value — that is how a broken build looks *configured* rather than
    /// broken.
    @Test func unsubstitutedPlaceholdersDegradeToFallbacks() {
        let bundle = Bundle(for: JunoBundleMarker.self)
        let info = JunoBuildInfo.read(from: bundle)
        #expect(!info.gitSHA.hasPrefix("$("))
        #expect(!info.contractVersion.hasPrefix("$("))
        #expect(info.gitSHA == "unknown")
        #expect(!info.hasResolvedCommit)
    }
}

private final class JunoBundleMarker {}
