#if DEBUG
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCodeUI
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI

/// Development-only host for deterministic visual QA.
///
/// `PreviewWorld` owns an encrypted throwaway database and a no-network sender.
/// The production views below are unchanged; only their account and transport
/// dependencies are replaced. The symbol is absent from Stable and Next builds.
struct JunoDesktopPreviewRoot: View {
    var body: some View {
        JunoPreviewContainer(
            initialScenario: JunoPreviewEnvironment.initialScenario
        ) { world in
            if CommandLine.arguments.contains("--juno-preview-model-selector") {
                JunoDesktopModelSelectorPreview(world: world)
            } else {
                JunoDesktopPreviewWorkspace(world: world)
            }
        }
    }
}

/// A deterministic route to the production selector for screenshot and UI
/// automation. AppKit popovers intentionally dismiss when their anchor is
/// rebuilt; the preview world activates several observable models at launch,
/// which makes tapping through the composer a race rather than a useful test of
/// the selector itself.
private struct JunoDesktopModelSelectorPreview: View {
    let world: PreviewWorld

    var body: some View {
        JunoModelSelector(
            models: world.conversationModel.modelCatalog.map(\.junoDescriptor),
            selectedModelID: world.conversationModel.modelCatalog.first?.id ?? "",
            select: { _ in }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.junoCanvasWarm)
    }
}

private struct JunoDesktopPreviewWorkspace: View {
    let world: PreviewWorld
    let configuration: JunoDesktopConfiguration
    let workbenchModel: WorkbenchModel
    @State private var product: DesktopProductMode

    init(world: PreviewWorld) {
        self.world = world
        let sender = world.chatTransport
#if DEBUG
        if JunoPreviewEnvironment.updateReady {
            DesktopUpdateModel.shared.setPreviewReady(version: "0.1.3")
        }
#endif
        let codeModel = NativeCodeModel(
            client: NativeCodeTaskClient(sender: sender, streamer: sender)
        )
        let remoteCodeModel = CodeRemoteBrowserModel(
            client: NativeCodeRemoteClient(sender: sender)
        )
        configuration = JunoDesktopConfiguration(
            authModel: NativeAuthModel(configurationErrorDescription: "UI Preview"),
            runtime: nil,
            localStore: nil,
            syncModel: world.syncModel,
            outbox: nil,
            attachmentModel: world.attachmentModel,
            avatarModel: nil,
            conversationModel: world.conversationModel,
            privateChatModel: world.privateChatModel,
            generateClient: nil,
            projectModel: world.projectModel,
            artifactModel: world.artifactModel,
            memorySettingsModel: world.memorySettingsModel,
            searchModel: world.searchModel,
            connectorModel: NativeConnectorModel(
                client: NativeConnectorClient(sender: sender)
            ),
            scheduledTaskModel: NativeScheduledTaskModel(
                client: NativeScheduledTaskClient(sender: sender)
            ),
            codeModel: codeModel,
            remoteCodeModel: remoteCodeModel,
            // Nil on purpose: the preview harness must not announce this Mac as a
            // code device. It runs against a throwaway world with no account, and
            // a registration from here would put a fake host in the real one's
            // list — visible on the reader's phone.
            codeHostModel: nil,
            libraryModel: world.libraryModel,
            requestSender: sender,
            accountDataClient: world.accountDataClient,
            voiceTranscriptClient: NativeVoiceTranscriptClient(sender: sender),
            messageActionsClient: NativeMessageActionsClient(sender: sender),
            followUpClient: NativeFollowUpClient(sender: sender),
            pullsClient: NativeGitHubPullsClient(sender: sender),
            shareClient: NativeShareClient(sender: sender)
        )
        workbenchModel = WorkbenchModel.preview()
        _product = State(
            initialValue: JunoPreviewEnvironment.initialDestination == "code"
                ? .code : .chat
        )
    }

    var body: some View {
        JunoDesktopWorkspaceView(
            configuration: configuration,
            session: world.session,
            product: $product,
            workbenchModel: workbenchModel,
            initialDestination: Self.requestedDestination
        )
    }

    /// The `--juno-preview-tab` value as a sidebar destination.
    ///
    /// "code" is handled by `product` above and is not a destination; anything
    /// the enum does not recognise resolves to nil so the harness falls through
    /// to Chat rather than opening a blank pane.
    private static var requestedDestination: DesktopDestination? {
        guard let raw = JunoPreviewEnvironment.initialDestination, raw != "code" else {
            return nil
        }
        return DesktopDestination(rawValue: raw)
    }
}
#endif
