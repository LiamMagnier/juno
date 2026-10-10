import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeRuntime
import JunoCore

/// Turns a relay command into a call on the *existing* Juno Code runtime.
///
/// Deliberately an adapter and not a second agent. A remote path with its own
/// tool loop would drift from the local one the moment either changed, and the
/// two would disagree about the thing that matters most — what is allowed. A
/// command arriving from a phone lands on the same session, the same
/// `PermissionCoordinator` and the same tool registry as one typed on the Mac.
///
/// The type is split in two on purpose. Parsing and authorisation are pure and
/// live here; actually driving a session is behind `CodeRemoteSessionBridging`,
/// so the rules can be tested without a workspace, a model or a network.

// MARK: - Typed commands

/// The command kinds a host will act on.
///
/// A closed enum rather than a string switch: an unrecognised kind must be
/// refused *before* execution, and a `default:` branch that quietly does
/// nothing is how a phone shows a command as sent while the Mac ignores it.
public enum CodeRemoteCommandKind: String, CaseIterable, Sendable {
    case createSession = "create_session"
    case sendMessage = "send_message"
    case steer = "steer"
    case queue = "queue"
    case stopAgent = "stop_agent"
    case retryTurn = "retry"
    case forkSession = "fork"
    case approvalDecision = "approval_decision"
    case applyPatch = "apply_patch"
    case deleteChange = "delete_change"
    case acceptChange = "accept_change"
    case rejectChange = "reject_change"
    case undoChange = "undo_change"
    case runTests = "run_tests"
    case stopTests = "stop_tests"
    case gitAction = "git_action"
    case updateSession = "update_session"
    /// Known so it can be refused by name. Deleting a transcript from another
    /// device is not something this Mac does.
    case deleteSession = "delete_session"
    /// A message from another of the reader's conversations, written by
    /// Alevr's backend after its ownership, hop and rate checks
    /// (src/lib/cross-conversation). Not the reader's prompt: it carries no
    /// mode, cannot answer an approval, and is never shown as theirs.
    case crossMessage = "cross_message"
}

public enum CodeRemoteCommandError: Error, Equatable, LocalizedError, Sendable {
    case unsupportedKind(String)
    case missingField(String)
    case invalidField(String, reason: String)
    case permissionEscalation(requested: String, current: String)
    case workspaceNotGranted(String)
    case hostInactive
    /// The session runs with more access than this Mac lets anything started
    /// from another device have.
    case aboveRemoteCeiling(session: String, ceiling: String)
    /// A command this Mac understands and deliberately does not take from
    /// another device. The message says what to do instead.
    case notAvailableRemotely(String)

    public var errorDescription: String? {
        switch self {
        case let .unsupportedKind(kind):
            "This Mac cannot run a \"\(kind)\" command. Update Juno on the Mac and try again."
        case let .missingField(field):
            "The command is missing \"\(field)\"."
        case let .invalidField(field, reason):
            "The command's \"\(field)\" is not usable: \(reason)"
        case let .permissionEscalation(requested, current):
            "A remote command asked for \(requested) access while this session is \(current). "
                + "Change the permission mode on the Mac itself."
        case .workspaceNotGranted:
            // Deliberately does not echo the identifier back. A refusal that
            // repeats what was asked for confirms which ids exist to anyone
            // probing, and the phone already knows what it sent.
            "That workspace is not shared with Remote on this Mac."
        case .hostInactive:
            "Remote Juno Code is switched off on this Mac."
        case let .aboveRemoteCeiling(session, ceiling):
            "This session runs in \(session), and this Mac allows at most \(ceiling) for work "
                + "sent from another device. Continue it on the Mac, or lower its mode there."
        case let .notAvailableRemotely(message):
            message
        }
    }
}

/// A command that has been parsed, validated and authorised.
public struct ValidatedRemoteCommand: Equatable, Sendable {
    public let id: String
    public let sessionID: String
    public let kind: CodeRemoteCommandKind
    public let payload: [String: JunoJSONValue]

