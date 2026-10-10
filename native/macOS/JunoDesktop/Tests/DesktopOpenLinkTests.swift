import Foundation
import Testing
@testable import JunoDesktop

/// "Open in Mac app" from the website (``DesktopOpenLink``): what a
/// `com.liammagnier.juno://open` URL is read as. Pure parsing: nothing opens.
struct DesktopOpenLinkTests {
    private func link(_ string: String) -> DesktopOpenLink? {
        guard let url = URL(string: string) else { return nil }
        return DesktopOpenLink(url: url)
    }

    @Test
    func aBareOpenBringsTheAppForward() {
        #expect(link("com.liammagnier.juno://open") == .bringForward)
        #expect(link("com.liammagnier.juno://open/") == .bringForward)
        #expect(link("COM.LIAMMAGNIER.JUNO://OPEN") == .bringForward)
    }

    @Test
    func aChatPathOpensThatConversation() {
        #expect(link("com.liammagnier.juno://open?path=/chat/cm1abc23def") == .conversation(id: "cm1abc23def"))
        #expect(link("com.liammagnier.juno://open?path=%2Fchat%2Fcm1abc23def") == .conversation(id: "cm1abc23def"))
    }

    @Test
    func aCodePathLandsInCode() {
        #expect(link("com.liammagnier.juno://open?path=/code/3f2a-11_b") == .code(id: "3f2a-11_b"))
    }

    @Test
    func theSignInCallbackIsNeverAnOpenLink() {
        #expect(link("com.liammagnier.juno://auth/callback?code=abc&state=s&nonce=n") == nil)
        #expect(link("com.liammagnier.juno://auth?path=/chat/abc") == nil)
        #expect(link("com.liammagnier.juno://opener") == nil)
        #expect(link("com.liammagnier.juno:open") == nil)
    }

    @Test
    func otherSchemesAndFilesAreIgnored() {
        #expect(link("https://open/?path=/chat/abc") == nil)
        #expect(link("alevr://open?path=/chat/abc") == nil)
        #expect(DesktopOpenLink(url: URL(fileURLWithPath: "/tmp/open")) == nil)
    }

    @Test(arguments: [
        "com.liammagnier.juno://open?path=/settings",
        "com.liammagnier.juno://open?path=/chat",
        "com.liammagnier.juno://open?path=/chat/",
        "com.liammagnier.juno://open?path=/chat/abc/edit",
        "com.liammagnier.juno://open?path=//evil.example/chat/abc",
        "com.liammagnier.juno://open?path=https://evil.example/chat/abc",
        "com.liammagnier.juno://open?path=/chat/..",
        "com.liammagnier.juno://open?path=/chat/a%2Fb",
        "com.liammagnier.juno://open?path=/chat/a%20b",
        "com.liammagnier.juno://open?path=/chat/a%00b",
        "com.liammagnier.juno://open?path=/chat/%C3%A9t%C3%A9",
        "com.liammagnier.juno://open?path=/agents/abc",
        "com.liammagnier.juno://open?path=chat/abc",
        "com.liammagnier.juno://open?path=/chat/abc&path=/code/def",
        "com.liammagnier.juno://open/chat/abc",
        "com.liammagnier.juno://user@open?path=/chat/abc",
        "com.liammagnier.juno://open:8080?path=/chat/abc",
    ])
    func anythingOutsideTheAllowListOnlyBringsTheAppForward(_ string: String) {
        #expect(link(string) == .bringForward)
    }

    @Test
    func anOverlongLinkOnlyBringsTheAppForward() {
        let id = String(repeating: "a", count: 129)
        #expect(link("com.liammagnier.juno://open?path=/chat/\(id)") == .bringForward)
        let padding = String(repeating: "x", count: 1100)
        #expect(link("com.liammagnier.juno://open?path=/chat/abc&pad=\(padding)") == .bringForward)
    }

    @Test
    func theSchemeMatchesTheOneTheAppRegisters() throws {
        let types = try #require(Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        #expect(schemes.contains(DesktopOpenLink.scheme))
    }
}
