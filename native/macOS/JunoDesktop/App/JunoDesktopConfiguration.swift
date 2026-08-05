import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoStorage
import JunoSync
import JunoWorkKit

@MainActor
struct JunoDesktopConfiguration {
    let authModel: NativeAuthModel
    let runtime: NativeAuthRuntime?
    let localStore: SQLiteAccountRepository?
    let syncModel: NativeSyncModel<SQLiteAccountRepository>?
    let outbox: (any MutationOutboxRepository)?
    let attachmentModel: NativeComposerAttachmentModel?
    let avatarModel: NativeAvatarModel?
    let conversationModel: NativeConversationModel<SQLiteAccountRepository>?
    let privateChatModel: NativePrivateChatModel?
    /// `/api/generate`, for editing an image the account already has. The same
    /// endpoint a fresh generation uses; the `edit` payload is what makes it an
    /// edit, so there is nothing separate to construct.
    let generateClient: NativeChatAPIClient?
    let projectModel: NativeProjectModel<SQLiteAccountRepository>?
    let artifactModel: NativeArtifactModel<SQLiteAccountRepository>?
    let memorySettingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let searchModel: NativeSearchModel<SQLiteAccountRepository>?
    let connectorModel: NativeConnectorModel?
    let scheduledTaskModel: NativeScheduledTaskModel?
    let codeModel: NativeCodeModel?
    let remoteCodeModel: CodeRemoteBrowserModel?
    /// The other direction: what makes this Mac appear in the phone's Juno Code
    /// picker at all. Its own client instance rather than `codeModel`'s, because
    /// the two are unrelated jobs sharing one surface — one reads the account's
    /// tasks, the other writes this machine's heartbeat.
    let codeHostModel: DesktopCodeHostModel?
    /// The account's Work tasks, as this Mac reads them.
    let workModel: NativeWorkModel?
    /// The other direction, mirroring `codeHostModel`: whether this Mac serves
    /// Juno Work, and on what terms. Separate from `workModel` for the same
    /// reason Code keeps its two apart — one reads the account's tasks, the
    /// other is this machine's standing decision about itself, and folding them
    /// together is how signing in comes to imply consent.
    let workHostModel: DesktopWorkHostModel?
    let libraryModel: NativeLibraryModel?
    let requestSender: (any NativeAuthenticatedRequestSending)?
    let accountDataClient: NativeAccountDataClient?
    let voiceTranscriptClient: NativeVoiceTranscriptClient?
    let messageActionsClient: NativeMessageActionsClient?
    /// Suggests what to ask next, under a finished reply.
    let followUpClient: NativeFollowUpClient?
    /// The pull requests Juno Code opened.
    let pullsClient: NativeGitHubPullsClient?
    /// Publishes a conversation behind an unguessable link.
    let shareClient: NativeShareClient?
    /// Non-nil only when the app failed to start because this build cannot
    /// unlock the local database — the one launch failure the user can act on
    /// themselves, offered on the sign-in card.
    ///
    /// Defaulted, and therefore a `var` among lets, so that the composition
    /// roots which never fail this way — the DEBUG preview harness — do not have
    /// to name a dependency that only exists to describe a broken launch.
    var localStoreRecovery: JunoDesktopLocalStoreRecovery? = nil

