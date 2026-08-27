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

    @State private var displayMode = JunoMobileArtifactViewMode.preview

    private var reference: NativeMessageContent.ArtifactReference { artifact.reference }

    /// The views this artifact has. See ``JunoMobileArtifactViewMode``.
    private var availableModes: [JunoMobileArtifactViewMode] {
        JunoMobileArtifactViewMode.available(for: artifact.kind)
    }

    /// What is on screen, as opposed to what was last chosen. Clamped rather than
    /// written back: this screen is presented per artifact, so the mismatch is
    /// only possible for the first frame, and mutating state inside a body
    /// evaluation to correct one frame is how SwiftUI is made to loop.
    private var resolvedMode: JunoMobileArtifactViewMode {
        availableModes.contains(displayMode) ? displayMode : (availableModes.first ?? .source)
    }

    private var modeSelection: Binding<JunoMobileArtifactViewMode> {
        Binding(get: { resolvedMode }, set: { displayMode = $0 })
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                header
                controls
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.hairline)
            .padding(.bottom, JunoSpace.regular)

            JunoMobileArtifactBody(
                kind: artifact.kind,
                content: reference.content,
                mode: resolvedMode
            )
            // Keyed on the artifact so the canvas's console never carries one
            // document's errors onto the next.
            .id(artifact.id)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(Color.junoHairline, lineWidth: 1)
            )
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.regular)
        }
        .junoScreenCanvas()
        .navigationTitle(reference.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: close) {
                    JunoIconView(.close, size: 15)
                        .foregroundStyle(Color.primary)
                }
                .accessibilityLabel("artifact.close")
                .accessibilityIdentifier("juno.mobile.inline-artifact-close")
            }
        }
        .accessibilityIdentifier("juno.mobile.inline-artifact")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(reference.title)
                .junoPageHeading(compact: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: JunoSpace.tight) {
                JunoMobileMetaChip(title: kindName, icon: kindGlyph)
                if let language = reference.language, !language.isEmpty {
                    JunoMobileMetaChip(title: language.uppercased())
                }
                // Says which copy this is, rather than pretending to be the
                // stored one. "From this conversation" is the whole difference
                // between the two screens.
                JunoMobileMetaChip(
                    title: String(localized: "artifact.from-conversation"),
                    icon: .conversation
                )
            }
        }
    }

    private var controls: some View {
        HStack(spacing: JunoSpace.cozy) {
            // Nothing for a kind with one view — a one-segment switcher is a
            // label wearing a control's clothes — and three for a page, a graphic
            // or a component, which now includes the live canvas.
            if availableModes.count > 1 {
                JunoMobileSegmented(
                    options: availableModes.map { .init($0, $0.title) },
                    selection: modeSelection,
                    accessibilityLabel: "View"
                )
                .accessibilityIdentifier("juno.mobile.inline-artifact-view-mode")
            }
            Spacer(minLength: 0)
            ShareLink(item: reference.content) {
                JunoIconView(.share, size: 15)
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .frame(width: 44, height: 44)
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

    private var kindGlyph: JunoIcon {
        switch artifact.kind {
        case .react, .html: .code
        case .svg: .artifacts
        case .mermaid: .branch
        case .design: .writing
        case .markdown: .file
        case .code: .code
        }
    }
}
