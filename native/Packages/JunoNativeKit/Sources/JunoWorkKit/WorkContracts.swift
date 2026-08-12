import Foundation
import JunoCore

/// The value types a Juno Work client exchanges with the relay.
///
/// Every string enumeration here uses raw values identical to the canonical
/// TypeScript vocabulary in `src/lib/work/domain.ts`, because these are the
/// literal bytes on the wire. Where a generated mirror exists
/// (`JunoCore/Generated/JunoWorkContract.swift`) prefer it; these types carry
/// the *shapes*, not the vocabularies.

// MARK: - Hosts

/// A Mac as the relay describes it to a phone or to another Mac.
///
/// Note what is absent: no filesystem path, and no folder name that was not
/// chosen for display. A supervising phone can say "organise the folder you
/// call Downloads" without ever learning that it is `/Users/liam/Downloads`. A
/// leaked absolute path gives away the account name, the directory layout, and
/// usually the real identity of the work — and a path on a phone screen is a
/// path in a screenshot, a support ticket, and a prompt-injection payload.
public struct WorkHostSummary: Equatable, Sendable, Identifiable {
    public let hostID: String
    public let deviceID: String
    public let displayName: String
    /// "online" | "idle" | "stale" | "offline".
    public let state: String
    public let enabled: Bool
    /// Capability keys the host itself advertised. Never inferred by the
    /// client: a target selector that guesses is one that queues local work at
    /// a Mac which cannot do it.
    public let capabilities: [String]
    public let activeRunCount: Int
    public let queuedRunCount: Int
    public let lastSeenAt: Date
    public let revokedAt: Date?

    public var id: String { hostID }

    /// Whether dispatching local work here can actually be served right now.
    ///
    /// Deliberately conservative about `stale`: a host that is heartbeating but
    /// not claiming will accept a command into the queue and never run it,
    /// which presents to the user as a task that is "starting" forever.
    public var canServeWork: Bool {
        enabled && revokedAt == nil && (state == "online" || state == "idle")
    }

    public init(
        hostID: String, deviceID: String, displayName: String, state: String,
        enabled: Bool, capabilities: [String], activeRunCount: Int,
        queuedRunCount: Int, lastSeenAt: Date, revokedAt: Date?
    ) {
        self.hostID = hostID
        self.deviceID = deviceID
        self.displayName = displayName
        self.state = state
        self.enabled = enabled
        self.capabilities = capabilities
        self.activeRunCount = activeRunCount
        self.queuedRunCount = queuedRunCount
        self.lastSeenAt = lastSeenAt
        self.revokedAt = revokedAt
    }
}

/// The facts about one Mac that do not change between heartbeats.
///
/// Carried as a value rather than as three parameters threaded through the
/// relay, because `POST /api/work/hosts/register` needs all three on *every*
/// advertisement — it is one endpoint for "this Mac exists" and "this is what it
/// can do right now" — and a heartbeat that could be assembled without the
/// device id would be a heartbeat that 400s at the one moment the loop has no
/// person watching it.
///
/// `deviceID` is the Juno Code device row's id, replayed from
/// `juno.code.deviceId`. Work deliberately does not mint an identity of its own:
/// the registration route looks the device up on the account and refuses an id
/// it does not own, so reusing it is what makes the pairing already-solved
/// rather than a second protocol to keep correct.
public struct WorkHostIdentity: Equatable, Sendable {
    public let deviceID: String
    /// The Mac's name as its owner would recognise it, and as the Code device
    /// list already shows it.
    public let displayName: String
    public let appVersion: String

    public init(deviceID: String, displayName: String, appVersion: String) {
        self.deviceID = deviceID
        self.displayName = displayName
        self.appVersion = appVersion
    }
}

/// How much remote work this Mac is carrying at the moment it advertises.
///
/// Asked per advertisement rather than passed in once, because two things
/// advertise this Mac — the host model's heartbeat and the claim loop's own
/// pass — and a value captured by either of them is a value the other
/// overwrites. The relay reads `activeRunCount` to decide whether this Mac is
/// `online` or merely `idle`, so two writers disagreeing makes a busy Mac flap
/// between the two on every beat.
public struct WorkHostRunCounts: Equatable, Sendable {
    public let active: Int
    public let queued: Int

    public init(active: Int, queued: Int) {
        self.active = active
        self.queued = queued
    }

    public static let none = WorkHostRunCounts(active: 0, queued: 0)
}

