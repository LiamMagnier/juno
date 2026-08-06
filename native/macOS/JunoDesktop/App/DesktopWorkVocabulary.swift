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

// MARK: - What a standing yes may cover

/// The consent rules the approval card has to agree with.
///
/// A free function on a namespace rather than a computed property on the view,
/// because this is the one rule in the window whose being wrong is invisible:
/// a button offered for a risk the model refuses does not fail, it silently
/// degrades to a one-time approval, and the reader is asked the same question
/// again on the next identical action with no explanation. A rule that fails
/// that quietly has to be testable without instantiating a `View`.
enum DesktopWorkApprovalRules {
    /// Whether "Always allow this" can be honoured for this level of risk.
    ///
    /// Mirrors `WorkRisk.mayBeCoveredByStandingAllowance` (`risk <= .command`)
    /// in JunoWorkCore, whose `WorkAlwaysAllowance(upTo:)` is a *failable*
    /// initialiser returning nil above that ceiling — and which re-applies the
    /// rule on decode, so even a stored allowance that claims to cover
    /// `irreversible` cannot grant it.
    ///
    /// Stated here rather than imported because `JunoWorkCore` is the local
    /// executor's layer and this window also renders cloud approvals, which
    /// never pass through it. The contract enum is what both sides share, and
    /// `tests/work-approval-plane.test.ts` pins the same ordering on the web so
    /// the three copies cannot drift apart unnoticed.
    ///
    /// An unnamed level is uncoverable, matching the decoder's own fallback of
    /// `irreversible` for a risk it cannot classify: a client that cannot name
    /// the risk asks every time rather than quietly granting a standing yes.
    static func allowsStandingGrant(_ risk: JunoWorkRiskLevel?) -> Bool {
        switch risk {
        case .safe, .edit, .command: true
        case .sensitive, .irreversible, nil: false
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
        .foregroundStyle(quiet ? Color.secondary : style.tint)
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
