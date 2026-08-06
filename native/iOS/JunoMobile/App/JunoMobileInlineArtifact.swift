import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// An artifact rendered straight from the reply that produced it.
///
/// The fallback half of "tapping an artifact opens it". The full
/// ``JunoMobileArtifactDetail`` needs a stored `NativeArtifact` — it offers
/// versions, restore, rename, edit and export, all of which are operations on a
/// server row. This has no row. What it has is the `<juno:artifact>` body the
/// reply carried, which is the same bytes the row will hold once it syncs.
///
/// So the two are deliberately not the same screen. This one states plainly that
/// it is showing the copy from the conversation, and offers exactly what that
/// copy supports: look at it, read the source, share it. Dressing it up with
/// disabled Restore and Export buttons would promise a row that does not exist.
struct JunoMobileInlineArtifact: Identifiable {
    let reference: NativeMessageContent.ArtifactReference

    var id: String { reference.id }

    var kind: NativeArtifactKind {
        NativeArtifactKind(rawValue: reference.kind.uppercased()) ?? .code
    }
}

struct JunoMobileInlineArtifactView: View {
    let artifact: JunoMobileInlineArtifact
    let close: () -> Void

    @State private var displayMode = NativeArtifactDisplayMode.preview

    private var reference: NativeMessageContent.ArtifactReference { artifact.reference }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                controls
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 14)

            JunoMobileArtifactBody(
                kind: artifact.kind,
                content: reference.content,
                mode: displayMode
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .junoScreenCanvas()
        .navigationTitle(reference.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                }
                .accessibilityLabel("artifact.close")
                .accessibilityIdentifier("juno.mobile.inline-artifact-close")
            }
        }
        .accessibilityIdentifier("juno.mobile.inline-artifact")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(reference.title)
                .junoPageHeading(compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: 6) {
                JunoMobileMetaChip(title: kindName, systemImage: kindGlyph)
                if let language = reference.language, !language.isEmpty {
                    JunoMobileMetaChip(title: language.uppercased())
                }
                // Says which copy this is, rather than pretending to be the
                // stored one. "From this conversation" is the whole difference
                // between the two screens.
                JunoMobileMetaChip(
                    title: String(localized: "artifact.from-conversation"),
                    systemImage: "bubble.left.and.text.bubble.right"
                )
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            if artifact.kind.supportsRenderedPreview {
                JunoMobileSegmented(
                    options: [
                        .init(NativeArtifactDisplayMode.preview, "Preview"),
                        .init(NativeArtifactDisplayMode.source, "Source"),
                    ],
                    selection: $displayMode,
                    accessibilityLabel: "View"
                )
            }
            Spacer(minLength: 0)
            ShareLink(item: reference.content) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("artifact.share-source")
        }
    }

    private var kindName: String {
        switch artifact.kind {
        case .html: "HTML"
        case .react: "React"
        case .code: "Code"
        case .markdown: "Markdown"
        case .svg: "SVG"
        case .mermaid: "Diagram"
        case .design: "Design"
        }
    }

    private var kindGlyph: String {
        switch artifact.kind {
        case .react, .html: "curlybraces.square"
        case .svg: "square.on.circle"
        case .mermaid: "flowchart"
        case .design: "pencil.and.outline"
        case .markdown: "doc.text"
        case .code: "chevron.left.forwardslash.chevron.right"
        }
    }
}