/// What the relay hands back when this Mac registers.
public struct WorkHostRegistration: Equatable, Sendable {
    /// The `WorkHost` row's id — the value every other host-plane route is
    /// addressed by, and the one thing a Mac cannot obtain any other way.
    public let hostID: String
    /// The subset of the advertised manifest this backend will actually route
    /// on. Returned so a newer Mac can see that half its advertisement is being
    /// ignored, rather than infer it from work that never arrives.
    public let routableCapabilities: [String]

    public init(hostID: String, routableCapabilities: [String]) {
        self.hostID = hostID
        self.routableCapabilities = routableCapabilities
    }
}

/// A folder or file source a run may use, as a remote client may see it.
///
/// There is no `localPath` on this type and there must never be one. The
/// server has two serialisers for a grant — one for remote clients and one for
/// the owning Mac — and this is the remote shape. Adding a path field here
/// would silently defeat that split, because the decoder would start accepting
/// a field the server is careful not to send.
public struct WorkGrantSummary: Equatable, Sendable, Identifiable {
    public let grantID: String
    /// "local_folder" | "local_file" | "cloud_folder" | "cloud_file" | "connector_scope".
    public let kind: String
    public let displayName: String
    /// "read" | "read_write_no_delete" | "read_write".
    public let accessMode: String
    public let hostID: String?
    public let revokedAt: Date?
    public let lastUsedAt: Date?

    public var id: String { grantID }

    public var isActive: Bool { revokedAt == nil }

    public init(
        grantID: String, kind: String, displayName: String, accessMode: String,
        hostID: String?, revokedAt: Date?, lastUsedAt: Date?
    ) {
        self.grantID = grantID
        self.kind = kind
        self.displayName = displayName
        self.accessMode = accessMode
        self.hostID = hostID
        self.revokedAt = revokedAt
        self.lastUsedAt = lastUsedAt
    }
}

// MARK: - Sessions and runs

public struct WorkSessionSummary: Equatable, Sendable, Identifiable {
    public let sessionID: String
    public let title: String
    public let goal: String
    /// One of the statuses in `src/lib/work/domain.ts`.
    public let status: String
    /// Stored server-side rather than derived, so every client agrees on what
    /// "needs attention" means instead of re-implementing the same three-way
    /// test three different ways.
    public let needsAttention: Bool
    public let requestedTarget: String
    public let effectiveTarget: String?
    public let hostID: String?
    public let hostDisplayName: String?
    /// The model and reasoning choice saved on the task, if one was explicit.
    ///
    /// These belong to the session rather than the run: a task can be retried
    /// with a different model, while the task's own context remains the thing
    /// the reader asked Juno to use by default.
    public let requestedModel: String?
    public let reasoningEffort: String?
    public let permissionPolicy: JunoWorkPermissionPolicy?
    public let pinned: Bool
    public let archived: Bool
    public let lastActivityAt: Date
    public let currentRunID: String?
    public let lastSeq: Int

    public var id: String { sessionID }

    public init(
        sessionID: String, title: String, goal: String, status: String,
        needsAttention: Bool, requestedTarget: String, effectiveTarget: String?,
        hostID: String?, hostDisplayName: String?, requestedModel: String? = nil,
        reasoningEffort: String? = nil, permissionPolicy: JunoWorkPermissionPolicy? = nil,
        pinned: Bool, archived: Bool,
        lastActivityAt: Date, currentRunID: String?, lastSeq: Int
    ) {
        self.sessionID = sessionID
        self.title = title
        self.goal = goal
        self.status = status
        self.needsAttention = needsAttention
        self.requestedTarget = requestedTarget
        self.effectiveTarget = effectiveTarget
        self.hostID = hostID
        self.hostDisplayName = hostDisplayName
        self.requestedModel = requestedModel
        self.reasoningEffort = reasoningEffort
        self.permissionPolicy = permissionPolicy
        self.pinned = pinned
        self.archived = archived
        self.lastActivityAt = lastActivityAt
        self.currentRunID = currentRunID
        self.lastSeq = lastSeq
    }
}

/// The durable choices a Work task carries between attempts.
///
/// Connector scope is optional on purpose. `nil` means the task predates the
/// explicit app question (or the server could not answer it); an empty array is
/// a real choice that reaches no connected app. Treating both as `[]` would make
/// a context editor silently revoke an older task's implicit reach.
public struct WorkSessionAttachment: Equatable, Sendable, Identifiable {
    public let attachmentID: String
    public let displayName: String

    public var id: String { attachmentID }

    public init(attachmentID: String, displayName: String) {
        self.attachmentID = attachmentID
        self.displayName = displayName
    }
}

