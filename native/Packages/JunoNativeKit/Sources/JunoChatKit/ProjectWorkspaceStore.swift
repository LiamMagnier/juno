import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Observation

// MARK: - Project assistant configuration
//
// A project already exists. ``NativeProjectStore`` owns its identity, its name,
// its **synced** `instructions`, its attachments and its conversations, and every
// one of those round-trips through the outbox to `/api/v1`. None of that is
// restated here.
//
// What turns a project into a *custom assistant* is which tools it may reach for,
// which attachments are knowledge, the persona it shows and the model it prefers.
// Those fields have their own revisioned sync entity, separate from `project`, so
// an assistant edit and a project rename cannot overwrite one another.
//
// The alternative was to encode the whitelist into the synced `instructions`
// string as prose. That was rejected on purpose: prose is not a gate. A tool
// whitelist that is only a sentence in a prompt is one the model can decline to
// honour, and the whole point of a whitelist is that the *client* stops sending
// the flag.

// MARK: - Tools

/// A capability a workspace may or may not be allowed to reach for.
///
/// Each case corresponds to a field this client actually sets on a turn, so the
/// whitelist is enforceable rather than advisory — see
/// ``ProjectWorkspaceConfiguration/permitting(_:)``. A capability with no field
/// behind it would be a checkbox that does nothing, which is worse than an
/// absent one.
public enum ProjectWorkspaceTool: String, Codable, CaseIterable, Sendable, Identifiable {
    /// `useWebSearch` — reaching the live web for a turn.
    case webSearch
    /// The server's PLAN → SEARCH → READ → SYNTHESIS pipeline.
    case deepResearch
    /// Answering with a `<juno:artifact>`.
    case canvas
    /// Image and video generation.
    case mediaGeneration
    /// Acting through connected apps. Which apps is a separate list — see
    /// ``ProjectWorkspaceConfiguration/allowedConnectorIDs``.
    case connectors
    /// Whether this assistant is told what the account remembers about its owner.
    /// A persona built for work has no business reciting someone's dietary
    /// preferences back at them.
    case memoryRecall

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .webSearch: "Web search"
        case .deepResearch: "Deep research"
        case .canvas: "Canvas"
        case .mediaGeneration: "Image & video"
        case .connectors: "Connected apps"
        case .memoryRecall: "Memory"
        }
    }
}

/// Which tools a workspace may use.
///
/// Three-valued rather than a bare `Set`, because an empty set and "no opinion"
/// are opposite instructions and the difference is invisible once it has been
/// flattened. A workspace created before this feature existed, or one the reader
/// has never opened the tool sheet for, has **not** said that its assistant may
/// use nothing — it has said nothing, and the account's own defaults are the
/// honest answer. Collapsing that to an empty allow-list silently produces
/// assistants that cannot search the web and cannot explain why.
public enum ProjectWorkspaceToolAccess: Equatable, Sendable {
    /// Whatever the account and the model would normally allow.
    case inheritsAccountDefaults
    /// Exactly these, and nothing else. An empty set is legitimate and means
    /// "this assistant answers from its instructions and its knowledge only".
    case restricted(Set<ProjectWorkspaceTool>)

    public func allows(_ tool: ProjectWorkspaceTool) -> Bool {
        switch self {
        case .inheritsAccountDefaults: true
        case .restricted(let allowed): allowed.contains(tool)
        }
    }

    /// True only when this is a genuine restriction. Used by the UI to decide
    /// whether to say "All tools" or list them.
    public var isRestricted: Bool {
        if case .restricted = self { return true }
        return false
    }
}

// MARK: - The turn a workspace is asked to permit

/// The tool-bearing fields of one chat turn, in the shape
/// ``NativeChatGenerationRequest`` takes them.
///
/// Mirrored rather than reused so this file does not have to import — or move —
/// the chat client, which another surface owns. The mirror is deliberately
/// narrow: only the fields a workspace can veto.
public struct ProjectWorkspaceTurnPermissions: Equatable, Sendable {
    public var webSearch: Bool
    public var deepResearch: Bool
    /// **Nil means the server's default, and the server's default is on.** This
    /// is the one field where absent is a permission rather than an absence, so
    /// denying canvas requires sending an explicit `false` — leaving it nil
    /// would be a whitelist that silently allows the thing it excludes.
    public var canvasEnabled: Bool?
    public var connectorIDs: [String]
    public var mediaGeneration: Bool
    public var memoryRecall: Bool

    public init(
        webSearch: Bool = false,
        deepResearch: Bool = false,
        canvasEnabled: Bool? = nil,
        connectorIDs: [String] = [],
        mediaGeneration: Bool = false,
        memoryRecall: Bool = true
    ) {
        self.webSearch = webSearch
        self.deepResearch = deepResearch
        self.canvasEnabled = canvasEnabled
        self.connectorIDs = connectorIDs
        self.mediaGeneration = mediaGeneration
        self.memoryRecall = memoryRecall
    }
}