    static func live() -> Self {
        let storeURL: URL
        do {
            storeURL = try localStoreURL()
        } catch {
            return unavailable(error.localizedDescription)
        }

        do {
            guard let backendURL = URL(string: JunoBackend.productionURLString) else {
                throw JunoDesktopConfigurationError.invalidBackendURL
            }

            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0"
            let device = try NativeDeviceMetadata(
                name: Host.current().localizedName ?? "Mac",
                platform: "macOS",
                appVersion: version
            )
            let storeFactory = NativeLocalAccountStoreFactory(
                databaseURL: storeURL
            )
            let localStore: SQLiteAccountRepository
            do {
                localStore = try storeFactory.openRepository()
            } catch NativeLocalAccountStoreFactoryError.missingEncryptionKey {
                // The desktop cache is recoverable without deleting it. This
                // can happen when a locally built app cannot read the
                // provisioned build's Keychain item. Archive the old bytes and
                // continue with a fresh cache so startup is not trapped on the
                // sign-in card; the server remains the source of truth after
                // the next successful sign-in.
                localStore = try storeFactory.recoverAndOpenRepository()
                    .repository
            }
            let runtime = try NativeAuthRuntime.live(
                origin: APIOrigin(backendURL),
                device: device,
                accountDataPurger: RepositoryAccountDataPurger(
                    repository: localStore
                )
            )
            let coordinator = NativeSyncCoordinator(
                repository: localStore,
                sender: runtime
            )
            let syncModel = NativeSyncModel(
                coordinator: coordinator,
                monitor: NativeSyncMonitor(
                    coordinator: coordinator,
                    streamer: runtime
                )
            )
            let outbox = PersistentMutationOutbox(repository: localStore)
            let drainer = NativeMutationDrainer(
                repository: localStore,
                outbox: outbox,
                sender: runtime
            )

            return Self(
                authModel: NativeAuthModel(
                    runtime: runtime,
                    browser: JunoDesktopWebAuthenticationClient()
                ),
                runtime: runtime,
                localStore: localStore,
                syncModel: syncModel,
                outbox: outbox,
                attachmentModel: NativeComposerAttachmentModel(
                    client: NativeAttachmentAPIClient(sender: runtime)
                ),
                avatarModel: NativeAvatarModel(sender: runtime),
                conversationModel: NativeConversationModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    chatClient: NativeChatAPIClient(transport: runtime),
                    titleClient: NativeConversationTitleClient(sender: runtime),
                    // The desktop now opens on the same empty Chat home as the
                    // website and phone. The sidebar still preserves every old
                    // conversation; it is simply not selected on launch.
                    opensMostRecentConversationOnLoad: false
                ),
                privateChatModel: NativePrivateChatModel(
                    client: NativeChatAPIClient(transport: runtime)
                ),
                generateClient: NativeChatAPIClient(transport: runtime),
                projectModel: NativeProjectModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    sender: runtime
                ),
                artifactModel: NativeArtifactModel(
                    repository: localStore,
                    syncModel: syncModel,
                    sender: runtime
                ),
                memorySettingsModel: NativeMemorySettingsModel(
                    repository: localStore,
                    outbox: outbox,
                    drainer: drainer,
                    syncModel: syncModel,
                    sender: runtime
                ),
                searchModel: NativeSearchModel(repository: localStore),
                connectorModel: NativeConnectorModel(
                    client: NativeConnectorClient(sender: runtime)
                ),
                scheduledTaskModel: NativeScheduledTaskModel(
                    client: NativeScheduledTaskClient(sender: runtime)
                ),
                codeModel: NativeCodeModel(
                    client: NativeCodeTaskClient(sender: runtime, streamer: runtime)
                ),
                remoteCodeModel: CodeRemoteBrowserModel(
                    client: NativeCodeRemoteClient(sender: runtime)
                ),
                codeHostModel: DesktopCodeHostModel(
                    client: NativeCodeTaskClient(sender: runtime, streamer: runtime),
                    // The claim loop's transport. Supplied here so hosting can
                    // start; the switch is what decides whether it does.
                    relay: NativeCodeRemoteClient(sender: runtime)
                ),
                workModel: NativeWorkModel(
                    client: NativeWorkClient(sender: runtime, streamer: runtime)
                ),
                // Constructed unconditionally, unlike the loop it drives: the
                // model has to exist for Settings to show the switch that is
                // off, and a nil model would render that surface as
                // unavailable rather than as switched off — two different
                // sentences with two different fixes.
                workHostModel: DesktopWorkHostModel(),
                libraryModel: NativeLibraryModel(
                    client: NativeLibraryClient(sender: runtime),
                    // The picker draws the file, which means resolving its
                    // bytes — the same route the Library screen already takes.
                    previewSource: NativeProjectAPIClient(sender: runtime)
                ),
                requestSender: runtime,
                accountDataClient: NativeAccountDataClient(sender: runtime),
                voiceTranscriptClient: NativeVoiceTranscriptClient(sender: runtime),
                messageActionsClient: NativeMessageActionsClient(sender: runtime),
                followUpClient: NativeFollowUpClient(sender: runtime),
                pullsClient: NativeGitHubPullsClient(sender: runtime),
                shareClient: NativeShareClient(sender: runtime),
                localStoreRecovery: nil
            )
        } catch NativeLocalAccountStoreFactoryError.missingEncryptionKey {
            // The only failure here with a way out the user can take, so it is
            // the only one that carries a recovery. Every other error either
            // fixes itself on the next launch or needs a new build; offering to
            // move someone's database aside would not help any of them.
            return unavailable(
                NativeLocalAccountStoreFactoryError.missingEncryptionKey
                    .localizedDescription,
                recovery: JunoDesktopLocalStoreRecovery(databaseURL: storeURL)
            )
        } catch {
            return unavailable(error.localizedDescription)
        }
    }

    private static func localStoreURL() throws -> URL {
        guard let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw JunoDesktopConfigurationError.applicationSupportUnavailable
        }
        return applicationSupport
            .appendingPathComponent("Juno", isDirectory: true)
            .appendingPathComponent("Desktop", isDirectory: true)
            .appendingPathComponent("accounts.sqlite3")
    }

    private static func unavailable(
        _ message: String,
        recovery: JunoDesktopLocalStoreRecovery? = nil
    ) -> Self {
        Self(
            authModel: NativeAuthModel(configurationErrorDescription: message),
            runtime: nil,
            localStore: nil,
            syncModel: nil,
            outbox: nil,
            attachmentModel: nil,
            avatarModel: nil,
            conversationModel: nil,
            privateChatModel: nil,
            generateClient: nil,
            projectModel: nil,
            artifactModel: nil,
            memorySettingsModel: nil,
            searchModel: nil,
            connectorModel: nil,
            scheduledTaskModel: nil,
            codeModel: nil,
            remoteCodeModel: nil,
            codeHostModel: nil,
            workModel: nil,
            workHostModel: nil,
            libraryModel: nil,
            requestSender: nil,
            accountDataClient: nil,
            voiceTranscriptClient: nil,
            messageActionsClient: nil,
            followUpClient: nil,
            pullsClient: nil,
            shareClient: nil,
            localStoreRecovery: recovery
        )
    }
}