public struct WorkSessionContext: Equatable, Sendable {
    public let projectID: String?
    public let model: String?
    public let reasoningEffort: String?
    public let permissionPolicy: JunoWorkPermissionPolicy?
    public let connectorIDs: [String]?
    public let attachments: [WorkSessionAttachment]
    public let skillSlug: String?

    public init(
        projectID: String?,
        model: String?,
        reasoningEffort: String?,
        permissionPolicy: JunoWorkPermissionPolicy?,
        connectorIDs: [String]?,
        attachments: [WorkSessionAttachment],
        skillSlug: String?
    ) {
        self.projectID = projectID
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.permissionPolicy = permissionPolicy
        self.connectorIDs = connectorIDs
        self.attachments = attachments
        self.skillSlug = skillSlug
    }
}

/// A scalar that a context PATCH may leave alone, replace, or clear.
public enum WorkContextStringChange: Equatable, Sendable {
    case unchanged
    case set(String)
    case clear
}

public struct WorkSessionContextEdit: Equatable, Sendable {
    public var model: String?
    public var reasoningEffort: WorkContextStringChange
    public var permissionPolicy: JunoWorkPermissionPolicy?
    public var connectorIDs: [String]?
    public var attachmentIDs: [String]?

    public init(
        model: String? = nil,
        reasoningEffort: WorkContextStringChange = .unchanged,
        permissionPolicy: JunoWorkPermissionPolicy? = nil,
        connectorIDs: [String]? = nil,
        attachmentIDs: [String]? = nil
    ) {
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.permissionPolicy = permissionPolicy
        self.connectorIDs = connectorIDs
        self.attachmentIDs = attachmentIDs
    }
}

public struct WorkContextFieldResult: Equatable, Sendable {
    public let field: String
    public let change: String
    public let effect: String
    public let explanation: String

    public init(field: String, change: String, effect: String, explanation: String) {
        self.field = field
        self.change = change
        self.effect = effect
        self.explanation = explanation
    }
}

public struct WorkSessionContextUpdate: Equatable, Sendable {
    public let context: WorkSessionContext
    public let session: WorkSessionSummary?
    public let applied: [WorkContextFieldResult]

    public init(
        context: WorkSessionContext,
        session: WorkSessionSummary?,
        applied: [WorkContextFieldResult]
    ) {
        self.context = context
        self.session = session
        self.applied = applied
    }
}

// MARK: - Artifacts

/// A durable deliverable produced by a Work session.
///
/// Events are intentionally not the source of truth here. They are a useful
/// live story while a run is moving, but the artifact row owns the current
/// version, validation state and download identity. A native client therefore
/// reads this shape from the artifact endpoint before offering a file action.
public struct WorkArtifactSummary: Equatable, Sendable, Identifiable {
    public let artifactID: String
    public let sessionID: String
    public let identifier: String
    public let title: String
    public let kind: JunoWorkArtifactKind
    public let mimeType: String
    public let currentVersion: Int
    public let validatedAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    public var id: String { artifactID }