// MARK: - Configuration

/// The independently synced half of a custom assistant.
///
/// Everything a project already has — name, synced instructions, attachments,
/// conversations — stays in ``NativeProject``. This holds only what the backend
/// cannot yet store, and every optional here means "not set", never "off":
///
/// - ``instructionsOverride`` nil → use the project's own synced instructions.
///   `""` is a real override meaning *no* instructions, which is why it is not
///   the same value as nil.
/// - ``preferredModelID`` nil → the account default.
/// - ``allowedConnectorIDs`` nil → whatever connectors the account allows.
public struct ProjectWorkspaceConfiguration: Identifiable, Equatable, Sendable {
    /// The ``NativeProject`` this configures. Also the record id, so a workspace
    /// cannot exist twice for one project.
    public let projectID: String
    public var id: String { projectID }

    /// A persona name shown instead of the project's. Nil is not "" — an unnamed
    /// persona shows the project's name, an empty one would show nothing.
    public var personaName: String?
    /// Replaces the project's synced `instructions` for this assistant. Nil
    /// leaves the synced ones in charge.
    public var instructionsOverride: String?
    public var toolAccess: ProjectWorkspaceToolAccess
    /// Nil means "no opinion, use the account's connectors". An empty set means
    /// "this assistant reaches no connected apps", which is a different claim.
    public var allowedConnectorIDs: Set<String>?
    /// Attachment ids, in the order the reader arranged them, that are *knowledge*
    /// for this assistant. A subset of the project's files on purpose: a project
    /// accumulates every image ever pasted into one of its chats, and treating
    /// all of it as the assistant's reference material is how a persona starts
    /// answering from a screenshot somebody dropped in six weeks ago.
    public var knowledgeFileIDs: [String]
    public var preferredModelID: String?
    public var updatedAt: Date

    /// The longest an override may be. Matches the settings store's ceiling for
    /// `customInstructions`, because the two end up in the same prompt and a
    /// limit that differs between them is one the reader discovers by having text
    /// silently dropped.
    public static let maximumInstructionCharacters = 200_000
    public static let maximumPersonaNameCharacters = 160
    /// Past this the manifest alone crowds out the conversation.
    public static let maximumKnowledgeFiles = 64

    public init(
        projectID: String,
        personaName: String? = nil,
        instructionsOverride: String? = nil,
        toolAccess: ProjectWorkspaceToolAccess = .inheritsAccountDefaults,
        allowedConnectorIDs: Set<String>? = nil,
        knowledgeFileIDs: [String] = [],
        preferredModelID: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.projectID = projectID
        self.personaName = personaName
        self.instructionsOverride = instructionsOverride
        self.toolAccess = toolAccess
        self.allowedConnectorIDs = allowedConnectorIDs
        self.knowledgeFileIDs = Array(knowledgeFileIDs.prefix(Self.maximumKnowledgeFiles))
        self.preferredModelID = preferredModelID
        self.updatedAt = updatedAt
    }

    /// The instructions this assistant actually answers under.
    ///
    /// - Parameter project: The synced project, when it is known. Nil is a real
    ///   case — a workspace can be read before its project has loaded — and
    ///   resolves to the override alone rather than to "".
    public func resolvedInstructions(project: NativeProject?) -> String {
        if let instructionsOverride { return instructionsOverride }
        return project?.instructions ?? ""
    }

    public func resolvedName(project: NativeProject?) -> String? {
        if let personaName, !personaName.isEmpty { return personaName }
        return project?.name
    }

    /// Applies the whitelist to one turn.
    ///
    /// Vetoes only. A workspace can take a capability away from a turn and can
    /// never add one: the account's plan and the model's own capabilities are
    /// still the ceiling, and a persona that could grant itself web search would
    /// be a client-side privilege escalation dressed up as a preference.
    public func permitting(
        _ requested: ProjectWorkspaceTurnPermissions
    ) -> ProjectWorkspaceTurnPermissions {
        var result = requested
        if !toolAccess.allows(.webSearch) { result.webSearch = false }
        if !toolAccess.allows(.deepResearch) { result.deepResearch = false }
        if !toolAccess.allows(.mediaGeneration) { result.mediaGeneration = false }
        if !toolAccess.allows(.memoryRecall) { result.memoryRecall = false }
        // Canvas is the inverted one: nil means the server turns it on, so
        // denying it has to be said out loud. See
        // ``ProjectWorkspaceTurnPermissions/canvasEnabled``.
        if !toolAccess.allows(.canvas) { result.canvasEnabled = false }

        if !toolAccess.allows(.connectors) {
            result.connectorIDs = []
        } else if let allowedConnectorIDs {
            result.connectorIDs = requested.connectorIDs.filter(allowedConnectorIDs.contains)
        }
        return result
    }
}

// MARK: - Which model a project's turns go to