    /// Reads a required string field.
    public func string(_ field: String) throws -> String {
        guard let value = payload[field]?.stringValue, !value.isEmpty else {
            throw CodeRemoteCommandError.missingField(field)
        }
        return value
    }

    public func optionalString(_ field: String) -> String? {
        payload[field]?.stringValue
    }

    /// The first non-empty value among spellings of one field. The phone, the
    /// CLI and older relays each named some fields differently — `workspaceKey`
    /// and `workspaceId`, `prompt` and `initialMessage` — and a command is not
    /// less valid for using the other one.
    public func firstString(_ fields: [String]) -> String? {
        for field in fields {
            if let value = payload[field]?.stringValue, !value.isEmpty { return value }
        }
        return nil
    }

    /// Like `firstString`, but required; the error names the canonical field.
    public func string(oneOf fields: [String]) throws -> String {
        guard let value = firstString(fields) else {
            throw CodeRemoteCommandError.missingField(fields[0])
        }
        return value
    }

    public func firstBool(_ fields: [String]) -> Bool? {
        for field in fields {
            if let value = payload[field]?.boolValue { return value }
        }
        return nil
    }

    public func bool(_ field: String) throws -> Bool {
        guard let value = payload[field]?.boolValue else {
            throw CodeRemoteCommandError.missingField(field)
        }
        return value
    }
}

// MARK: - What the adapter needs from a session

/// The runtime surface a remote command drives.
///
/// Narrow on purpose: it is the list of things Remote may do, so a capability
/// that is not here cannot be reached from a phone even by accident. Adding to
/// it is a deliberate act with a visible diff.
public protocol CodeRemoteSessionBridging: Sendable {
    /// Opaque workspace id → whether this Mac has shared it with Remote.
    func isWorkspaceSharedWithRemote(_ workspaceID: String) async -> Bool

    /// The permission mode a session is currently running under.
    func permissionMode(forSession sessionID: String) async -> PermissionMode?

    func createSession(
        workspaceID: String,
        title: String?,
        permissionMode: PermissionMode
    ) async throws -> String

    /// Returns once the session has taken the message, not once it is sent:
    /// the message's hooks may wait on an approval, and the phone's answer
    /// to it is a later command the host cannot claim until this one is
    /// acknowledged. Throws when the message was not taken.
    func sendMessage(sessionID: String, text: String) async throws
    func stopAgent(sessionID: String) async throws
    func retryTurn(sessionID: String) async throws
    func forkSession(sessionID: String) async throws -> String
    func resolveApproval(sessionID: String, approvalID: String, approved: Bool) async throws
    func applyChange(sessionID: String, changeID: String, accept: Bool) async throws
    func undoChange(sessionID: String, checkpointID: String) async throws
    func deleteChange(sessionID: String, changeID: String) async throws
    func runTests(sessionID: String, command: String?) async throws
    func stopTests(sessionID: String) async throws
    func performGitAction(sessionID: String, action: String, message: String?) async throws
}

/// Optional capability for clients that can select a model and reasoning level
/// at session creation. Keeping it separate preserves older hosts while making
/// the choice host-validated rather than a CLI-only hint.
public protocol CodeRemoteSessionConfigurationBridging: CodeRemoteSessionBridging {
    func createSession(
        workspaceID: String, title: String?, permissionMode: PermissionMode,
        modelID: String?, reasoningEffort: ReasoningEffort?
    ) async throws -> String
}

/// Additive live-input capability for hosts that implement the canonical
/// active-session mailbox. Older hosts continue to support ordinary sends and
/// reject these command kinds explicitly.
public protocol CodeRemoteSessionSteeringBridging: CodeRemoteSessionBridging {
    func steerMessage(sessionID: String, text: String) async throws
    func queueMessage(sessionID: String, text: String) async throws
}

/// A message from another of the reader's conversations, as the backend wrote it.
public struct CodeConversationDelivery: Equatable, Sendable {
    public let fromRef: String
    public let fromTitle: String
    public let fromProduct: String
    public let text: String
    public let hop: Int
    public let chainID: String
    public let linkID: String?
    public let notifyWhenIdle: Bool
    /// The one-shot idle notice a send from this session asked for.
    public let notice: Bool

