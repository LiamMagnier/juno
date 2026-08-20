#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoStorage
import JunoSync
import JunoWorkKit
import Observation

/// Builds the **real** production models over an isolated, in-memory-only
/// SQLite repository seeded with synthetic fixtures, wired to a no-network
/// ``PreviewSender``. Nothing here reads a token, the production Keychain, the
/// production database, or the network — it exists only so the real screens can
/// be inspected locally under `--juno-ui-preview`.
@MainActor
@Observable
public final class PreviewWorld {
    public private(set) var scenario: PreviewScenario
    public let session: NativeAuthenticatedSession
    public let accountID: AccountID
    public let conversationModel: NativeConversationModel<SQLiteAccountRepository>
    public let projectModel: NativeProjectModel<SQLiteAccountRepository>
    public let artifactModel: NativeArtifactModel<SQLiteAccountRepository>
    public let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>
    public let searchModel: NativeSearchModel<SQLiteAccountRepository>
    /// The in-memory incognito session. Present in the harness so the ghost and
    /// the mode it opens are inspectable without a real account.
    public let privateChatModel: NativePrivateChatModel
    /// Present so the composer's Attach section renders in the harness. It is
    /// hidden entirely when no model is supplied, which is correct in the app
    /// but made the section invisible to visual QA.
    public let attachmentModel: NativeComposerAttachmentModel
    /// The no-network transport handed to the macOS Juno Code surface.
    public let chatTransport: any NativeChatRequestSending
    /// Present so Settings' Danger zone renders in the harness. The tile is
    /// hidden without a client — correct in an unconfigured app, but it meant the
    /// one tile that cannot be reached by tapping was also the one tile visual QA
    /// could never see. Every call goes to the no-network `PreviewSender`.
    public let accountDataClient: NativeAccountDataClient
    /// Present so the composer's "From your library" row exists in the harness.
    /// The row is hidden entirely when no model is supplied — correct in the app,
    /// but it made the whole path invisible to visual QA and to the UI tests.
    public let libraryModel: NativeLibraryModel
    public let connectorModel: NativeConnectorModel
    public let scheduledTaskModel: NativeScheduledTaskModel

    /// The no-network sync model; exposed so the chat toolbar's sync indicator
    /// renders in preview.
    public let syncModel: NativeSyncModel<SQLiteAccountRepository>

    /// Juno Work, over the same no-network sender.
    ///
    /// Work has no local store — it is a relay-backed product — so unlike every
    /// model above it is not seeded from the repository. Its fixtures are served
    /// by ``PreviewSender`` in the wire shape, which means the harness exercises
    /// `NativeWorkClient`'s real decoders and a screenshot is also evidence the
    /// decode path works.
    public let workModel: NativeWorkModel

    /// Juno Code, over the same no-network sender.
    ///
    /// Relay-backed like Work, and seeded the same way: ``PreviewCodeFixtures``
    /// answers `/api/code/*` in the wire shape so the harness runs
    /// `NativeCodeTaskClient`'s real decoders. Built here rather than left nil
    /// because the phone's Code screen renders the shell's "Something went
    /// wrong" placeholder without a model — which is what it had always done.
    public let codeModel: NativeCodeModel

    private let repository: SQLiteAccountRepository
    private let outbox: InMemoryMutationOutbox
    private let sender: PreviewSender
    /// A stable dev key — never a real account key. In-memory database only.
    static let developmentKey = Data(repeating: 0x7A, count: 32)
    private var activated = false

    /// The throwaway temp database path — asserted in tests to prove no
    /// production store is opened.
    public nonisolated var previewDatabasePath: String { repository.databaseURL.path }

    public init(scenario: PreviewScenario) throws {
        self.scenario = scenario
        let account = try AccountID("preview-account")
        accountID = account
        session = NativeAuthenticatedSession(
            profile: NativeAccountProfile(
                id: account,
                name: "Preview User",
                email: "preview@juno.local",
                imageURL: nil
            ),
            deviceID: try DeviceID("preview-device")
        )
        // A private temporary database that is deleted-on-next-boot territory —
        // never the production `accounts.sqlite3`.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("juno-ui-preview-\(UUID().uuidString).sqlite3")
        repository = try SQLiteAccountRepository(
            databaseURL: url,
            cipher: try AESGCMAccountDataCipher(keyData: Self.developmentKey)
        )
        sender = PreviewSender(networkFails: scenario.networkFails, empty: scenario == .empty)
        chatTransport = sender
        workModel = NativeWorkModel(client: NativeWorkClient(sender: sender, streamer: sender))
        codeModel = NativeCodeModel(
            client: NativeCodeTaskClient(sender: sender, streamer: sender)
        )
        attachmentModel = NativeComposerAttachmentModel(
            client: NativeAttachmentAPIClient(sender: sender)
        )
        outbox = InMemoryMutationOutbox()
        let coordinator = NativeSyncCoordinator(repository: repository, sender: sender)
        syncModel = NativeSyncModel(
            coordinator: coordinator,
            monitor: NativeSyncMonitor(coordinator: coordinator, streamer: sender)
        )
        let drainer = NativeMutationDrainer(
            repository: repository,
            outbox: outbox,
            sender: sender
        )
        conversationModel = NativeConversationModel(
            repository: repository,
            outbox: outbox,
            drainer: drainer,
            syncModel: syncModel,
            chatClient: NativeChatAPIClient(transport: sender)
        )
        projectModel = NativeProjectModel(
            repository: repository,
            outbox: outbox,
            drainer: drainer,
            syncModel: syncModel,
            sender: sender
        )
        artifactModel = NativeArtifactModel(
            repository: repository,
            syncModel: syncModel,
            sender: sender
        )
        memorySettingsModel = NativeMemorySettingsModel(
            repository: repository,
            outbox: outbox,
            drainer: drainer,
            syncModel: syncModel,
            sender: sender
        )
        searchModel = NativeSearchModel(repository: repository)
        privateChatModel = NativePrivateChatModel(
            client: NativeChatAPIClient(transport: sender)
        )
        libraryModel = NativeLibraryModel(
            client: NativeLibraryClient(sender: sender),
            previewSource: NativeProjectAPIClient(sender: sender)
        )
        connectorModel = NativeConnectorModel(
            client: NativeConnectorClient(sender: sender)
        )
        scheduledTaskModel = NativeScheduledTaskModel(
            client: NativeScheduledTaskClient(sender: sender)
        )
        accountDataClient = NativeAccountDataClient(sender: sender)
    }