/// Answers the one question ``ProjectWorkspaceConfiguration/preferredModelID``
/// exists to answer, in a single place both composers can read.
///
/// Pure, and separate from the composer that calls it, because a precedence rule
/// spread across two clients is a precedence rule that will differ between them
/// within a release — and the symptom of that is a Mac and a phone sending the
/// same question in the same project to two different models.
public enum ProjectPreferredModel {
    /// The model a turn filed under this project should go to, or nil when this
    /// preference has nothing to say and the caller should carry on exactly as it
    /// would have.
    ///
    /// **The precedence this encodes, highest first, and why it is this order.**
    ///
    /// 1. **An explicit pick the reader just made** wins outright, which is what
    ///    `readerChoseExplicitly` is for. Someone who opened the model picker and
    ///    chose has said something specific about *this* conversation; a
    ///    preference saved on a Projects page weeks ago is a standing default.
    ///    The specific instruction beats the standing one, and a picker showing
    ///    one name while another model answers is a control that lies.
    /// 2. **The project's preference**, when it names a model this account can
    ///    still select. It outranks the conversation's own stored model on
    ///    purpose: that field is only a record of what the last turn happened to
    ///    use, while this is something the reader deliberately configured.
    /// 3. Nil — no opinion. Auto-routing and the account default are below this
    ///    and are the caller's business, not this function's.
    ///
    /// - Parameter selectableModelIDs: what the account may actually send to.
    ///   Checked rather than trusted: the preference is stored locally and is
    ///   never revalidated, so a plan change, a retired model, or a workspace
    ///   written by a newer build can all leave a stale id behind. Falling
    ///   through to the caller's own choice is the right failure — sending a
    ///   model id the route will reject would turn a stale preference into an
    ///   unsendable project.
    public static func resolve(
        preferredModelID: String?,
        readerChoseExplicitly: Bool,
        selectableModelIDs: [String]
    ) -> String? {
        guard !readerChoseExplicitly else { return nil }
        guard let preferredModelID,
            !preferredModelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            selectableModelIDs.contains(preferredModelID)
        else { return nil }
        return preferredModelID
    }
}

// MARK: - Snapshot

public struct ProjectWorkspaceSnapshot: Equatable, Sendable {
    public let workspaces: [String: ProjectWorkspaceConfiguration]
    /// Workspaces whose project no longer exists locally.
    ///
    /// Reported rather than deleted. A project can be missing because it was
    /// deleted, and it can be missing because this device has not synced it yet —
    /// and the two are indistinguishable from here. Cleaning up on the guess
    /// throws away a reader's tool whitelist for a project that was about to
    /// arrive.
    public let orphanedProjectIDs: Set<String>
    /// Legacy Mac-only records which have no synced counterpart yet. The live
    /// model promotes these through the ordinary mutation outbox once, so an
    /// assistant somebody already configured is not lost during the upgrade.
    public let legacyProjectIDs: Set<String>

    public init(
        workspaces: [String: ProjectWorkspaceConfiguration],
        orphanedProjectIDs: Set<String>,
        legacyProjectIDs: Set<String> = []
    ) {
        self.workspaces = workspaces
        self.orphanedProjectIDs = orphanedProjectIDs
        self.legacyProjectIDs = legacyProjectIDs
    }
}

public enum ProjectWorkspaceStoreError: Error, Equatable, LocalizedError, Sendable {
    case corruptRecord(RecordKey)
    case invalidProjectID
    case invalidInstructions
    case invalidPersonaName
    case concurrentWriteLimitExceeded

    public var errorDescription: String? {
        switch self {
        case .corruptRecord:
            "Juno could not read this assistant's saved setup."
        case .invalidProjectID:
            "Juno could not address this assistant."
        case .invalidInstructions:
            "These instructions are too long to save."
        case .invalidPersonaName:
            "Enter an assistant name of 160 characters or fewer."
        case .concurrentWriteLimitExceeded:
            "Juno could not save this assistant because it changed elsewhere. Try again."
        }
    }
}

// MARK: - Store