    public init(
        fromRef: String, fromTitle: String, fromProduct: String, text: String, hop: Int, chainID: String,
        linkID: String? = nil, notifyWhenIdle: Bool = false, notice: Bool = false
    ) {
        self.fromRef = fromRef
        self.fromTitle = fromTitle
        self.fromProduct = fromProduct
        self.text = text
        self.hop = hop
        self.chainID = chainID
        self.linkID = linkID
        self.notifyWhenIdle = notifyWhenIdle
        self.notice = notice
    }
}

/// Hosts whose sessions take messages from the reader's other conversations.
public protocol CodeRemoteConversationBridging: CodeRemoteSessionBridging {
    /// Records the message in the session and gives it a turn: at once when
    /// the session is idle, after the running turn (or the pending approval)
    /// otherwise. Returns "started", "queued", "noted" or throws when the
    /// session does not take messages from other conversations.
    func deliverConversationMessage(sessionID: String, delivery: CodeConversationDelivery) async throws -> String
}

/// A session a host opened for a remote command — or found already open.
public struct CodeRemoteCreatedSession: Equatable, Sendable {
    public let id: String
    /// False when the requested id already named a session here: the command
    /// was delivered before, and its first prompt must not be sent twice.
    public let isNew: Bool

    public init(id: String, isNew: Bool) {
        self.id = id
        self.isNew = isNew
    }
}

/// Everything a remote `create_session` asks for, validated.
public struct CodeRemoteSessionRequest: Equatable, Sendable {
    /// The id the phone minted when it sent the command. Adopting it is what
    /// makes the thread the phone opened the one this session writes to; the
    /// phone cannot learn a host-chosen id, because it does not wait for the
    /// command's result. Nil lets the host choose.
    public let requestedID: String?
    public let workspaceID: String
    public let title: String?
    public let permissionMode: PermissionMode
    public let modelID: String?
    public let reasoningEffort: ReasoningEffort?

    public init(
        requestedID: String?, workspaceID: String, title: String?,
        permissionMode: PermissionMode, modelID: String?, reasoningEffort: ReasoningEffort?
    ) {
        self.requestedID = requestedID
        self.workspaceID = workspaceID
        self.title = title
        self.permissionMode = permissionMode
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
    }
}

/// Hosts that open a remotely requested session under the id the phone chose.
public protocol CodeRemoteSessionAdoptingBridging: CodeRemoteSessionBridging {
    func createSession(_ request: CodeRemoteSessionRequest) async throws -> CodeRemoteCreatedSession
}

/// The reader's limit on what anything sent from another device may do here —
/// the remote ceiling in Settings. A host that provides it has every remote
/// action checked against it; the adapter never raises it.
public protocol CodeRemoteCeilingProviding: CodeRemoteSessionBridging {
    /// The ceiling for the project the session works in; nil when the session
    /// is unknown.
    func remoteCeiling(forSession sessionID: String) async -> PermissionMode?
    func remoteCeiling(forWorkspace workspaceID: String) async -> PermissionMode
}

/// The settings a phone's session menu may change. Nil means "leave it".
public struct CodeRemoteSessionUpdate: Equatable, Sendable {
    public var title: String?
    public var modelID: String?
    public var reasoningEffort: ReasoningEffort?
    public var permissionMode: PermissionMode?
    public var pinned: Bool?

    public init(
        title: String? = nil, modelID: String? = nil, reasoningEffort: ReasoningEffort? = nil,
        permissionMode: PermissionMode? = nil, pinned: Bool? = nil
    ) {
        self.title = title
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.permissionMode = permissionMode
        self.pinned = pinned
    }

    public var isEmpty: Bool {
        title == nil && modelID == nil && reasoningEffort == nil && permissionMode == nil && pinned == nil
    }
}

