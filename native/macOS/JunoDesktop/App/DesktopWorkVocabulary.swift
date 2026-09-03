import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The Mac's alias for the shared Work vocabulary.
///
/// The table itself lives in `JunoWorkKit` because the phone renders the same
/// events from the same relay and had its own `replacingOccurrences(of: "_")`
/// fallback — two surfaces inventing two names for one tool is precisely the
/// drift the shared contract exists to prevent.
typealias DesktopWorkVocabulary = JunoWorkVocabulary

extension JunoWorkVocabulary {
    /// The website's mark for a deliverable of this kind.
    ///
    /// The shared table still names an SF Symbol for the phone; the Mac draws
    /// from the Lucide catalog, so the kind is mapped here rather than through
    /// a symbol-name lookup that would land on the nearest guess.
    static func artifactIcon(_ kind: JunoWorkArtifactKind) -> JunoIcon {
        switch kind {
        case .document, .report: .file
        case .spreadsheet: .grid
        case .presentation: .image
        case .pdf: .file
        case .bundle, .archive: .box
        case .image: .image
        case .site: .web
        }
    }
}

// MARK: - Status pill

/// A task's status, as a tinted capsule.
///
/// **What this replaces.** The status was `Label(...).junoCodeSmall()` — a
/// monospaced caption in the status colour, beside a serif page title. The
/// design system reserves monospace for "terminal output, gutters, hashes"
/// (`JunoStatus.swift`), so the one thing in the header a reader looks for first
/// was set in the one face reserved for machine output.
///
/// A capsule rather than coloured text because the status is a *label*, not
/// prose: it wants an edge so the eye can find it without reading it, and a
/// tinted fill carries the state at a glance in a way coloured text on a warm
/// canvas does not. The fill is the tint at low opacity rather than a second
/// palette entry, so a status added to the contract needs no new colour.
/// A dot, a monospaced word, and a hairline — `WorkStatusPill` from
/// `work-vocabulary.tsx`, which is the same chip the website and the phone draw.
///
/// **The glyph is gone and that is the change.** It used to be
/// `DesktopWorkStatusStyle.symbol` at caption size: one of fourteen SF symbols,
/// none of which is legible at 11pt without being identified one at a time, and
/// several of which (a shield, a half-filled shield, a slashed circle) mean
/// nothing outside this file. The web's chip carries a 6pt dot instead — the
/// same tone as the border and the fill — so the state reads as a colour at a
/// glance and as a word when you look. Mono, because that is the face this
/// product sets labels and metadata in, and because a proportional word in a
/// 60pt chip wanders while a monospaced one sits still.
struct DesktopWorkStatusPill: View {
    let status: JunoWorkStatus

    var body: some View {
        let style = DesktopWorkStatusStyle.of(status)
        return HStack(spacing: JunoSpace.tight) {
            Circle()
                .fill(style.tint)
                .frame(width: 6, height: 6)
            Text(style.label)
                .junoFont(size: 10, relativeTo: .caption2, design: .monospaced)
        }
        .foregroundStyle(style.tint)
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, 3)
        .background(Capsule(style: .continuous).fill(style.tint.opacity(0.10)))
        .overlay(Capsule(style: .continuous).strokeBorder(style.tint.opacity(0.28), lineWidth: 0.5))
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(style.label)
        .help(style.sentence)
    }
}
