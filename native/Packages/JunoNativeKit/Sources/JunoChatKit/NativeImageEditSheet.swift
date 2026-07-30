import JunoCore
import JunoDesignSystem
import SwiftUI

/// The whole image-edit flow as one presentable surface: pick a region, describe
/// the change, watch it run, open where it landed.
///
/// Both apps present this identically — from the Library, on the one image the
/// reader chose — so neither has to know that an edit is a media generation, or
/// that a generation produces a conversation rather than a file.
@MainActor
public struct NativeImageEditSheet: View {
    private let attachmentID: String
    private let fileName: String
    private let accountID: AccountID
    private let attachments: NativeAttachmentAPIClient
    private let models: [NativeChatModelOption]
    private let close: () -> Void
    /// Where the edit landed, when the presenting screen can go there. Nil on a
    /// screen with no way to open a conversation — in which case the finished
    /// state says the picture is in a new chat and stops, rather than offering a
    /// button that does nothing.
    private let openConversation: ((String) -> Void)?

    @State private var session: NativeImageEditSession

    public init(
        attachmentID: String,
        fileName: String,
        accountID: AccountID,
        attachments: NativeAttachmentAPIClient,
        client: NativeChatAPIClient,
        models: [NativeChatModelOption],
        openConversation: ((String) -> Void)? = nil,
        close: @escaping () -> Void
    ) {
        self.attachmentID = attachmentID
        self.fileName = fileName
        self.accountID = accountID
        self.attachments = attachments
        self.models = models
        self.openConversation = openConversation
        self.close = close
        _session = State(initialValue: NativeImageEditSession(client: client))
    }

    public var body: some View {
        switch session.phase {
        case .idle:
            NativeImageEditView(
                attachmentID: attachmentID,
                fileName: fileName,
                accountID: accountID,
                attachments: attachments,
                models: models,
                submit: { session.start($0, for: accountID) },
                close: close
            )
        case .running(let progress):
            status {
                NativeMediaGenerationView(progress: progress)
            }
        case .finished(let conversationID):
            status {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Label("The edited image is ready.", systemImage: "checkmark.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.junoSuccess)
                    Text(
                        conversationID == nil
                            ? "It is in a new chat."
                            : "It is in a new chat, along with your instructions."
                    )
                    .font(.system(size: 13))
                    .foregroundStyle(Color.junoMutedForeground)
                    HStack(spacing: JunoSpace.snug) {
                        if let conversationID, let openConversation {
                            Button("Open chat") {
                                openConversation(conversationID)
                                close()
                            }
                        }
                        Button("Done", action: close)
                    }
                }
            }
        case .failed(let message):
            status {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.junoDanger)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: JunoSpace.snug) {
                        Button("Try again") { session.dismiss() }
                        Button("Close", action: close)
                    }
                }
            }
        }
    }

    private func status<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("Editing \(fileName)")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.junoMutedForeground)
            content()
            Spacer(minLength: 0)
        }
        .padding(JunoSpace.section)
        .frame(minWidth: 380, minHeight: 340, alignment: .topLeading)
        .background(Color.junoCanvas)
    }
}