    public init(
        artifactID: String,
        sessionID: String,
        identifier: String,
        title: String,
        kind: JunoWorkArtifactKind,
        mimeType: String,
        currentVersion: Int,
        validatedAt: Date?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.artifactID = artifactID
        self.sessionID = sessionID
        self.identifier = identifier
        self.title = title
        self.kind = kind
        self.mimeType = mimeType
        self.currentVersion = currentVersion
        self.validatedAt = validatedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One source recorded for a durable artifact version.
public struct WorkArtifactProvenance: Equatable, Sendable, Identifiable {
    public let kind: String
    public let label: String
    public let url: String?

    public var id: String { kind + ":" + label + ":" + (url ?? "") }

    public init(kind: String, label: String, url: String?) {
        self.kind = kind
        self.label = label
        self.url = url
    }
}

/// Immutable history for one generated deliverable.
public struct WorkArtifactVersion: Equatable, Sendable, Identifiable {
    public let version: Int
    public let byteSize: Int
    public let contentHash: String
    public let origin: String
    public let runID: String?
    public let validated: Bool
    public let provenance: [WorkArtifactProvenance]
    public let createdAt: Date

    public var id: Int { version }

    public init(
        version: Int,
        byteSize: Int,
        contentHash: String,
        origin: String,
        runID: String?,
        validated: Bool,
        provenance: [WorkArtifactProvenance],
        createdAt: Date
    ) {
        self.version = version
        self.byteSize = byteSize
        self.contentHash = contentHash
        self.origin = origin
        self.runID = runID
        self.validated = validated
        self.provenance = provenance
        self.createdAt = createdAt
    }
}

/// The artifact detail response, including bounded version history.
public struct WorkArtifactDetail: Equatable, Sendable {
    public let artifact: WorkArtifactSummary
    public let versions: [WorkArtifactVersion]
    public let warning: String?
    public let historyTruncated: Bool

    public init(
        artifact: WorkArtifactSummary,
        versions: [WorkArtifactVersion],
        warning: String?,
        historyTruncated: Bool
    ) {
        self.artifact = artifact
        self.versions = versions
        self.warning = warning
        self.historyTruncated = historyTruncated
    }
}

/// Verified bytes returned by the artifact download route.
public struct WorkArtifactDownload: Equatable, Sendable {
    public let artifactID: String
    public let version: Int
    public let bytes: Data
    public let contentType: String?
    public let validated: Bool
    public let validationWarning: String?

    public init(
        artifactID: String,
        version: Int,
        bytes: Data,
        contentType: String?,
        validated: Bool,
        validationWarning: String?
    ) {
        self.artifactID = artifactID
        self.version = version
        self.bytes = bytes
        self.contentType = contentType
        self.validated = validated
        self.validationWarning = validationWarning
    }
}

/// Why a run's effective shape differs from the requested one.
///
/// Carried as data rather than folded into a status string, because a client
/// that cannot name a degradation shows the user nothing — and showing nothing
/// is indistinguishable from nothing having gone wrong.
public struct WorkDegradation: Equatable, Sendable {
    public let kind: String
    public let explanation: String
    public let subject: String?

    public init(kind: String, explanation: String, subject: String?) {
        self.kind = kind
        self.explanation = explanation
        self.subject = subject
    }
}

public struct WorkRunSummary: Equatable, Sendable, Identifiable {
    public let runID: String
    public let sessionID: String
    public let attempt: Int
    public let status: String
    /// Authoritative, written once when the run ends. Never inferred from the
    /// last event: the last event of a run killed mid-sentence is whatever it
    /// happened to be emitting, and inferring from it states a confident wrong
    /// cause.
    public let terminalReason: String?
    public let requestedTarget: String
    public let effectiveTarget: String?
    public let hostID: String?
    public let effectiveModel: String?
    public let degradation: [WorkDegradation]
    public let costMicroUsd: Int
    public let maxCostMicroUsd: Int
    public let lastSeq: Int
    public let startedAt: Date?
    public let finishedAt: Date?

    public var id: String { runID }

    public init(
        runID: String, sessionID: String, attempt: Int, status: String,
        terminalReason: String?, requestedTarget: String, effectiveTarget: String?,
        hostID: String?, effectiveModel: String?, degradation: [WorkDegradation],
        costMicroUsd: Int, maxCostMicroUsd: Int, lastSeq: Int,
        startedAt: Date?, finishedAt: Date?
    ) {
        self.runID = runID
        self.sessionID = sessionID
        self.attempt = attempt
        self.status = status
        self.terminalReason = terminalReason
        self.requestedTarget = requestedTarget
        self.effectiveTarget = effectiveTarget
        self.hostID = hostID
        self.effectiveModel = effectiveModel
        self.degradation = degradation
        self.costMicroUsd = costMicroUsd
        self.maxCostMicroUsd = maxCostMicroUsd
        self.lastSeq = lastSeq
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }
}

// MARK: - Events

public struct WorkEvent: Equatable, Sendable, Identifiable {
    public let seq: Int
    public let kind: String
    public let payload: [String: JunoJSONValue]
    public let agentID: String?
    public let createdAt: Date

    public var id: Int { seq }

    public init(
        seq: Int, kind: String, payload: [String: JunoJSONValue],
        agentID: String?, createdAt: Date
    ) {
        self.seq = seq
        self.kind = kind
        self.payload = payload
        self.agentID = agentID
        self.createdAt = createdAt
    }
}

// MARK: - Approvals

/// One request for the user to authorise one exact action.
///
/// `actionDigest` travels with the request and must be echoed back with the
/// decision. That is what stops an approval shown for one action from
/// authorising a different one: the executor recomputes the digest immediately
/// before acting and refuses on mismatch. A decision without the digest would
/// be a decision about a description, not about an action.
public struct WorkApprovalRequest: Equatable, Sendable, Identifiable {
    public let approvalID: String
    public let runID: String
    public let action: String
    /// "safe" | "edit" | "command" | "sensitive" | "irreversible".
    public let risk: String
    /// Exactly the sentence the user is shown, stored server-side so an audit
    /// can prove what was on screen rather than what today's code would render.
    public let summary: String
    /// Display-safe structured detail. Counts and display names; never a path.
    public let detail: [String: JunoJSONValue]
    public let actionDigest: String
    public let expiresAt: Date
    public let decision: String

    public var id: String { approvalID }

    public var isPending: Bool { decision == "pending" }

    /// Whether native clients may offer or send a standing approval for this
    /// request. The action check is independent of the reported risk so an
    /// always-confirm action cannot acquire persistence when it is misgraded by
    /// an older or faulty executor.
    public var allowsStandingGrant: Bool {
        JunoWorkApprovalRules.allowsStandingGrant(action: action, risk: risk)
    }

    /// Whether this can still be answered. Expiry is closed rather than
    /// advisory: approving a send at 09:00 must not still authorise it at
    /// 17:00 after the draft has been rewritten.
    public func isAnswerable(at now: Date) -> Bool {
        isPending && expiresAt > now
    }

    public init(
        approvalID: String, runID: String, action: String, risk: String,
        summary: String, detail: [String: JunoJSONValue], actionDigest: String,
        expiresAt: Date, decision: String
    ) {
        self.approvalID = approvalID
        self.runID = runID
        self.action = action
        self.risk = risk
        self.summary = summary
        self.detail = detail
        self.actionDigest = actionDigest
        self.expiresAt = expiresAt
        self.decision = decision
    }
}

// MARK: - Commands

/// One instruction travelling client → relay → host.
public struct WorkCommand: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionID: String
    public let runID: String?
    /// One of `WORK_COMMAND_KINDS`.
    public let kind: String
    public let payload: [String: JunoJSONValue]
    public let status: String
    /// When the relay will hand this to another host if it is not acknowledged.
    /// A lease rather than a claim flag is what lets a crashed host's command
    /// be re-delivered instead of stranding the session.
    public let leaseExpiresAt: Date?
    public let expiresAt: Date

    public init(
        id: String, sessionID: String, runID: String?, kind: String,
        payload: [String: JunoJSONValue], status: String,
        leaseExpiresAt: Date?, expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.runID = runID
        self.kind = kind
        self.payload = payload
        self.status = status
        self.leaseExpiresAt = leaseExpiresAt
        self.expiresAt = expiresAt
    }

    /// Whether the host should still act on this.
    ///
    /// Checked at execution time, not only at claim time. A "stop" claimed by a
    /// host that had been offline for an hour would stop a run the user has
    /// since restarted.
    public func isStillValid(at now: Date) -> Bool {
        expiresAt > now
    }
}

// MARK: - Errors

public enum WorkRemoteError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier
    /// Something tried to advertise a Mac that has never been registered, so
    /// there is no `WorkHostIdentity` to register it with. Its own case rather
    /// than `invalidIdentifier`, because the two have opposite fixes: one is a
    /// hostile string, the other is a client composed without the device row it
    /// speaks for.
    case hostNotRegistered
    case unsupportedCommand(String)
    case malformedResponse
    case hostRevoked
    case hostNotEnabled
    case capabilityNotGranted(String)
    case approvalDigestMismatch
    case approvalExpired
    case standingApprovalForbidden
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier:
            "Juno could not safely address that Mac or task."
        case .hostNotRegistered:
            "This Mac has not finished pairing with your account yet."
        case .unsupportedCommand(let kind):
            "This build cannot carry out a \"\(kind)\" instruction."
        case .malformedResponse:
            "Juno received Work data it could not read."
        case .hostRevoked:
            "This Mac's access to Juno Work has been revoked."
        case .hostNotEnabled:
            "Juno Work is switched off on this Mac."
        case .capabilityNotGranted(let capability):
            "This Mac has not been granted \(capability)."
        case .approvalDigestMismatch:
            "What Juno was about to do no longer matches what you approved, so it stopped."
        case .approvalExpired:
            "That approval expired before Juno could act on it. Approve it again if you still want it."
        case .standingApprovalForbidden:
            String(localized: "work.approval.standing-forbidden")
        case .server(_, let message, _):
            message
        }
    }

    /// Whether retrying could ever succeed.
    ///
    /// Revocation and a withheld capability are permanent by nature; retrying
    /// them forever is how a decommissioned Mac keeps polling a relay that has
    /// already told it to stop.
    public var isRetryable: Bool {
        switch self {
        case .server(_, _, let retryable): retryable
        case .hostRevoked, .hostNotEnabled, .capabilityNotGranted,
             .approvalDigestMismatch, .approvalExpired, .invalidIdentifier,
             .standingApprovalForbidden, .hostNotRegistered, .unsupportedCommand,
             .malformedResponse:
            false
        }
    }
}
