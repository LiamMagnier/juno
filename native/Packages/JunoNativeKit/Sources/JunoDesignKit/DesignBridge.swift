import Foundation

/// The Swift ↔ JavaScript contract for the hosted design editor.
///
/// The editor is trusted Juno code, bundled in the app and loaded from disk —
/// but "trusted" is not "unvalidated". Every message that crosses this boundary
/// is parsed into one of the cases below before anything acts on it, for three
/// reasons that all have teeth:
///
///  1. The editor renders **user** content. A malformed or hostile document can
///     make trusted code emit a message nobody wrote by hand.
///  2. The web view is a separate process. A validated envelope is the only
///     thing that makes its output safe to route into file writes and network
///     calls on this side.
///  3. Session nonce and document revision travel on every message, so a stale
///     frame — one from a document that has since been closed or moved on —
///     cannot commit an edit against the wrong scene.
///
/// What deliberately does NOT exist: no message can read a file, run a command,
/// reach the network, or ask for an auth token. Native credentials never enter
/// JavaScript; the host fetches on the editor's behalf and hands back only the
/// document.
public enum DesignBridge {
    /// Bumped when the message set changes incompatibly. The host refuses a
    /// bundle that announces a version it does not implement, rather than
    /// half-speaking to it.
    public static let protocolVersion = 1

    /// The single `WKScriptMessageHandler` name the editor posts to.
    public static let messageHandlerName = "junoDesign"
}

// MARK: - Editor → host

public enum DesignBridgeMessage: Equatable, Sendable {
    /// The editor bundle has booted and is announcing what it speaks.
    case ready(protocolVersion: Int, editorVersion: String)
    /// A committed transaction, already applied to the editor's own copy.
    case transaction(nonce: String, baseRevision: Int, revision: Int, transactionID: String, summary: String, document: DesignDocument)
    /// Selection changed — drives the native inspector chrome and "Ask Juno".
    case selection(nonce: String, revision: Int, nodeIDs: [String])
    /// The editor wants the host to persist right now (⌘S, or a debounce).
    case save(nonce: String, revision: Int)
    /// Something went wrong inside the editor. Surfaced, never swallowed.
    case failure(nonce: String?, message: String)
}

public enum DesignBridgeError: Error, Equatable, CustomStringConvertible {
    case notAnObject
    case unknownType(String)
    case missingField(String)
    case badField(String)
    case nonceMismatch
    case staleRevision(expected: Int, received: Int)
    case unsupportedProtocol(Int)

    public var description: String {
        switch self {
        case .notAnObject: "The editor sent a message that is not an object."
        case .unknownType(let type): "The editor sent an unknown message type “\(type)”."
        case .missingField(let field): "The editor's message is missing “\(field)”."
        case .badField(let field): "The editor's message has an invalid “\(field)”."
        case .nonceMismatch: "The editor's message belongs to a different editing session."
        case .staleRevision(let expected, let received):
            "The editor's message is for revision \(received); this document is at \(expected)."
        case .unsupportedProtocol(let version):
            "The bundled editor speaks design protocol v\(version); this build implements v\(DesignBridge.protocolVersion)."
        }
    }
}

/// Parses and checks messages arriving from the editor.
///
/// Stateful on purpose: it holds the session nonce and the revision the host
/// believes the document is at, because those are exactly the two facts that
/// make a replayed or stale message detectable.
public struct DesignBridgeValidator: Sendable {
    /// Minted per opened document. A message carrying any other nonce is from a
    /// document this validator is not responsible for.
    public let nonce: String
    /// The revision the host last accepted.
    public private(set) var revision: Int

    public init(nonce: String, revision: Int) {
        self.nonce = nonce
        self.revision = revision
    }

