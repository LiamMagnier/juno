import Foundation
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

/// A Juno Design document, drawn inline — the body of an inline artifact card
/// whose kind is `DESIGN`.
///
/// **A deliberate difference from the web.** The web's card routes a design
/// through its sandbox, which has no design renderer and prints the
/// document's JSON in a `<pre>` (`sandbox-frame.tsx`, `buildSandboxDoc`'s
/// default branch). The Mac draws it (§0.8 register, entry 14): the server
/// already renders a design to SVG for Export
/// (`GET /api/design/{id}/export?format=svg`), so the card asks for that
/// picture — per version, cached — and shows it on the same light sheet a
/// running page sits on, inert (JavaScript off, network blocked, motion
/// frozen). Code is a switch away, and Open hands the document to the editor
/// in the canvas.
///
/// Drawn only once there is a stored row: its id is what the export route
/// takes, and the tag body the model streamed is the compact authoring form,
/// not the stored document (`lib/artifacts-store.ts` expands it on the way in).
/// Until then — and while the model is still writing — the card shows Code.
struct InlineDesignPreviewBody: View {
    let artifactID: String
    let version: Int
    let open: (() -> Void)?

    @Environment(\.junoDesignPreviews) private var previews

    private var state: NativeDesignPreviewState {
        previews?.designPreviewState(artifactID: artifactID, version: version) ?? .failed
    }

    var body: some View {
        Group {
            switch state {
            case .ready(let svg):
                NativeArtifactPreview(kind: .svg, content: Self.fitted(svg), mode: .preview, policy: .thumbnail)
                    .modifier(ArtifactPreviewSheet())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Design preview")
            case .loading:
                ZStack {
                    Color.white
                    Text("Preparing design")
                        .junoFont(size: 13, relativeTo: .callout)
                        .foregroundStyle(Color(white: 0.45))
                }
                .modifier(ArtifactPreviewSheet())
            case .unavailable, .failed:
                unavailable
            }
        }
        .task(id: "\(artifactID)#\(version)") {
            await previews?.loadDesignPreview(artifactID: artifactID, version: version)
        }
    }

    /// The exported SVG, sized to fit the sheet whole. An export carries its
    /// page's pixel size (`width="375" height="812"`), which the thumbnail
    /// sheet would draw at 1:1 and crop; `auto` lets its own `max-width` and
    /// `max-height` scale it down, aspect kept.
    static func fitted(_ svg: String) -> String {
        "<style>svg{width:auto;height:auto}</style>" + svg
    }

    /// The server could not draw it — a missing Library image (422) or an
    /// export failure — or it could not be reached. The document itself is
    /// fine, so the way on is to open it.
    private var unavailable: some View {
        VStack(spacing: JunoSpace.snug) {
            JunoIconView(.design, size: 20)
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            Text("Preview unavailable")
                .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                .foregroundStyle(Color.junoForeground)
            if let open {
                Button(action: open) {
                    HStack(spacing: 6) {
                        JunoIconView(.panelRight, size: 14)
                        Text("Open")
                    }
                }
                .buttonStyle(InlineArtifactOpenStyle())
                .contentShape(.rect)
                .help("Open in canvas")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.junoCanvas)
        .accessibilityElement(children: .contain)
    }
}

extension InlineArtifactStatus {
    /// "Loading", then "Done" or "Error", as the design's picture arrives.
    init(design state: NativeDesignPreviewState) {
        switch state {
        case .loading: self = .loading
        case .ready: self = .done
        case .unavailable, .failed: self = .error
        }
    }
}

/// Owns the design-preview loader for one signed-in account and hands it to
/// the transcript as ``SwiftUI/EnvironmentValues/junoDesignPreviews``. Apply
/// with `.id(accountID)`, as ``TranscriptMediaScope`` is, so another account
/// starts from an empty cache.
struct DesignPreviewScope: ViewModifier {
    @State private var loader: NativeDesignPreviewLoader

    init(sender: (any NativeAuthenticatedRequestSending)?, accountID: AccountID) {
        _loader = State(initialValue: NativeDesignPreviewLoader(sender: sender, accountID: accountID))
    }

    func body(content: Content) -> some View {
        content.environment(\.junoDesignPreviews, loader)
    }
}