public protocol CodeRemoteSessionUpdating: CodeRemoteSessionBridging {
    func updateSession(sessionID: String, update: CodeRemoteSessionUpdate) async throws
}

// MARK: - The adapter

public struct RemoteCommandAdapter: CodeRemoteCommandExecuting {
    private let bridge: any CodeRemoteSessionBridging
    /// Read at execution time, not at construction: the user can switch Remote
    /// off mid-run, and a command claimed a moment earlier must not still be
    /// carried out.
    private let isHostActive: @Sendable () async -> Bool

    public init(
        bridge: any CodeRemoteSessionBridging,
        isHostActive: @escaping @Sendable () async -> Bool = { true }
    ) {
        self.bridge = bridge
        self.isHostActive = isHostActive
    }

    /// Parses and authorises without executing. Exposed so the rules can be
    /// tested, and so a caller can reject early.
    public func validate(_ command: CodeRemoteCommand) throws -> ValidatedRemoteCommand {
        guard let kind = CodeRemoteCommandKind(rawValue: command.kind) else {
            throw CodeRemoteCommandError.unsupportedKind(command.kind)
        }
        return ValidatedRemoteCommand(
            id: command.id,
            sessionID: command.sessionID,
            kind: kind,
            payload: command.payload
        )
    }

    public func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue] {
        // Checked first, and again here rather than only in the host loop: the
        // long poll parks for ~25 seconds, so a deactivation almost always
        // lands while a command is in flight.
        guard await isHostActive() else { throw CodeRemoteCommandError.hostInactive }

        let validated = try validate(command)

        switch validated.kind {
        case .createSession:
            // Both spellings are live: the phone sends `workspaceKey` and
            // `prompt`, the CLI `workspaceId` and `initialMessage`. Requiring
            // one of them refused every session a phone tried to start.
            let workspaceID = try validated.string(oneOf: ["workspaceId", "workspaceKey", "workspaceID"])
            // Opaque id, never a path. The phone has no business knowing where
            // the folder is, and a path arriving from off-device would be a
            // way to name a folder that was never shared.
            guard await bridge.isWorkspaceSharedWithRemote(workspaceID) else {
                throw CodeRemoteCommandError.workspaceNotGranted(workspaceID)
            }
            var mode = try requestedMode(validated, ceiling: nil)
            if let limits = bridge as? any CodeRemoteCeilingProviding {
                // Lowered, not refused: ask-before-changes is what a phone gets
                // when it names no mode, and a reader who set a read-only
                // ceiling meant exactly that.
                mode = mode.capped(at: await limits.remoteCeiling(forWorkspace: workspaceID))
            }
            let modelID = validated.firstString(["modelId", "modelID"])
            let reasoning = try reasoningEffort(validated)
            let title = validated.optionalString("title")
            let initialMessage = validated.firstString(["initialMessage", "prompt", "text"])

            if let adopting = bridge as? any CodeRemoteSessionAdoptingBridging {
                let created = try await adopting.createSession(
                    CodeRemoteSessionRequest(
                        requestedID: try Self.adoptableSessionID(validated.sessionID),
                        workspaceID: workspaceID, title: title, permissionMode: mode,
                        modelID: modelID, reasoningEffort: reasoning
                    )
                )
                if created.isNew, let initialMessage {
                    try await bridge.sendMessage(sessionID: created.id, text: initialMessage)
                }
                return ["sessionId": .string(created.id)]
            }
            guard modelID != nil || reasoning != nil else {
                let id = try await bridge.createSession(
                    workspaceID: workspaceID, title: title, permissionMode: mode
                )
                if let initialMessage {
                    try await bridge.sendMessage(sessionID: id, text: initialMessage)
                }
                return ["sessionId": .string(id)]
            }
            guard let configured = bridge as? any CodeRemoteSessionConfigurationBridging else {
                throw CodeRemoteCommandError.invalidField("modelId", reason: "this host cannot select models")
            }
            let id = try await configured.createSession(
                workspaceID: workspaceID, title: title, permissionMode: mode,
                modelID: modelID, reasoningEffort: reasoning
            )
            if let initialMessage {
                try await bridge.sendMessage(sessionID: id, text: initialMessage)
            }
            return ["sessionId": .string(id)]

        case .sendMessage:
            try await authorize(validated)
            try await bridge.sendMessage(
                sessionID: validated.sessionID,
                text: try validated.string(oneOf: ["text", "prompt", "message"])
            )
            return ["accepted": .bool(true)]

        case .steer, .queue:
            try await authorize(validated)
            guard let steering = bridge as? any CodeRemoteSessionSteeringBridging else {
                throw CodeRemoteCommandError.unsupportedKind(validated.kind.rawValue)
            }
            let text = try validated.string(oneOf: ["text", "prompt", "message"])
            if validated.kind == .steer {
                try await steering.steerMessage(sessionID: validated.sessionID, text: text)
            } else {
                try await steering.queueMessage(sessionID: validated.sessionID, text: text)
            }
            return ["accepted": .bool(true)]

        case .stopAgent:
            try await bridge.stopAgent(sessionID: validated.sessionID)
            return ["stopped": .bool(true)]

        case .retryTurn:
            try await authorize(validated)
            try await bridge.retryTurn(sessionID: validated.sessionID)
            return ["accepted": .bool(true)]

        case .forkSession:
            try await authorize(validated)
            let id = try await bridge.forkSession(sessionID: validated.sessionID)
            return ["sessionId": .string(id)]

        case .approvalDecision:
            guard let approved = validated.firstBool(["approved", "approve"]) else {
                throw CodeRemoteCommandError.missingField("approved")
            }
            // Declining is always open: it can only take authority away. Allowing
            // is held to the ceiling like any other act. A session above it was
            // opened at the desk with more autonomy than the reader lets another
            // device use, so what it still asks about — in full access, only the
            // critical actions — is what the reader kept for the desk. Before
            // the Mac listed its sessions a phone never saw those requests; now
            // it does, and "allow" would run them with nobody there.
            if approved { try await requireWithinCeiling(validated.sessionID) }
            try await bridge.resolveApproval(
                sessionID: validated.sessionID,
                approvalID: try validated.string(oneOf: ["approvalId", "requestId", "approvalID"]),
                approved: approved
            )
            return ["resolved": .bool(true)]

        case .acceptChange, .rejectChange:
            try await authorize(validated)
            try await bridge.applyChange(
                sessionID: validated.sessionID,
                changeID: try validated.string(oneOf: Self.changeFields),
                accept: validated.kind == .acceptChange
            )
            return ["applied": .bool(true)]

        case .applyPatch:
            // Older relays rewrote the phone's session menu ("patch") to this
            // verb. Without a change named, that is what it was.
            guard validated.firstString(Self.changeFields) != nil else {
                return try await updateSession(validated)
            }
            try await authorize(validated)
            try await bridge.applyChange(
                sessionID: validated.sessionID,
                changeID: try validated.string(oneOf: Self.changeFields),
                accept: true
            )
            return ["applied": .bool(true)]

        case .deleteChange:
            try await authorize(validated)
            try await bridge.deleteChange(
                sessionID: validated.sessionID,
                changeID: try validated.string(oneOf: Self.changeFields)
            )
            return ["deleted": .bool(true)]

        case .undoChange:
            try await authorize(validated)
            // Undo restores one checkpoint, named by the `checkpointId` each
            // uploaded file change carries. There is deliberately no "undo the
            // last turn" guess: restoring the wrong checkpoint loses work.
            try await bridge.undoChange(
                sessionID: validated.sessionID,
                checkpointID: try validated.string(oneOf: ["checkpointId", "checkpointID"])
            )
            return ["undone": .bool(true)]

        case .updateSession:
            return try await updateSession(validated)

        case .deleteSession:
            throw CodeRemoteCommandError.notAvailableRemotely(
                "Sessions are deleted on the Mac itself. This one is still there."
            )

        case .crossMessage:
            // No `authorize`: nothing here asks for a mode, and any mode or
            // approval field in the payload is ignored, never applied. The
            // message is data for the session's next turn, not a command.
            guard let conversations = bridge as? any CodeRemoteConversationBridging else {
                throw CodeRemoteCommandError.unsupportedKind(validated.kind.rawValue)
            }
            let delivery = try Self.conversationDelivery(validated)
            let outcome = try await conversations.deliverConversationMessage(sessionID: validated.sessionID, delivery: delivery)
            return ["outcome": .string(outcome)]

        case .runTests:
            try await authorize(validated)
            try await bridge.runTests(
                sessionID: validated.sessionID,
                command: validated.optionalString("command")
            )
            return ["started": .bool(true)]

        case .stopTests:
            try await bridge.stopTests(sessionID: validated.sessionID)
            return ["stopped": .bool(true)]

        case .gitAction:
            try await authorize(validated)
            try await bridge.performGitAction(
                sessionID: validated.sessionID,
                action: try validated.string("action"),
                message: validated.optionalString("message")
            )
            return ["performed": .bool(true)]
        }
    }

    /// Canonical-protocol entry point used by new host clients (CLI, XPC and
    /// relay vNext). It deliberately routes back through the established
    /// parser/authoriser above, so introducing the protocol cannot create a
    /// second permission path for the same local runtime.
    public func execute(
        _ command: CodeSessionCommandEnvelope,
        at date: Date = Date()
    ) async throws -> CodeSessionCommandReceipt {
        guard command.protocolVersion.isCompatible(with: .current) else {
            throw CodeRemoteCommandError.invalidField(
                "protocolVersion", reason: "this host cannot safely interpret the command"
            )
        }
        guard !command.isExpired(at: date) else {
            return CodeSessionCommandReceipt(
                commandID: command.id,
                idempotencyKey: command.idempotencyKey,
                disposition: .expired,
                errorCode: "expired",
                completedAt: date
            )
        }
        let legacy = CodeRemoteCommand(
            id: command.id,
            // A `create_session` with no id lets the host choose one. A stable
            // sentinel keeps the DTO valid without granting it any meaning.
            sessionID: command.sessionID?.value ?? Self.unaddressedSessionID,
            kind: Self.legacyKind(for: command.kind),
            payload: command.payload.mapValues(Self.relayValue),
            status: "claimed"
        )
        let result = try await execute(legacy)
        return CodeSessionCommandReceipt(
            commandID: command.id,
            idempotencyKey: command.idempotencyKey,
            disposition: .completed,
            result: result.mapValues(Self.coreValue),
            completedAt: date
        )
    }

    private static func legacyKind(for kind: CodeSessionCommandKind) -> String {
        switch kind {
        case .createSession: "create_session"
        case .sendMessage: "send_message"
        case .steer: "steer"
        case .queue: "queue"
        case .cancel: "stop_agent"
        case .approvalDecision: "approval_decision"
        case .retry: "retry"
        case .fork: "fork"
        case .runTests: "run_tests"
        case .stopTests: "stop_tests"
        case .gitAction: "git_action"
        case .inspectDiff: "inspect_diff"
        case .inspectFiles: "inspect_files"
        case .inspectSubagents: "inspect_subagents"
        case .acceptChange: "accept_change"
        case .rejectChange: "reject_change"
        case .undoChange: "undo_change"
        case .deleteChange: "delete_change"
        case .updateSession: "update_session"
        }
    }

    /// The delivery a `cross_message` command carries, validated.
    static func conversationDelivery(_ command: ValidatedRemoteCommand) throws -> CodeConversationDelivery {
        let text = try command.string("text")
        guard text.count <= CodeCrossConversation.maxChars else {
            throw CodeRemoteCommandError.invalidField("text", reason: "it is longer than a message between conversations may be")
        }
        let hop = command.payload["hop"]?.numberValue.map { Int($0) } ?? 0
        guard hop >= 0, hop < CodeCrossConversation.maxHops + 1 else {
            throw CodeRemoteCommandError.invalidField("hop", reason: "the exchange is past its limit")
        }
        let product = command.optionalString("fromProduct") == "chat" ? "chat" : "code"
        return CodeConversationDelivery(
            fromRef: try command.string("fromRef"),
            fromTitle: command.optionalString("fromTitle") ?? "Another conversation",
            fromProduct: product,
            text: text,
            hop: hop,
            chainID: try command.string("chainId"),
            linkID: command.optionalString("linkId"),
            notifyWhenIdle: command.payload["notifyWhenIdle"]?.boolValue ?? false,
            notice: command.payload["notice"]?.boolValue ?? false
        )
    }

    /// Where a change is named: the Mac's own `changeId`, or the `path` the
    /// web's rollback controls send. Both are the workspace-relative path.
    static let changeFields = ["changeId", "path", "changeID"]

    /// The sentinel the canonical path uses when a command names no session.
    static let unaddressedSessionID = "new-session"

    /// The phone's minted id, when it can safely name a session directory on
    /// this Mac; nil when the command did not choose one.
    static func adoptableSessionID(_ raw: String) throws -> String? {
        guard !raw.isEmpty, raw != unaddressedSessionID else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard raw.count <= 128,
            raw.unicodeScalars.allSatisfy({ $0.isASCII && allowed.contains($0) })
        else {
            throw CodeRemoteCommandError.invalidField("sessionId", reason: "not a usable session id")
        }
        return raw
    }

    private func reasoningEffort(_ command: ValidatedRemoteCommand) throws -> ReasoningEffort? {
        guard let raw = command.firstString(["reasoning", "reasoningEffort"]) else { return nil }
        guard let effort = ReasoningEffort(rawValue: raw) else {
            throw CodeRemoteCommandError.invalidField("reasoning", reason: "unknown reasoning effort")
        }
        return effort
    }

    /// The phone's session menu: model, effort, mode, title, pin.
    ///
    /// A mode may only go down from here. Raising it is a decision about how
    /// much a session may do unattended, and that is made at the Mac.
    private func updateSession(
        _ command: ValidatedRemoteCommand
    ) async throws -> [String: JunoJSONValue] {
        guard let updating = bridge as? any CodeRemoteSessionUpdating else {
            throw CodeRemoteCommandError.unsupportedKind(command.kind.rawValue)
        }
        if command.firstBool(["archived"]) == true {
            throw CodeRemoteCommandError.notAvailableRemotely(
                "This Mac does not archive sessions. Keep or delete it on the Mac."
            )
        }
        try await authorize(command)
        var update = CodeRemoteSessionUpdate()
        if let title = command.optionalString("title")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty
        {
            update.title = String(title.prefix(200))
        }
        update.modelID = command.firstString(["modelID", "modelId"])
        update.reasoningEffort = try reasoningEffort(command)
        if command.optionalString("permissionMode") != nil {
            let current = await bridge.permissionMode(forSession: command.sessionID)
            update.permissionMode = try requestedMode(command, ceiling: current ?? .askBeforeChanges)
        }
        update.pinned = command.firstBool(["pinned"])
        guard !update.isEmpty else {
            throw CodeRemoteCommandError.invalidField("payload", reason: "nothing to change")
        }
        try await updating.updateSession(sessionID: command.sessionID, update: update)
        return ["updated": .bool(true)]
    }

    private static func relayValue(_ value: JSONValue) -> JunoJSONValue {
        switch value {
        case .null: .null
        case .bool(let value): .bool(value)
        case .number(let value): .number(value)
        case .string(let value): .string(value)
        case .array(let values): .array(values.map(relayValue))
        case .object(let values): .object(values.mapValues(relayValue))
        }
    }

    private static func coreValue(_ value: JunoJSONValue) -> JSONValue {
        switch value {
        case .null: .null
        case .bool(let value): .bool(value)
        case .number(let value): .number(value)
        case .string(let value): .string(value)
        case .array(let values): .array(values.map(coreValue))
        case .object(let values): .object(values.mapValues(coreValue))
        }
    }

    /// Refuses a command that would run above the session's own mode.
    ///
    /// The rule the work order names: a remote command may not increase the
    /// permission mode. Without it, a phone could ask a read-only session to
    /// run in full access and the session would comply — which would make the
    /// mode a suggestion rather than a boundary, and make it one that can be
    /// changed by someone who is not sitting at the machine.
    ///
    /// And refuses anything that would act in a session running above the
    /// reader's remote ceiling. Listing the Mac's own sessions on the phone
    /// makes them reachable from it; without this, a session opened in full
    /// access at the desk would take a prompt from the phone and run it in
    /// full access with nobody there — more than the ceiling promises anything
    /// sent from another device.
    private func authorize(_ command: ValidatedRemoteCommand) async throws {
        guard let current = try await requireWithinCeiling(command.sessionID) else { return }
        _ = try requestedMode(command, ceiling: current)
    }

    /// Refuses when the session runs above the reader's remote ceiling, and
    /// returns the mode it runs in; nil for a session this host does not know,
    /// which the call that acts on it then refuses.
    @discardableResult
    private func requireWithinCeiling(_ sessionID: String) async throws -> PermissionMode? {
        guard let current = await bridge.permissionMode(forSession: sessionID) else {
            return nil
        }
        if let limits = bridge as? any CodeRemoteCeilingProviding,
            let ceiling = await limits.remoteCeiling(forSession: sessionID),
            current.authorityRank > ceiling.authorityRank
        {
            throw CodeRemoteCommandError.aboveRemoteCeiling(
                session: current.readerName, ceiling: ceiling.readerName
            )
        }
        return current
    }

    private func requestedMode(
        _ command: ValidatedRemoteCommand,
        ceiling: PermissionMode?
    ) throws -> PermissionMode {
        guard let raw = command.optionalString("permissionMode") else {
            return ceiling ?? .askBeforeChanges
        }
        guard let requested = PermissionMode(remoteName: raw) else {
            throw CodeRemoteCommandError.invalidField(
                "permissionMode", reason: "unknown mode \"\(raw)\""
            )
        }
        if let ceiling, requested.authorityRank > ceiling.authorityRank {
            throw CodeRemoteCommandError.permissionEscalation(
                requested: requested.rawValue, current: ceiling.rawValue
            )
        }
        // A *new* session may not open above ask-before-changes from a phone:
        // granting full access is a decision made at the machine that has the
        // files on it.
        if ceiling == nil, requested.authorityRank > PermissionMode.askBeforeChanges.authorityRank {
            throw CodeRemoteCommandError.permissionEscalation(
                requested: requested.rawValue,
                current: PermissionMode.askBeforeChanges.rawValue
            )
        }
        return requested
    }
}

extension PermissionMode {
    /// A mode by the Mac's own name, or by the names the phone and the relay
    /// use for the same rungs. The phone's session menu offers
    /// `approvalRequired`, `auto` and `readOnly`; refusing those as unknown
    /// made every mode change sent from the phone fail.
    init?(remoteName: String) {
        if let mode = PermissionMode(rawValue: remoteName) {
            self = mode
            return
        }
        switch remoteName {
        case "approvalRequired", "ask": self = .askBeforeChanges
        case "auto", "autoEdit": self = .workspaceWrite
        case "plan": self = .readOnly
        case "full": self = .fullAccess
        default: return nil
        }
    }

    /// The relay's name for the rung — what the phone's session menu compares
    /// against to put its checkmark on the right one.
    public var relayName: String {
        switch self {
        case .readOnly: "readOnly"
        case .askBeforeChanges: "approvalRequired"
        case .workspaceWrite: "auto"
        case .fullAccess: "fullAccess"
        }
    }

    /// The rung as the mode ladder names it, for a refusal a person reads.
    var readerName: String {
        switch self {
        case .readOnly: "read-only"
        case .askBeforeChanges: "ask before changes"
        case .workspaceWrite: "auto-edit"
        case .fullAccess: "full access"
        }
    }
}