/// Reads and writes the local half of every custom assistant on this account.
///
/// An actor over the same ``AccountScopedRepository`` the rest of the chat stack
/// uses, so a workspace is account-partitioned and encrypted at rest by exactly
/// the same machinery, with no second database and no second wipe path to
/// forget on sign-out.
///
/// **No outbox.** Every other store in this target layers pending mutations over
/// the synced record; this one has nothing to sync to. Writing straight to the
/// repository is what makes that honest — a mutation queued for a route that
/// does not exist would sit in the outbox forever and be counted as pending work
/// in every screen that shows a sync badge.
public actor ProjectWorkspaceStore<Repository: AccountScopedRepository> {
    /// Not one of the namespaces the sync engine maps, and deliberately prefixed
    /// `native_` like the memory summary cache, which is local-only for the same
    /// reason.
    public static var namespace: String { "native_project_workspace" }

    public static func key(projectID: String) -> RecordKey {
        RecordKey(namespace: namespace, id: projectID)
    }

    private let repository: Repository
    private let maximumTransactionAttempts: Int

    public init(repository: Repository, maximumTransactionAttempts: Int = 4) {
        self.repository = repository
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
    }

    /// - Parameter knownProjectIDs: The projects this device has. Used only to
    ///   report orphans; nothing is deleted on the strength of it.
    public func load(
        accountID: StorageAccountID,
        knownProjectIDs: Set<String> = []
    ) async throws -> ProjectWorkspaceSnapshot {
        let snapshot = try await repository.snapshot(for: accountID)
        var workspaces: [String: ProjectWorkspaceConfiguration] = [:]
        var orphans: Set<String> = []

        for record in snapshot.records.values
        where !record.isTombstone && record.key.namespace == Self.namespace {
            let workspace = try decode(record)
            workspaces[workspace.projectID] = workspace
            if !knownProjectIDs.isEmpty, !knownProjectIDs.contains(workspace.projectID) {
                orphans.insert(workspace.projectID)
            }
        }

        return ProjectWorkspaceSnapshot(workspaces: workspaces, orphanedProjectIDs: orphans)
    }

    public func save(
        _ workspace: ProjectWorkspaceConfiguration,
        accountID: StorageAccountID
    ) async throws {
        try Self.validate(workspace)
        let payload = try JSONEncoder().encode(WorkspaceWire(workspace))
        try await write(
            key: Self.key(projectID: workspace.projectID),
            accountID: accountID,
            updatedAt: workspace.updatedAt,
            payload: payload
        )
    }

    /// Forgets one assistant's local setup. The project itself is untouched —
    /// deleting a persona must not delete the conversations filed under it.
    public func delete(projectID: String, accountID: StorageAccountID) async throws {
        guard !projectID.isEmpty else { throw ProjectWorkspaceStoreError.invalidProjectID }
        try await write(
            key: Self.key(projectID: projectID),
            accountID: accountID,
            updatedAt: Date(),
            payload: nil
        )
    }

    /// Compare-and-set against the store version, retried a few times.
    ///
    /// The same shape as `NativeMemorySettingsStore.persistSummary`, and for the
    /// same reason: two screens can be editing two different assistants at once,
    /// and a blind write would take the whole account snapshot's version with it
    /// and lose the other edit. Retrying re-reads first, so the loser of a race
    /// re-applies rather than overwrites.
    private func write(
        key: RecordKey,
        accountID: StorageAccountID,
        updatedAt: Date,
        payload: Data?
    ) async throws {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            let operation: StorageOperation
            if let payload {
                let previous = snapshot.records[key]?.revision ?? 0
                guard previous < UInt64.max else {
                    throw ProjectWorkspaceStoreError.concurrentWriteLimitExceeded
                }
                operation = .upsert(StoredRecord(
                    accountID: accountID,
                    key: key,
                    revision: previous + 1,
                    updatedAt: updatedAt,
                    payload: payload
                ))
            } else {
                operation = .remove(key)
            }
            do {
                _ = try await repository.apply(StorageTransaction(
                    accountID: accountID,
                    expectedStoreVersion: snapshot.version,
                    operations: [operation]
                ))
                return
            } catch AccountStorageError.versionConflict
                where attempt + 1 < maximumTransactionAttempts
            {
                continue
            } catch AccountStorageError.versionConflict {
                throw ProjectWorkspaceStoreError.concurrentWriteLimitExceeded
            }
        }
        throw ProjectWorkspaceStoreError.concurrentWriteLimitExceeded
    }

    static func validate(_ workspace: ProjectWorkspaceConfiguration) throws {
        guard !workspace.projectID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            workspace.projectID.utf8.count <= 512
        else { throw ProjectWorkspaceStoreError.invalidProjectID }
        if let name = workspace.personaName,
            name.count > ProjectWorkspaceConfiguration.maximumPersonaNameCharacters
        { throw ProjectWorkspaceStoreError.invalidPersonaName }
        if let instructions = workspace.instructionsOverride,
            instructions.count > ProjectWorkspaceConfiguration.maximumInstructionCharacters
        { throw ProjectWorkspaceStoreError.invalidInstructions }
    }

    /// Decoding is strict about identity and lenient about vocabulary.
    ///
    /// A record whose id disagrees with its key is corrupt and says so. A record
    /// naming a tool this build has never heard of is a **newer** Juno's
    /// workspace, and dropping the unknown name while keeping the rest is what
    /// stops an upgrade-then-downgrade from erasing a reader's whitelist. The
    /// restriction itself survives; only the unrecognised entry is lost, and the
    /// next save from the newer build restores it.
    private func decode(_ record: StoredRecord) throws -> ProjectWorkspaceConfiguration {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(WorkspaceWire.self, from: payload),
            wire.projectId == record.key.id,
            let updatedAt = ProjectWorkspaceDates.parse(wire.updatedAt)
        else { throw ProjectWorkspaceStoreError.corruptRecord(record.key) }

        let access: ProjectWorkspaceToolAccess
        if let allowed = wire.allowedTools {
            access = .restricted(Set(allowed.compactMap(ProjectWorkspaceTool.init(rawValue:))))
        } else {
            // Absent, not empty: this workspace has never been restricted.
            access = .inheritsAccountDefaults
        }

        return ProjectWorkspaceConfiguration(
            projectID: wire.projectId,
            personaName: wire.personaName,
            instructionsOverride: wire.instructionsOverride,
            toolAccess: access,
            allowedConnectorIDs: wire.allowedConnectorIds.map(Set.init),
            knowledgeFileIDs: wire.knowledgeFileIds ?? [],
            preferredModelID: wire.preferredModelId,
            updatedAt: updatedAt
        )
    }

}

