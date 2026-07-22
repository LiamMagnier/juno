#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoStorage
import JunoSync
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
    /// The no-network transport handed to the macOS Juno Code surface.
    public let chatTransport: any NativeChatRequestSending

    /// The no-network sync model; exposed so the chat toolbar's sync indicator
    /// renders in preview.
    public let syncModel: NativeSyncModel<SQLiteAccountRepository>

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
        sender = PreviewSender(networkFails: scenario.networkFails)
        chatTransport = sender
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
