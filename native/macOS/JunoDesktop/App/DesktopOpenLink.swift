import AppKit
import Foundation
import JunoCore

/// "Open in Mac app" from the website: `com.liammagnier.juno://open`, with an
/// optional `?path=/chat/<id>` or `?path=/code/<id>` naming where to land.
///
/// The scheme is the one the app registers for its sign-in callback
/// (`JUNO_AUTH_CALLBACK_SCHEME`, native/Config/Base.xcconfig). The two never
/// meet: sign-in's `com.liammagnier.juno://auth/callback` is caught inside
/// `ASWebAuthenticationSession` and never reaches the app delegate, and this
/// parser accepts the `open` host and nothing else, so a callback (or any
/// other host) is ignored outright rather than read as a request to open.
///
/// The URL is data another process handed the app. Only two in-app routes are
/// honoured, each with an identifier checked the way a notification's route
/// is (``JunoNotificationRoute/isValidIdentifier(_:)``) and narrowed further
/// to the characters the server's ids use. Any other path, a malformed one,
/// or extra parts (a user, a port, a path on the URL itself) still only
/// brings the app forward: the person asked for the app, so the app comes up,
/// and nothing they did not ask for happens.
enum DesktopOpenLink: Equatable {
    /// Bring the app forward on its main window.
    case bringForward
    /// A chat: `/chat/<id>`.
    case conversation(id: String)
    /// A web Code session: `/code/<id>`. The web's Code sessions are not this
    /// Mac's local ones, so it lands in Code (as a Recents row does in the
    /// search panel, ``DesktopSearchPanelModel``).
    case code(id: String)

    /// The scheme the app registers (Info.plist `CFBundleURLSchemes`).
    static let scheme = "com.liammagnier.juno"
    /// The only host this parser answers.
    static let host = "open"
    /// The query item naming the in-app route.
    static let pathItem = "path"
    /// Longer than any link the website builds; anything past it is not ours.
    static let maximumLength = 1024

    /// Reads a URL the system handed the app. Nil means "not an open link":
    /// the caller ignores it entirely (no activation).
    init?(url: URL, scheme: String = DesktopOpenLink.scheme) {
        guard url.scheme?.lowercased() == scheme.lowercased(),
            url.host(percentEncoded: false)?.lowercased() == Self.host
        else { return nil }

        guard url.absoluteString.utf8.count <= Self.maximumLength,
            url.user == nil, url.password == nil, url.port == nil,
            url.path(percentEncoded: false).isEmpty || url.path(percentEncoded: false) == "/",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            self = .bringForward
            return
        }
        let paths = (components.queryItems ?? []).filter { $0.name == Self.pathItem }
        guard paths.count == 1, let path = paths[0].value else {
            self = .bringForward
            return
        }
        self = Self.route(path: path) ?? .bringForward
    }

    /// `/chat/<id>` or `/code/<id>`, exactly; nil for anything else.
    static func route(path: String) -> DesktopOpenLink? {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        // "/chat/abc" splits into ["", "chat", "abc"].
        guard path.hasPrefix("/"), segments.count == 3, segments[0].isEmpty else { return nil }
        let id = String(segments[2])
        guard isAllowedIdentifier(id) else { return nil }
        switch segments[1] {
        case "chat": return .conversation(id: id)
        case "code": return .code(id: id)
        default: return nil
        }
    }

    /// The notification route's identifier rules, narrowed to the characters a
    /// server id (a cuid, a UUID) is made of.
    static func isAllowedIdentifier(_ id: String) -> Bool {
        guard JunoNotificationRoute.isValidIdentifier(id), id.count <= 128 else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_")
        }
    }

    /// Acts on the link: activate, bring the main window forward (opening one
    /// when there is none) and land where it points.
    @MainActor
    func perform() {
        switch self {
        case .bringForward:
            JunoDesktopWindow.presentMainWindow()
        case .conversation(let id):
            JunoDesktopWindow.follow(.conversation(id: id))
        case .code:
            DesktopWorkbenchRegistry.shared.request(.showCode)
            JunoDesktopWindow.presentMainWindow()
        }
    }
}