    /// Seeds fixtures and starts the real models. For the "loading" scenario it
    /// deliberately leaves the models un-started so their loading state shows.
    public func activate() async {
        guard !activated else { return }
        activated = true

        await seedRepository()
        await seedOutbox()

        guard scenario != .loading else { return }

        if scenario.isOffline {
            syncModel.previewConfigure(phase: .offline, errorDescription: "You’re offline.")
        } else {
            syncModel.previewConfigure(phase: .live)
        }

        await conversationModel.start(for: accountID)
        await projectModel.start(for: accountID)
        await artifactModel.start(for: accountID)
        await memorySettingsModel.start(for: accountID)
        searchModel.start(for: accountID)
        privateChatModel.start(for: accountID)
        libraryModel.start(for: accountID)
        await connectorModel.start(for: accountID)
        await scheduledTaskModel.start(for: accountID)
        await workModel.start(for: accountID)
        await codeModel.start(for: accountID)

        // Juno Code opens on its session list, because that is where a reader
        // arrives. A single session is one relaunch away with
        // `--juno-preview-code-session <id>` — the log has four states worth
        // looking at (running, blocked on an approval, finished with a diff,
        // failed) and nothing in the list distinguishes them from outside.
        if let id = JunoPreviewEnvironment.initialCodeSession,
            let task = codeModel.tasks.first(where: { $0.id == id }) {
            codeModel.open(task)
        }

        // Open the task the Work screenshots are of. Without this the thread is
        // the "no task selected" placeholder, which is a state worth capturing
        // but not the one anybody reaching for `--juno-preview-tab work` is
        // after. The view's own scene storage still wins if a previous launch
        // left a selection behind.
        //
        // `--juno-preview-work-overview` suppresses it, because the placeholder
        // is Work's *home* — the landing page somebody sees before they pick a
        // task — and it was the one surface in the product with no reachable
        // launch. Opening a task is the only way in, and once a task is open
        // nothing in the window closes it again, so the page could be redesigned
        // but never looked at.
        if !JunoPreviewEnvironment.opensWorkOverview,
            let session = workModel.sessions.first(where: {
                $0.sessionID == PreviewWorkFixtures.openSessionID
            })
        {
            workModel.open(session)
        }

        // Select a conversation so the chat destination shows a real transcript
        // rather than the empty state during QA.
        if conversationModel.selectedConversationID == nil {
            conversationModel.selectedConversationID =
                conversationModel.conversations.first(where: { !$0.isArchived })?.id
        }
    }

    private func seedRepository() async {
        let storageAccount = StorageAccountID(accountID.rawValue)
        let records = PreviewFixtures.records(for: scenario, accountID: storageAccount)
        guard !records.isEmpty else { return }
        _ = try? await repository.apply(StorageTransaction(
            accountID: storageAccount,
            operations: records.map { .upsert($0) }
        ))
    }

    private func seedOutbox() async {
        let storageAccount = StorageAccountID(accountID.rawValue)
        let now = Date()
        switch scenario {
        case .conflict:
            // A conflicted rename of conv-1 → the conflict banner + resolution.
            let draft = mutation(
                storageAccount, id: "conflict-1",
                namespace: "conversation", entityID: "conv-1",
                operation: "conversation.rename",
                body: #"{"type":"conversation.rename","entityId":"conv-1","title":"Renamed locally"}"#
            )
            _ = try? await outbox.enqueue(draft)
            _ = try? await outbox.lease(
                accountID: storageAccount, owner: "preview", token: "t",
                now: now, duration: 60, limit: 5
            )
            try? await outbox.markConflict(
                id: draft.id, accountID: storageAccount, owner: "preview", token: "t",
                now: now, localRevision: 5, serverRevision: 6, reason: "revision_conflict"
            )
        case .mutating:
            // A long-leased (in-flight) update so an item reads as pending
            // without the drain acknowledging it.
            let draft = mutation(
                storageAccount, id: "mutating-1",
                namespace: "project", entityID: "proj-1",
                operation: "project.update",
                body: #"{"type":"project.update","entityId":"proj-1","name":"Astro research"}"#
            )
            _ = try? await outbox.enqueue(draft)
            _ = try? await outbox.lease(
                accountID: storageAccount, owner: "preview", token: "t",
                now: now, duration: 3600, limit: 5
            )
        default:
            break
        }
    }

    private func mutation(
        _ accountID: StorageAccountID,
        id: String,
        namespace: String,
        entityID: String,
        operation: String,
        body: String
    ) -> MutationDraft {
        MutationDraft(
            id: OutboxMutationID(id),
            accountID: accountID,
            idempotencyKey: IdempotencyKey(UUID().uuidString.lowercased()),
            entity: RecordKey(namespace: namespace, id: entityID),
            operation: operation,
            payload: Data(body.utf8),
            createdAt: Date()
        )
    }
}
#endif
