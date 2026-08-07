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
struct DesktopWorkStatusPill: View {
    let status: JunoWorkStatus
    /// The compact form: no fill, for use inside a source-list row where a
    /// capsule per row would be a column of lozenges.
    var quiet = false

    var body: some View {
        let style = DesktopWorkStatusStyle.of(status)
        return Label {
            Text(style.label)
        } icon: {
            Image(systemName: style.symbol)
                .imageScale(.small)
        }
        .font(.system(.caption, design: .default, weight: .medium))
        .foregroundStyle(quiet ? Color.junoMutedForeground : style.tint)
        .padding(.horizontal, quiet ? 0 : JunoSpace.snug)
        .padding(.vertical, quiet ? 0 : 3)
        .background {
            if !quiet {
                Capsule(style: .continuous)
                    .fill(style.tint.opacity(0.12))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(style.label)
    }
}
