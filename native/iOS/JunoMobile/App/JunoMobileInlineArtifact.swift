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

    /// Round 2: a navigation bar with the title, the kind and "From this
    /// conversation" as one secondary line, the system segmented control for
    /// Preview/Source, and the artifact edge to edge — no card, no outline.
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                Text(metaLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if availableModes.count > 1 {
                    Picker("View", selection: modeSelection) {
                        ForEach(availableModes) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("juno.mobile.inline-artifact-view-mode")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.bottom, JunoSpace.cozy)

            JunoMobileArtifactBody(
                kind: artifact.kind,
                content: reference.content,
                mode: resolvedMode
            )
            // Keyed on the artifact so the canvas's console never carries one
            // document's errors onto the next.
            .id(artifact.id)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(.systemBackground))
        .navigationTitle(reference.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: reference.content) {
                    Label("artifact.share-source", systemImage: "square.and.arrow.up")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: close) {
                    Label("artifact.close", systemImage: "xmark")
                }
                .accessibilityIdentifier("juno.mobile.inline-artifact-close")
            }
        }
        .accessibilityIdentifier("juno.mobile.inline-artifact")
    }

    /// The kind, the language, and which copy this is — "From this
    /// conversation" is the whole difference between this and the stored one.
    private var metaLine: String {
        var parts = [kindName]
        if let language = reference.language, !language.isEmpty { parts.append(language.uppercased()) }
        parts.append(String(localized: "artifact.from-conversation"))
        return parts.joined(separator: " · ")
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
        case .spreadsheet: "Spreadsheet"
        case .document: "Document"
        case .presentation: "Deck"
        }
    }
}
