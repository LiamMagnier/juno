import Foundation

/// The open Chat or Code thread, as Apple Handoff carries it between the Mac
/// and the iPhone (docs/code-v2/REMOTE-CONTROL.md §Hand-off).
///
/// Both apps advertise it with an `NSUserActivity` of ``activityType`` while a
/// thread is on screen, and continue one by opening the same thread. The
/// activity's `webpageURL` is the web fallback: a device without the app (or a
/// browser on the Mac) opens the thread on alevr.com instead.
///
/// The payload is ids only: never the draft, never the transcript. Handoff
/// rides the user's own iCloud devices, but nothing private needs to.
public struct JunoHandoff: Equatable, Sendable, Hashable {
    /// Declared under `NSUserActivityTypes` in both apps' Info.plist.
    public static let activityType = "com.liammagnier.juno.thread"

    public enum Kind: String, Sendable, Codable, Hashable {
        case chat
        case code
    }

    /// Where "Continue on…" sends the thread.
    public enum Target: String, Sendable, Codable, CaseIterable, Hashable {
        case ios
        case macos
        case web
    }

    public var kind: Kind
    /// chat: the conversation id. code: the session id on the Mac.
    public var id: String
    /// code: the Mac (CodeDevice id) the session runs on.
    public var deviceID: String?
    public var title: String?
    /// code: the web conversation that mirrors the session, when there is one.
    public var conversationID: String?

    public init(kind: Kind, id: String, deviceID: String? = nil, title: String? = nil, conversationID: String? = nil) {
        self.kind = kind
        self.id = id
        self.deviceID = deviceID
        self.title = title
        self.conversationID = conversationID
    }

    public static func chat(_ conversationID: String, title: String? = nil) -> JunoHandoff {
        JunoHandoff(kind: .chat, id: conversationID, title: title)
    }

    public static func code(deviceID: String, sessionID: String, title: String? = nil, conversationID: String? = nil) -> JunoHandoff {
        JunoHandoff(kind: .code, id: sessionID, deviceID: deviceID, title: title, conversationID: conversationID)
    }

    /// `NSUserActivity.userInfo`: string values only, so it survives the
    /// round trip through Handoff's property-list encoding.
    public var userInfo: [String: String] {
        var info = ["v": "1", "kind": kind.rawValue, "id": id]
        if let deviceID { info["deviceID"] = deviceID }
        if let title, !title.isEmpty { info["title"] = String(title.prefix(200)) }
        if let conversationID { info["conversationID"] = conversationID }
        return info
    }

    /// Reads an activity's `userInfo` back; nil for anything that is not a
    /// well-formed thread (an id that could not have come from Alevr included).
    public init?(userInfo: [AnyHashable: Any]?) {
        guard let info = userInfo,
            let kindRaw = info["kind"] as? String, let kind = Kind(rawValue: kindRaw),
            let id = info["id"] as? String, Self.isSafeID(id)
        else { return nil }
        let deviceID = info["deviceID"] as? String
        if kind == .code {
            guard let deviceID, Self.isSafeID(deviceID) else { return nil }
        }
        let conversationID = (info["conversationID"] as? String).flatMap { Self.isSafeID($0) ? $0 : nil }
        self.init(kind: kind, id: id, deviceID: kind == .code ? deviceID : nil, title: info["title"] as? String, conversationID: conversationID)
    }

    /// The web fallback: the chat itself, or the Code thread's web conversation
    /// (Code's landing when the session has none).
    public func webURL(base: URL) -> URL {
        switch kind {
        case .chat:
            return base.appending(path: "chat").appending(path: id)
        case .code:
            if let conversationID { return base.appending(path: "code").appending(path: conversationID) }
            return base.appending(path: "code")
        }
    }

    /// Thread ids are cuids, uuids or env-server ids: letters, digits, `-`, `_`, `.`, `:`.
    static func isSafeID(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 200 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)) || "-_.:".unicodeScalars.contains(scalar)
        }
    }
}