    /// Validate one raw message body (the dictionary WebKit hands over).
    ///
    /// `mutating` because accepting a transaction advances the revision — which
    /// is what makes a duplicate delivery of the same transaction fail the next
    /// time it arrives instead of applying twice.
    public mutating func validate(_ raw: Any) throws -> DesignBridgeMessage {
        guard let body = raw as? [String: Any] else { throw DesignBridgeError.notAnObject }
        guard let type = body["type"] as? String else { throw DesignBridgeError.missingField("type") }

        switch type {
        case "ready":
            guard let version = body["protocolVersion"] as? Int else { throw DesignBridgeError.missingField("protocolVersion") }
            guard version == DesignBridge.protocolVersion else { throw DesignBridgeError.unsupportedProtocol(version) }
            let editorVersion = body["editorVersion"] as? String ?? "unknown"
            return .ready(protocolVersion: version, editorVersion: editorVersion)

        case "transaction":
            let nonce = try requireNonce(body)
            guard let baseRevision = body["baseRevision"] as? Int else { throw DesignBridgeError.missingField("baseRevision") }
            guard baseRevision == revision else {
                throw DesignBridgeError.staleRevision(expected: revision, received: baseRevision)
            }
            guard let nextRevision = body["revision"] as? Int, nextRevision > baseRevision else {
                throw DesignBridgeError.badField("revision")
            }
            guard let transactionID = body["transactionId"] as? String, !transactionID.isEmpty else {
                throw DesignBridgeError.missingField("transactionId")
            }
            guard let documentBody = body["document"] else { throw DesignBridgeError.missingField("document") }
            let data: Data
            if let string = documentBody as? String {
                data = Data(string.utf8)
            } else if JSONSerialization.isValidJSONObject(documentBody) {
                data = try JSONSerialization.data(withJSONObject: documentBody)
            } else {
                throw DesignBridgeError.badField("document")
            }
            let document: DesignDocument
            do {
                document = try DesignDocumentCodec.load(data)
            } catch {
                throw DesignBridgeError.badField("document")
            }
            guard document.revision == nextRevision else { throw DesignBridgeError.badField("revision") }
            revision = nextRevision
            return .transaction(
                nonce: nonce,
                baseRevision: baseRevision,
                revision: nextRevision,
                transactionID: transactionID,
                summary: (body["summary"] as? String) ?? "Edit",
                document: document
            )

        case "selection":
            let nonce = try requireNonce(body)
            guard let messageRevision = body["revision"] as? Int else { throw DesignBridgeError.missingField("revision") }
            guard let ids = body["nodeIds"] as? [String] else { throw DesignBridgeError.badField("nodeIds") }
            // Selection is advisory chrome, so a revision from the immediate
            // past is tolerated (it races a just-committed transaction); a
            // revision from the FUTURE is not, and means a desynced editor.
            guard messageRevision <= revision else {
                throw DesignBridgeError.staleRevision(expected: revision, received: messageRevision)
            }
            return .selection(nonce: nonce, revision: messageRevision, nodeIDs: ids)

        case "save":
            let nonce = try requireNonce(body)
            guard let messageRevision = body["revision"] as? Int else { throw DesignBridgeError.missingField("revision") }
            return .save(nonce: nonce, revision: messageRevision)

        case "failure":
            guard let message = body["message"] as? String else { throw DesignBridgeError.missingField("message") }
            return .failure(nonce: body["nonce"] as? String, message: String(message.prefix(2_000)))

        default:
            throw DesignBridgeError.unknownType(type)
        }
    }

    private func requireNonce(_ body: [String: Any]) throws -> String {
        guard let value = body["nonce"] as? String else { throw DesignBridgeError.missingField("nonce") }
        guard value == nonce else { throw DesignBridgeError.nonceMismatch }
        return value
    }
}

// MARK: - Host → editor

/// A command the host sends into the editor.
///
/// Serialized to JSON and evaluated as `window.__junoDesignHost.receive(<json>)`
/// — a single entry point rather than arbitrary script, so the host cannot
/// accidentally acquire the ability to run whatever it likes inside the editor.
public enum DesignHostCommand: Sendable {
    case openDocument(nonce: String, document: DesignDocument, readOnly: Bool)
    case setSelection(nonce: String, nodeIDs: [String])
    case setReadOnly(nonce: String, readOnly: Bool)
    /// A transaction the host applied elsewhere (a sync, or an accepted AI
    /// change) that the editor must adopt.
    case adoptDocument(nonce: String, document: DesignDocument)

    public func javaScript() throws -> String {
        let payload: [String: Any]
        switch self {
        case .openDocument(let nonce, let document, let readOnly):
            payload = [
                "type": "openDocument",
                "nonce": nonce,
                "readOnly": readOnly,
                "document": try jsonObject(document),
            ]
        case .setSelection(let nonce, let nodeIDs):
            payload = ["type": "setSelection", "nonce": nonce, "nodeIds": nodeIDs]
        case .setReadOnly(let nonce, let readOnly):
            payload = ["type": "setReadOnly", "nonce": nonce, "readOnly": readOnly]
        case .adoptDocument(let nonce, let document):
            payload = ["type": "adoptDocument", "nonce": nonce, "document": try jsonObject(document)]
        }
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
        let json = String(decoding: data, as: UTF8.self)
        // The payload is embedded as a JS string literal and parsed inside the
        // page, rather than interpolated as source. A document containing "</script>"
        // or a stray quote is then data, not syntax.
        let quoted = quoteForJavaScript(json)
        return "window.__junoDesignHost && window.__junoDesignHost.receive(JSON.parse(\(quoted)));"
    }

    private func jsonObject(_ document: DesignDocument) throws -> Any {
        let data = try DesignDocumentCodec.encode(document)
        return try JSONSerialization.jsonObject(with: data)
    }
}

/// Escape a string for embedding in JavaScript source as a single-quoted literal.
///
/// Three classes of character matter here, and all three occur in real design
/// documents because a text layer can contain anything a user types:
///
///  - Quote and backslash, which would end or corrupt the literal.
///  - U+2028 and U+2029, which are legal inside a JSON string but terminate a
///    JavaScript *line*, so an unescaped one truncates the statement.
///  - `<`, escaped as `\x3c`. `evaluateJavaScript` does not parse HTML, so this
///    is not required there — but the same quoting is the natural thing to reach
///    for when a script is ever placed inside a `<script>` element, and a layer
///    named `</script>` closing that element is exactly the bug that would be
///    found in production rather than here. `JSON.parse` still sees a plain `<`.
func quoteForJavaScript(_ value: String) -> String {
    var out = "'"
    for scalar in value.unicodeScalars {
        switch scalar {
        case "'": out += "\\'"
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "<": out += "\\x3c"
        case "\u{2028}": out += "\\u2028"
        case "\u{2029}": out += "\\u2029"
        default: out.unicodeScalars.append(scalar)
        }
    }
    return out + "'"
}