// MARK: - Synced store

/// The account-synced transport for project assistant configuration.
///
/// The older ``ProjectWorkspaceStore`` remains as a migration reader because
/// released builds wrote encrypted Mac-only records into
/// `native_project_workspace`. New writes go through the same durable mutation
/// outbox as projects and settings, and server rows arrive back through the
/// normal `project_workspace` sync namespace.
public actor SyncedProjectWorkspaceStore<Repository: AccountScopedRepository> {
    public static var namespace: String { "project_workspace" }

    private let repository: Repository
    private let outbox: any MutationOutboxRepository
    private let legacy: ProjectWorkspaceStore<Repository>

    public init(repository: Repository, outbox: any MutationOutboxRepository) {
        self.repository = repository
        self.outbox = outbox
        legacy = ProjectWorkspaceStore(repository: repository)
    }

    public func load(
        accountID: StorageAccountID,
        knownProjectIDs: Set<String> = []
    ) async throws -> ProjectWorkspaceSnapshot {
        let snapshot = try await repository.snapshot(for: accountID)
        var workspaces: [String: ProjectWorkspaceConfiguration] = [:]
        var entityIDs: [String: String] = [:]

        for record in snapshot.records.values
        where !record.isTombstone && record.key.namespace == Self.namespace {
            let decoded = try decode(record)
            workspaces[decoded.workspace.projectID] = decoded.workspace
            entityIDs[decoded.workspace.projectID] = record.key.id
        }

        let legacySnapshot = try await legacy.load(
            accountID: accountID,
            knownProjectIDs: knownProjectIDs
        )
        var legacyProjectIDs: Set<String> = []
        for (projectID, workspace) in legacySnapshot.workspaces
        where workspaces[projectID] == nil {
            workspaces[projectID] = workspace
            legacyProjectIDs.insert(projectID)
        }

        let mutations = try await outbox.mutations(accountID: accountID)
        for mutation in mutations where mutation.draft.entity.namespace == Self.namespace {
            switch mutation.state {
            case .acknowledged, .discarded:
                continue
            default:
                break
            }
            try apply(mutation, workspaces: &workspaces, entityIDs: entityIDs)
        }

        let orphans = knownProjectIDs.isEmpty
            ? Set<String>()
            : Set(workspaces.keys).subtracting(knownProjectIDs)
        return ProjectWorkspaceSnapshot(
            workspaces: workspaces,
            orphanedProjectIDs: orphans,
            legacyProjectIDs: legacyProjectIDs
        )
    }

    public func save(
        _ workspace: ProjectWorkspaceConfiguration,
        accountID: StorageAccountID
    ) async throws {
        try ProjectWorkspaceStore<Repository>.validate(workspace)
        let entityID = try await syncedEntityID(
            projectID: workspace.projectID,
            accountID: accountID
        ) ?? workspace.projectID
        let object: [String: Any] = [
            "type": "project_workspace.upsert",
            "projectId": workspace.projectID,
            "config": configObject(workspace),
        ]
        try await enqueue(
            operation: "project_workspace.upsert",
            entityID: entityID,
            object: object,
            accountID: accountID
        )
    }

    public func delete(projectID: String, accountID: StorageAccountID) async throws {
        guard !projectID.isEmpty else { throw ProjectWorkspaceStoreError.invalidProjectID }
        let entityID = try await syncedEntityID(
            projectID: projectID,
            accountID: accountID
        ) ?? projectID
        try await enqueue(
            operation: "project_workspace.delete",
            entityID: entityID,
            object: ["type": "project_workspace.delete", "entityId": entityID],
            accountID: accountID
        )
    }

    private func enqueue(
        operation: String,
        entityID: String,
        object: [String: Any],
        accountID: StorageAccountID
    ) async throws {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw ProjectWorkspaceStoreError.invalidProjectID
        }
        let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        _ = try await outbox.enqueue(MutationDraft(
            id: OutboxMutationID(UUID().uuidString.lowercased()),
            accountID: accountID,
            idempotencyKey: IdempotencyKey(UUID().uuidString.lowercased()),
            entity: RecordKey(namespace: Self.namespace, id: entityID),
            operation: operation,
            payload: payload,
            createdAt: Date()
        ))
    }

    private func syncedEntityID(
        projectID: String,
        accountID: StorageAccountID
    ) async throws -> String? {
        let snapshot = try await repository.snapshot(for: accountID)
        for record in snapshot.records.values
        where !record.isTombstone && record.key.namespace == Self.namespace {
            if let decoded = try? decode(record), decoded.workspace.projectID == projectID {
                return record.key.id
            }
        }
        return nil
    }

    private func configObject(_ workspace: ProjectWorkspaceConfiguration) -> [String: Any] {
        var config: [String: Any] = [:]
        if let personaName = workspace.personaName { config["personaName"] = personaName }
        if let instructions = workspace.instructionsOverride {
            config["instructionsOverride"] = instructions
        }
        switch workspace.toolAccess {
        case .inheritsAccountDefaults:
            break
        case .restricted(let tools):
            config["allowedTools"] = tools.map(\.rawValue).sorted()
        }
        if let connectors = workspace.allowedConnectorIDs {
            config["allowedConnectorIds"] = connectors.sorted()
        }
        if !workspace.knowledgeFileIDs.isEmpty {
            config["knowledgeFileIds"] = workspace.knowledgeFileIDs
        }
        if let preferredModelID = workspace.preferredModelID {
            config["preferredModelId"] = preferredModelID
        }
        return config
    }

    private func apply(
        _ mutation: QueuedMutation,
        workspaces: inout [String: ProjectWorkspaceConfiguration],
        entityIDs: [String: String]
    ) throws {
        guard let object = try JSONSerialization.jsonObject(with: mutation.draft.payload)
                as? [String: Any],
            object["type"] as? String == mutation.draft.operation
        else { throw ProjectWorkspaceStoreError.invalidProjectID }

        switch mutation.draft.operation {
        case "project_workspace.upsert":
            guard let projectID = object["projectId"] as? String,
                let config = object["config"] as? [String: Any]
            else { throw ProjectWorkspaceStoreError.invalidProjectID }
            workspaces[projectID] = decodeConfig(
                projectID: projectID,
                config: config,
                updatedAt: mutation.draft.createdAt
            )
        case "project_workspace.delete":
            let entityID = object["entityId"] as? String ?? mutation.draft.entity.id
            if let projectID = entityIDs.first(where: { $0.value == entityID })?.key {
                workspaces[projectID] = nil
            } else {
                // New rows use the project id as their mutation identity until
                // the first sync response supplies the server row id.
                workspaces[entityID] = nil
            }
        default:
            break
        }
    }

    private func decode(_ record: StoredRecord) throws
        -> (workspace: ProjectWorkspaceConfiguration, entityID: String)
    {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(SyncedWorkspaceWire.self, from: payload),
            wire.id == record.key.id,
            let updatedAt = ProjectWorkspaceDates.parse(wire.updatedAt)
        else { throw ProjectWorkspaceStoreError.corruptRecord(record.key) }
        return (
            decodeConfig(projectID: wire.projectId, config: wire.config.dictionary, updatedAt: updatedAt),
            wire.id
        )
    }

    private func decodeConfig(
        projectID: String,
        config: [String: Any],
        updatedAt: Date
    ) -> ProjectWorkspaceConfiguration {
        let allowedTools = config["allowedTools"] as? [String]
        let toolAccess: ProjectWorkspaceToolAccess = allowedTools.map {
            .restricted(Set($0.compactMap(ProjectWorkspaceTool.init(rawValue:))))
        } ?? .inheritsAccountDefaults
        return ProjectWorkspaceConfiguration(
            projectID: projectID,
            personaName: config["personaName"] as? String,
            instructionsOverride: config["instructionsOverride"] as? String,
            toolAccess: toolAccess,
            allowedConnectorIDs: (config["allowedConnectorIds"] as? [String]).map(Set.init),
            knowledgeFileIDs: config["knowledgeFileIds"] as? [String] ?? [],
            preferredModelID: config["preferredModelId"] as? String,
            updatedAt: updatedAt
        )
    }
}

