import Foundation
import JunoCodeCore
import JunoCodeKit
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
}

public enum CodeRemoteCommandError: Error, Equatable, LocalizedError, Sendable {
    case unsupportedKind(String)
    case missingField(String)
    case invalidField(String, reason: String)
    case permissionEscalation(requested: String, current: String)
    case workspaceNotGranted(String)
    case hostInactive

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
            let workspaceID = try validated.string("workspaceId")
            // Opaque id, never a path. The phone has no business knowing where
            // the folder is, and a path arriving from off-device would be a
            // way to name a folder that was never shared.
            guard await bridge.isWorkspaceSharedWithRemote(workspaceID) else {
                throw CodeRemoteCommandError.workspaceNotGranted(workspaceID)
            }
            let mode = try requestedMode(validated, ceiling: nil)
            let modelID = validated.optionalString("modelId")
            let reasoningRaw = validated.optionalString("reasoning")
            guard modelID != nil || reasoningRaw != nil else {
                let id = try await bridge.createSession(workspaceID: workspaceID,
                                                        title: validated.optionalString("title"), permissionMode: mode)
                if let initialMessage = validated.optionalString("initialMessage") {
                    try await bridge.sendMessage(sessionID: id, text: initialMessage)
                }
                return ["sessionId": .string(id)]
            }
            let reasoning: ReasoningEffort?
            if let reasoningRaw {
                guard let parsed = ReasoningEffort(rawValue: reasoningRaw) else {
                    throw CodeRemoteCommandError.invalidField("reasoning", reason: "unknown reasoning effort")
                }
                reasoning = parsed
            } else {
                reasoning = nil
            }
            guard let configured = bridge as? any CodeRemoteSessionConfigurationBridging else {
                throw CodeRemoteCommandError.invalidField("modelId", reason: "this host cannot select models")
            }
            let id = try await configured.createSession(workspaceID: workspaceID,
                                                        title: validated.optionalString("title"), permissionMode: mode,
                                                        modelID: modelID, reasoningEffort: reasoning)
            if let initialMessage = validated.optionalString("initialMessage") {
                try await bridge.sendMessage(sessionID: id, text: initialMessage)
            }
            return ["sessionId": .string(id)]

        case .sendMessage:
            try await authorize(validated)
            try await bridge.sendMessage(
                sessionID: validated.sessionID,
                text: try validated.string("text")
            )
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
            // Not gated on the session's mode: answering an approval the Mac
            // itself raised is the one remote action that cannot exceed local
            // authority, because the local session decided what to ask.
            try await bridge.resolveApproval(
                sessionID: validated.sessionID,
                approvalID: try validated.string("approvalId"),
                approved: try validated.bool("approved")
            )
            return ["resolved": .bool(true)]

        case .acceptChange, .rejectChange:
            try await authorize(validated)
            try await bridge.applyChange(
                sessionID: validated.sessionID,
                changeID: try validated.string("changeId"),
                accept: validated.kind == .acceptChange
            )
            return ["applied": .bool(true)]

        case .applyPatch:
            try await authorize(validated)
            try await bridge.applyChange(
                sessionID: validated.sessionID,
                changeID: try validated.string("changeId"),
                accept: true
            )
            return ["applied": .bool(true)]

        case .deleteChange:
            try await authorize(validated)
            try await bridge.deleteChange(
                sessionID: validated.sessionID,
                changeID: try validated.string("changeId")
            )
            return ["deleted": .bool(true)]

        case .undoChange:
            try await authorize(validated)
            try await bridge.undoChange(
                sessionID: validated.sessionID,
                checkpointID: try validated.string("checkpointId")
            )
            return ["undone": .bool(true)]

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
            // `create_session` does not read the legacy session id. A stable
            // sentinel keeps the DTO valid without granting it any meaning.
            sessionID: command.sessionID?.value ?? "new-session",
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
        }
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
    private func authorize(_ command: ValidatedRemoteCommand) async throws {
        guard let current = await bridge.permissionMode(forSession: command.sessionID) else {
            return
        }
        _ = try requestedMode(command, ceiling: current)
    }

    private func requestedMode(
        _ command: ValidatedRemoteCommand,
        ceiling: PermissionMode?
    ) throws -> PermissionMode {
        guard let raw = command.optionalString("permissionMode") else {
            return ceiling ?? .askBeforeChanges
        }
        guard let requested = PermissionMode(rawValue: raw) else {
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
    /// Ordering for "may not exceed". Mirrors the coordinator's own ranking.
    var authorityRank: Int {
        switch self {
        case .readOnly: 0
        case .askBeforeChanges: 1
        case .workspaceWrite: 2
        case .fullAccess: 3
        }
    }
}
