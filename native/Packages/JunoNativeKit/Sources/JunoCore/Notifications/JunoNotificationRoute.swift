import Foundation

/// Where a notification opens, as something an app can navigate to.
///
/// The server stores and pushes one relative path per notification
/// (`src/lib/notify/paths.ts`): `/agents/<id>`, `/chat/<id>`, `/work/<id>`
/// or `/research/<id>` (a research run's "your report is ready").
/// A push also carries the ids it was built from as flat string keys beside
/// `aps` (`agentId`, `conversationId`, `sessionId`), so a payload whose path
/// this build cannot read still lands somewhere sensible.
///
/// Parsing is strict on purpose. A payload is data another process handed the
/// app, and whatever comes out of here selects a screen and names a record to
/// load, so only the three shapes the server writes are accepted, and every
/// identifier is checked the way `NativeAgentsClient` checks the ids it puts
/// in a URL path.
///
/// `research` names a run, not where it lives: the app reads the run to find
/// its conversation and opens the report. A build without it fell back to the
/// push's `conversationId`, which the server still sends beside the path. Nothing here decides anything: a route opens a screen, and
/// what happens on that screen is still the person's choice.
public enum JunoNotificationRoute: Equatable, Sendable {
    case agent(id: String)
    case conversation(id: String)
    case workSession(id: String)
    /// A research run (`/research/<id>`): open its report.
    case research(id: String)

    /// The longest identifier accepted, matching the native clients' own limit.
    public static let maximumIdentifierLength = 200

    /// `safeAppPath`'s ceiling on the server.
    private static let maximumPathLength = 512

    /// Reads a stored or pushed path. The query and fragment carry nothing a
    /// route needs and are ignored; anything that is not exactly one of the
    /// four shapes is nil.
    public init?(path: String) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= Self.maximumPathLength,
            trimmed.hasPrefix("/"),
            !trimmed.hasPrefix("//"),
            !trimmed.contains("\\")
        else { return nil }

        let end = trimmed.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? trimmed.endIndex
        let segments = trimmed[trimmed.startIndex..<end].split(
            separator: "/",
            omittingEmptySubsequences: false
        )
        // "/agents/abc" splits into ["", "agents", "abc"].
        guard segments.count == 3, segments[0].isEmpty else { return nil }
        let identifier = String(segments[2])
        guard Self.isValidIdentifier(identifier) else { return nil }

        switch String(segments[1]) {
        case "agents": self = .agent(id: identifier)
        case "chat": self = .conversation(id: identifier)
        case "work": self = .workSession(id: identifier)
        case "research": self = .research(id: identifier)
        default: return nil
        }
    }

    /// Reads a push's custom keys, already narrowed to strings by the caller —
    /// `userInfo` itself is not `Sendable` and should not leave the delegate
    /// callback that received it.
    ///
    /// `path` wins when it parses. Otherwise the most specific id present does,
    /// in the order the server fills them: the agent, then its thread, then the
    /// task. A bare `sessionId` is also what the older Code approval push
    /// carries (`buildCodeApprovalPayload` in `src/lib/apns.ts`), where it names
    /// a Code session, so it counts as a Work task only when the payload says
    /// it came from Work or an agent.
    public init?(userInfo: [String: String]) {
        if let path = userInfo["path"], let route = Self(path: path) {
            self = route
            return
        }
        if let id = userInfo["agentId"], Self.isValidIdentifier(id) {
            self = .agent(id: id)
            return
        }
        if let id = userInfo["conversationId"], Self.isValidIdentifier(id) {
            self = .conversation(id: id)
            return
        }
        let kind = userInfo["kind"]
        if kind == "work" || kind == "agent",
            let id = userInfo["sessionId"], Self.isValidIdentifier(id)
        {
            self = .workSession(id: id)
            return
        }
        return nil
    }

    /// The path the server would write for this route.
    public var path: String {
        switch self {
        case .agent(let id): "/agents/\(id)"
        case .conversation(let id): "/chat/\(id)"
        case .workSession(let id): "/work/\(id)"
        case .research(let id): "/research/\(id)"
        }
    }

    /// An id that is safe to place in a URL path segment: no separators, no
    /// traversal, no escapes, no whitespace, and bounded.
    public static func isValidIdentifier(_ identifier: String) -> Bool {
        guard !identifier.isEmpty, identifier.count <= maximumIdentifierLength else { return false }
        guard !identifier.contains("/"), !identifier.contains("\\"),
            !identifier.contains(".."), !identifier.contains("%"),
            !identifier.contains("?"), !identifier.contains("#")
        else { return false }
        return !identifier.unicodeScalars.contains { scalar in
            CharacterSet.whitespacesAndNewlines.contains(scalar)
                || CharacterSet.controlCharacters.contains(scalar)
        }
    }
}