private struct SyncedWorkspaceWire: Decodable {
    let id: String
    let projectId: String
    let config: SyncedWorkspaceConfigWire
    let configVersion: Int
    let createdAt: String
    let updatedAt: String
}

private struct SyncedWorkspaceConfigWire: Decodable {
    let personaName: String?
    let instructionsOverride: String?
    let allowedTools: [String]?
    let allowedConnectorIds: [String]?
    let knowledgeFileIds: [String]?
    let preferredModelId: String?

    var dictionary: [String: Any] {
        var value: [String: Any] = [:]
        if let personaName { value["personaName"] = personaName }
        if let instructionsOverride { value["instructionsOverride"] = instructionsOverride }
        if let allowedTools { value["allowedTools"] = allowedTools }
        if let allowedConnectorIds { value["allowedConnectorIds"] = allowedConnectorIds }
        if let knowledgeFileIds { value["knowledgeFileIds"] = knowledgeFileIds }
        if let preferredModelId { value["preferredModelId"] = preferredModelId }
        return value
    }
}

/// ISO-8601 both ways, generic-free.
///
/// Free of the store's `Repository` parameter on purpose: the wire struct below
/// needs to format a date, and reaching it through `ProjectWorkspaceStore<Some>`
/// would force an unrelated concrete repository to be named just to call a date
/// formatter.
enum ProjectWorkspaceDates {
    static func parse(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// The on-disk shape.
///
/// Every optional is encoded only when it is set, so "never configured" stays
/// distinguishable from "configured to nothing" across a round trip — the
/// distinction the whole tri-state design rests on, and the one a synthesized
/// encoder writing `null`s would quietly keep but a future reader defaulting
/// them would quietly lose.
private struct WorkspaceWire: Codable {
    let projectId: String
    let personaName: String?
    let instructionsOverride: String?
    /// Nil ⇒ ``ProjectWorkspaceToolAccess/inheritsAccountDefaults``.
    /// `[]` ⇒ restricted to nothing.
    let allowedTools: [String]?
    let allowedConnectorIds: [String]?
    let knowledgeFileIds: [String]?
    let preferredModelId: String?
    let updatedAt: String

    init(_ workspace: ProjectWorkspaceConfiguration) {
        projectId = workspace.projectID
        personaName = workspace.personaName
        instructionsOverride = workspace.instructionsOverride
        switch workspace.toolAccess {
        case .inheritsAccountDefaults:
            allowedTools = nil
        case .restricted(let tools):
            // Sorted so an unchanged workspace encodes byte-identically twice —
            // a `Set`'s iteration order is not stable, and an unstable payload
            // makes every save look like a change to anything comparing bytes.
            allowedTools = tools.map(\.rawValue).sorted()
        }
        allowedConnectorIds = workspace.allowedConnectorIDs.map { $0.sorted() }
        knowledgeFileIds = workspace.knowledgeFileIDs.isEmpty
            ? nil : workspace.knowledgeFileIDs
        preferredModelId = workspace.preferredModelID
        updatedAt = ProjectWorkspaceDates.format(workspace.updatedAt)
    }
}

// MARK: - Model

/// The sidebar's view of every custom assistant, and the one that is switched on.
///
/// Reads the projects from ``NativeProjectModel`` rather than re-loading them:
/// there is exactly one list of projects on this account and a second copy would
/// drift the moment a rename synced. What this owns is the *selection* and the
/// local configuration, which nothing else does.
@MainActor
@Observable
public final class ProjectWorkspaceModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var workspaces: [String: ProjectWorkspaceConfiguration] = [:]
    public private(set) var orphanedProjectIDs: Set<String> = []
    public private(set) var lastErrorDescription: String?
    public private(set) var isSaving = false

    /// The assistant a new conversation opens under. Nil is "plain Juno", which
    /// is a real choice and the default — auto-selecting the first project would
    /// silently put every new chat inside somebody's persona.
    public private(set) var activeProjectID: String?

    private let store: ProjectWorkspaceStore<Repository>
    private let syncedStore: SyncedProjectWorkspaceStore<Repository>?
    private let drainer: NativeMutationDrainer<Repository>?
    private let syncModel: NativeSyncModel<Repository>?
    private var accountID: AccountID?
    private var lastKnownProjectIDs: Set<String> = []
    private var lastSynchronizationGeneration = -1
    private var isReconciling = false

    public init(repository: Repository) {
        store = ProjectWorkspaceStore(repository: repository)
        syncedStore = nil
        drainer = nil
        syncModel = nil
    }

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        drainer: NativeMutationDrainer<Repository>,
        syncModel: NativeSyncModel<Repository>
    ) {
        store = ProjectWorkspaceStore(repository: repository)
        syncedStore = SyncedProjectWorkspaceStore(repository: repository, outbox: outbox)
        self.drainer = drainer
        self.syncModel = syncModel
    }

