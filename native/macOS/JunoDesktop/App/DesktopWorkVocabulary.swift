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
    /// from the website's generated set, so the kind is mapped here rather than
    /// through a symbol-name lookup that would land on the nearest guess.
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

/// How a line of a task's log is drawn: the Activity panel's mark and ink
/// for each of ``WorkEventLog/Entry``'s semantic marks and tones. The words
/// are JunoWorkKit's; the marks are the app's.
extension WorkEventLog.Entry {
    var icon: JunoIcon {
        switch mark {
        case .started: .play
        case .plan, .agent: .models
        case .check: .check
        case .message: .message
        case .tool: .tools
        case .refused: .permission
        case .approval: .shield
        case .file: .file
        case .link: .link
        case .batch: .list
        case .undo: .arrowLeft
        case .problem: .error
        case .limit: .usage
        case .device: .device
        case .paused: .pause
        }
    }

    var tint: Color {
        switch tone {
        case .quiet: Color.junoMutedForeground
        case .normal: Color.junoForeground
        case .warning: Color.junoCaution
        case .bad: Color.junoDanger
        case .good: Color.junoSuccess
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
        DesktopStatusText(style.label, kind: DesktopStatusText.Kind(status))
            .help(style.sentence)
    }
}

/// A status said as **text** (owner directive, premium pass): never a pill,
/// a badge, a capsule or a dot.
///
/// - Normal and finished states (Draft, Queued, Done, Connected, Paused…) are
///   the word in secondary ink and nothing else.
/// - In-progress states (Running, Preparing, Connecting…) are the word with the
///   quiet shimmer the transcript's working line uses — still under Reduce
///   Motion — and no colour.
/// - Attention states keep a colour and a mark, as plain text: waiting on the
///   reader in the accent with a raised hand, a failure in destructive ink
///   with a crossed circle.
struct DesktopStatusText: View {
    enum Kind: Equatable {
        case quiet
        case working
        case attention
        case failure

        init(_ status: JunoWorkStatus) {
            switch status {
            case .preparing, .running: self = .working
            case .waitingInput, .waitingApproval: self = .attention
            case .failed, .interrupted, .hostOffline, .budgetExceeded, .timedOut: self = .failure
            case .draft, .queued, .paused, .completed, .cancelled: self = .quiet
            }
        }
    }

    let label: String
    let kind: Kind

    init(_ label: String, kind: Kind) {
        self.label = label
        self.kind = kind
    }

    var body: some View {
        Group {
            switch kind {
            case .quiet:
                Text(label)
                    .foregroundStyle(Color.junoSecondaryInk)
            case .working:
                JunoShimmerText(label, font: JunoType.caption.weight(.medium).font(), active: true)
            case .attention:
                Label {
                    Text(label)
                } icon: {
                    JunoIconView(.hand, size: 11)
                }
                .labelStyle(DesktopStatusLabelStyle())
                .foregroundStyle(Color.junoAccent)
            case .failure:
                Label {
                    Text(label)
                } icon: {
                    JunoIconView(.circleX, size: 11)
                }
                .labelStyle(DesktopStatusLabelStyle())
                .foregroundStyle(Color.junoDestructiveInk)
            }
        }
        .junoType(JunoType.caption.weight(.medium))
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// A mark and a word, 4pt apart, on one baseline.
private struct DesktopStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: JunoSpace.tight) {
            configuration.icon
            configuration.title
        }
    }
}

// MARK: - Status vocabulary

/// How Work says a status on this platform: its tint above all, which the
/// chat's ``ChatWorkStatusPill`` and ``DesktopWorkStatusPill`` both read.
///
/// Moved here from the old Work window when Phase 5 Stage D removed it. A
/// lookup rather than an extension on ``JunoWorkStatus``, because the label,
/// the sentence and the tint are the app's business and the contract enum is
/// shared with the phone and the relay. The chat's words are
/// ``ChatWorkVocabulary``'s (the web's `STATUS_META`, verbatim); the labels
/// and sentences here are the old window's, kept for the pill until track B's
/// pages settle which one they draw.
struct DesktopWorkStatusStyle {
    let label: String
    /// Sentence form, for empty states and accessibility. Never a fragment.
    let sentence: String
    let symbol: String
    let tint: Color

    static func of(_ status: JunoWorkStatus) -> DesktopWorkStatusStyle {
        switch status {
        case .draft:
            DesktopWorkStatusStyle(
                label: "Draft",
                sentence: "This task has been written but never started, so nothing is running and nothing is queued.",
                symbol: "square.and.pencil",
                tint: Color.junoMutedForeground
            )
        case .queued:
            DesktopWorkStatusStyle(
                label: "Queued",
                sentence: "Waiting for an executor to pick this up.",
                symbol: "clock",
                tint: Color.junoMutedForeground
            )
        case .preparing:
            DesktopWorkStatusStyle(
                label: "Preparing",
                sentence: "Fetching inputs, resolving permissions and starting up.",
                symbol: "hourglass",
                tint: Color.junoAccent
            )
        case .running:
            DesktopWorkStatusStyle(
                label: "Running",
                sentence: "Juno is working on this now.",
                symbol: "bolt.horizontal",
                tint: Color.junoAccent
            )
        case .waitingInput:
            DesktopWorkStatusStyle(
                label: "Needs an answer",
                sentence: "Juno has asked you something and cannot continue until you answer.",
                symbol: "questionmark.bubble",
                tint: Color.junoCaution
            )
        case .waitingApproval:
            DesktopWorkStatusStyle(
                label: "Needs approval",
                sentence: "Juno is waiting for you to allow or refuse an action.",
                symbol: "shield.lefthalf.filled",
                tint: Color.junoCaution
            )
        case .paused:
            DesktopWorkStatusStyle(
                label: "Paused",
                sentence: "You stopped this. It can be resumed.",
                symbol: "pause.circle",
                tint: Color.junoMutedForeground
            )
        case .completed:
            DesktopWorkStatusStyle(
                label: "Done",
                sentence: "This finished.",
                symbol: "checkmark.circle",
                tint: Color.junoSuccess
            )
        case .failed:
            DesktopWorkStatusStyle(
                label: "Failed",
                sentence: "The run itself reported that it could not finish.",
                symbol: "xmark.circle",
                tint: Color.junoDanger
            )
        case .cancelled:
            DesktopWorkStatusStyle(
                label: "Cancelled",
                sentence: "This was cancelled before it finished.",
                symbol: "slash.circle",
                tint: Color.junoMutedForeground
            )
        case .interrupted:
            DesktopWorkStatusStyle(
                label: "Interrupted",
                sentence: "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.",
                symbol: "exclamationmark.triangle",
                tint: Color.junoCaution
            )
        case .hostOffline:
            DesktopWorkStatusStyle(
                label: "Mac unreachable",
                sentence: "The Mac this needed went away mid-run. Wake it and try again, or move the task to the cloud.",
                symbol: "laptopcomputer.slash",
                tint: Color.junoCaution
            )
        case .budgetExceeded:
            DesktopWorkStatusStyle(
                label: "Hit its limit",
                sentence: "This stopped because it reached the ceiling set for it.",
                symbol: "gauge.with.dots.needle.100percent",
                tint: Color.junoCaution
            )
        case .timedOut:
            DesktopWorkStatusStyle(
                label: "Timed out",
                sentence: "This ran for longer than its time limit allowed and was stopped.",
                symbol: "clock.badge.exclamationmark",
                tint: Color.junoCaution
            )
        }
    }
}