/// The sign-in card's escape hatch from an unreadable local database.
///
/// The database is a cache of the account, not the account: `NativeSyncCoordinator`
/// installs a full bootstrap baseline whenever it finds no stored cursor, so
/// conversations, projects, artifacts, memories and settings all come back from
/// the server on the next sign-in. What does not come back is
/// ``PersistentMutationOutbox`` — the queue of edits made on this Mac that the
/// server has not acknowledged yet — which lives in the same file and is the only
/// thing here with no copy anywhere else. The UI says so; see
/// ``JunoDesktopRootView``.
@MainActor
@Observable
final class JunoDesktopLocalStoreRecovery {
    enum Phase: Equatable {
        case ready
        case running
        case failed(String)
    }

    private(set) var phase: Phase = .ready

    private let databaseURL: URL
    private let bundleURL: URL

    init(databaseURL: URL, bundleURL: URL = Bundle.main.bundleURL) {
        self.databaseURL = databaseURL
        self.bundleURL = bundleURL
    }

    /// Archives the unreadable database, proves a fresh store opens, and
    /// restarts the app.
    ///
    /// Restarted rather than recomposed in place. `JunoDesktopConfiguration` is a
    /// struct of twenty-eight immutable dependencies built once in
    /// `JunoDesktopApp.init` and handed to three separate scenes — the workspace,
    /// the incognito window and ⌘,. Swapping the copy this view holds would leave
    /// the other two wired to the dead configuration, so settings would insist
    /// nobody was signed in while the window behind it showed a signed-in
    /// account. One relaunch costs a second and leaves every scene composed
    /// against the same store.
    ///
    /// The new store is opened and closed here rather than left to the next
    /// launch: if anything else is also wrong, the user finds out now, with a
    /// message, instead of meeting the same dead end after a restart that has
    /// already moved their database.
    func recoverAndRestart() async {
        guard phase != .running else { return }
        phase = .running
        do {
            let factory = NativeLocalAccountStoreFactory(databaseURL: databaseURL)
            let recovery = try factory.recoverAndOpenRepository()
            // The relaunched process opens the same file, and SQLite's lock is
            // held until this handle is gone.
            try await recovery.repository.close()
            try restart()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Relaunches by way of a detached shell that waits for this process to
    /// exit, the same shape `DesktopUpdater` uses: `open` on a bundle whose
    /// instance is still running does not start a second one.
    private func restart() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            "while kill -0 \(ProcessInfo.processInfo.processIdentifier) "
                + "2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$1\"",
            // The path arrives as $1 rather than interpolated into the script,
            // so a space or a quote in it cannot become shell syntax.
            "sh",
            bundleURL.path,
        ]
        try process.run()
        NSApplication.shared.terminate(nil)
    }
}

private enum JunoDesktopConfigurationError: Error, LocalizedError {
    case invalidBackendURL
    case applicationSupportUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL:
            "The production Juno address is invalid."
        case .applicationSupportUnavailable:
            "Juno cannot access Application Support on this Mac."
        }
    }
}
