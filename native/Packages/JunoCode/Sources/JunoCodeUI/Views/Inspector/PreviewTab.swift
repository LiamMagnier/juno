import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Compact entry point into the live browser preview. The browser itself lives
/// beside the Code canvas where it has enough width for a real page; the
/// inspector only describes and launches that workspace.
struct PreviewTab: View {
    @Bindable var controller: SessionController
    let openPreview: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                JunoIconView(systemImage: "rectangle.on.rectangle", size: 16)
                    .junoSecondaryInk()
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Live preview")
                        .font(.headline)
                    Text("Run the project beside the conversation without losing your place in the task.")
                        .junoCaption()
                        .junoSecondaryInk()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Divider().overlay(Color.junoSeparator)

            if let root = controller.context?.access.rootURL {
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    LabeledContent {
                        Text(root.lastPathComponent.isEmpty ? root.path : root.lastPathComponent)
                            .junoCode()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } label: {
                        JunoIconLabel("Workspace", icon: .projects)
                    }

                    Button("Open Live Preview", action: { openPreview?() })
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                        .disabled(openPreview == nil)
                        .accessibilityIdentifier("juno.code.preview.open")

                    Text("The preview stays attached to this session and follows file changes as Juno works.")
                        .junoCaption()
                        .junoMetaInk()
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                JunoEmptyState(
                    title: "No workspace",
                    message: "Open a local Code session to preview its project.",
                    symbol: "folder.badge.questionmark"
                )
            }

            Spacer(minLength: 0)
        }
        .padding(JunoSpace.cozy)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("juno.code.preview")
    }
}