    public var activeWorkspace: ProjectWorkspaceConfiguration? {
        activeProjectID.flatMap { workspaces[$0] }
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await reload()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await reload()
        await migrateLegacyWorkspacesIfNeeded()
        await reconcilePendingMutations()
    }

    public func stop() {
        accountID = nil
        workspaces = [:]
        orphanedProjectIDs = []
        activeProjectID = nil
        lastErrorDescription = nil
        isSaving = false
        lastKnownProjectIDs = []
        lastSynchronizationGeneration = -1
        isReconciling = false
        phase = .idle
    }

    public func synchronizationDidAdvance(to generation: Int) async {
        guard generation != lastSynchronizationGeneration else { return }
        lastSynchronizationGeneration = generation
        await reload(knownProjectIDs: lastKnownProjectIDs)
        await reconcilePendingMutations()
    }

    /// - Parameter knownProjectIDs: The projects currently loaded, so orphans can
    ///   be reported. Empty means "don't know yet", and reports none — which is
    ///   why it is not the same as passing the empty set deliberately.
    public func reload(knownProjectIDs: Set<String> = []) async {
        guard let accountID else { return }
        if !knownProjectIDs.isEmpty { lastKnownProjectIDs = knownProjectIDs }
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            let effectiveKnownIDs = knownProjectIDs.isEmpty
                ? lastKnownProjectIDs : knownProjectIDs
            let snapshot: ProjectWorkspaceSnapshot
            if let syncedStore {
                snapshot = try await syncedStore.load(
                    accountID: storageAccountID,
                    knownProjectIDs: effectiveKnownIDs
                )
            } else {
                snapshot = try await store.load(
                    accountID: storageAccountID,
                    knownProjectIDs: effectiveKnownIDs
                )
            }
            guard self.accountID == accountID else { return }
            workspaces = snapshot.workspaces
            orphanedProjectIDs = snapshot.orphanedProjectIDs
            // A selection that no longer resolves is dropped; an absent one stays
            // absent. Matching ``NativeProjectModel/reload()``, which learned this
            // the hard way — auto-selecting on reload opened the top favourite
            // every time the list refreshed.
            if let activeProjectID, workspaces[activeProjectID] == nil,
                !knownProjectIDs.contains(activeProjectID)
            { self.activeProjectID = nil }
            lastErrorDescription = nil
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = .failed
        }
    }

    /// Switches the sidebar to an assistant. Nil returns to plain Juno.
    public func select(projectID: String?) {
        activeProjectID = projectID
    }

    /// Creates or replaces one assistant's local setup.
    @discardableResult
    public func save(_ workspace: ProjectWorkspaceConfiguration) async -> Bool {
        guard let accountID else { return false }
        isSaving = true
        defer { isSaving = false }
        var stamped = workspace
        stamped.updatedAt = Date()
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            if let syncedStore {
                try await syncedStore.save(stamped, accountID: storageAccountID)
            } else {
                try await store.save(stamped, accountID: storageAccountID)
            }
            guard self.accountID == accountID else { return false }
            workspaces[stamped.projectID] = stamped
            lastErrorDescription = nil
            await reconcilePendingMutations()
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            return false
        }
    }

    /// Edits one field of an existing assistant without the caller having to
    /// reconstruct the whole configuration — the shape every toggle in the UI
    /// wants. A workspace that does not exist yet is created with defaults, so
    /// the first flip of the first switch works.
    @discardableResult
    public func update(
        projectID: String,
        _ edit: (inout ProjectWorkspaceConfiguration) -> Void
    ) async -> Bool {
        var workspace = workspaces[projectID]
            ?? ProjectWorkspaceConfiguration(projectID: projectID)
        edit(&workspace)
        return await save(workspace)
    }

    public func delete(projectID: String) async {
        guard let accountID else { return }
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            if let syncedStore {
                try await syncedStore.delete(projectID: projectID, accountID: storageAccountID)
            } else {
                try await store.delete(projectID: projectID, accountID: storageAccountID)
            }
            guard self.accountID == accountID else { return }
            workspaces[projectID] = nil
            orphanedProjectIDs.remove(projectID)
            if activeProjectID == projectID { activeProjectID = nil }
            await reconcilePendingMutations()
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// The permissions one turn should actually be sent with.
    ///
    /// Plain Juno — no active assistant — is unrestricted, which is why this
    /// returns the request untouched rather than an empty set of permissions
    /// when nothing is selected.
    public func permitting(
        _ requested: ProjectWorkspaceTurnPermissions
    ) -> ProjectWorkspaceTurnPermissions {
        activeWorkspace?.permitting(requested) ?? requested
    }

    private func migrateLegacyWorkspacesIfNeeded() async {
        guard let accountID, let syncedStore else { return }
        let storageAccountID = StorageAccountID(accountID.rawValue)
        do {
            let snapshot = try await syncedStore.load(
                accountID: storageAccountID,
                knownProjectIDs: lastKnownProjectIDs
            )
            for projectID in snapshot.legacyProjectIDs {
                guard let workspace = snapshot.workspaces[projectID] else { continue }
                try await syncedStore.save(workspace, accountID: storageAccountID)
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    private func reconcilePendingMutations() async {
        guard !isReconciling, let accountID, let drainer else { return }
        isReconciling = true
        defer { isReconciling = false }
        do {
            let result = try await drainer.drain(for: accountID, owner: "project-workspace-ui")
            if result.acknowledged > 0 { await syncModel?.refresh() }
            await reload(knownProjectIDs: lastKnownProjectIDs)
            if result.retryScheduled > 0 {
                lastErrorDescription = "Assistant changes are saved and will sync when Juno reconnects."
            } else if result.conflicted > 0 {
                lastErrorDescription = "This assistant changed on another device. Refresh before retrying."
                phase = .failed
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            if syncModel?.phase == .offline { phase = .failed }
        }
    }
}
