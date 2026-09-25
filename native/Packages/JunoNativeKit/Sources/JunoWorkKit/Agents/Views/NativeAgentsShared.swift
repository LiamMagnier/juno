import Foundation
import JunoDesignSystem
import SwiftUI

// The small vocabulary every Agents screen shares on both platforms: the
// page container, a section heading, the flat tile, and the words for times
// and task states. One place, so the roster, the page and the hire flow
// cannot each grow their own idea of what a tile is.

// MARK: - Words

/// How Agents says a time, a task state and a cost.
public enum NativeAgentFormat {
    /// "today at 09:00", "tomorrow at 09:00", "Mon at 09:00", "12 Oct" — in
    /// the reader's own zone. The server says the same sentence in UTC because
    /// it does not know the zone; the device does, so it says it again,
    /// correctly (`formatLocalWhen` on the web).
    static func upcoming(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: now),
            to: calendar.startOfDay(for: date)
        ).day ?? 0
        let time = date.formatted(date: .omitted, time: .shortened)
        if days <= 0 { return "today at \(time)" }
        if days == 1 { return "tomorrow at \(time)" }
        if days < 7 { return "\(date.formatted(.dateTime.weekday(.abbreviated))) at \(time)" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// "just now", "12 min ago", "3 h ago", "Mon", "12 Oct".
    static func ago(_ date: Date, now: Date = Date()) -> String {
        let minutes = Int((now.timeIntervalSince(date) / 60).rounded())
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "\(hours) h ago" }
        let days = Int((Double(hours) / 24).rounded())
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// The sentence beside the face, re-said locally when it names a time.
    /// Every other state's sentence is the server's, which names the task.
    /// Public because every place that shows an agent's face says it: the
    /// roster, its page, the sidebar row and the header of its thread.
    public static func stateSentence(for agent: NativeAgent) -> String {
        if agent.state == .idle, let next = agent.nextRoutine, let at = next.nextRunAt {
            return "Next: \(next.name), \(upcoming(at))"
        }
        return agent.stateSentence.isEmpty ? agent.state.label : agent.stateSentence
    }

    /// A Work session status, as words. No wire token reaches a person.
    static func taskStatus(_ raw: String) -> String {
        switch raw {
        case "draft": "Draft"
        case "queued": "Queued"
        case "preparing": "Getting ready"
        case "running": "Working"
        case "waiting_input": "Has a question"
        case "waiting_approval": "Needs your approval"
        case "paused": "Paused"
        case "completed": "Finished"
        case "failed": "Stopped"
        case "cancelled": "Cancelled"
        case "interrupted": "Interrupted"
        case "host_offline": "Waiting for your Mac"
        case "budget_exceeded": "Usage window ran out"
        case "timed_out": "Ran out of time"
        default: JunoWorkVocabulary.sentenceCased(raw)
        }
    }

    /// "$0.42", from the estimate a `confirm_expensive` answer carries.
    static func cost(microUSD: Int) -> String {
        let dollars = Double(microUSD) / 1_000_000
        return dollars.formatted(.currency(code: "USD"))
    }

    static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
}

// MARK: - Page

/// A page of agent content. `JunoDetailPage` on the Mac — which is what keeps
/// a tall page from resizing the window's split view — and a plain scrolling
/// column on the phone, where the navigation stack owns the edges.
struct NativeAgentsScroll<Content: View>: View {
    private let maxWidth: CGFloat
    private let content: Content

    init(maxWidth: CGFloat = JunoReadingMeasure.reading, @ViewBuilder content: () -> Content) {
        self.maxWidth = maxWidth
        self.content = content()
    }

    var body: some View {
        #if os(macOS)
        JunoDetailPage(maxWidth: maxWidth) { content }
        #else
        ScrollView {
            content
                .frame(maxWidth: maxWidth, alignment: .leading)
                .padding(.horizontal, JunoSpace.regular)
                .padding(.top, JunoSpace.snug)
                .padding(.bottom, JunoSpace.region)
                .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        #endif
    }
}

/// A section's heading: sentence case, semibold, one step above body — the
/// hierarchy is carried by weight, not by capitals.
struct NativeAgentHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .junoFont(size: 15, relativeTo: .headline, weight: .semibold)
            .junoInk()
            .accessibilityAddTraits(.isHeader)
    }
}

/// A quiet field label, the web's `font-mono text-label` eyebrow.
struct NativeAgentFieldLabel: View {
    let title: String

    var body: some View {
        #if os(macOS)
        // A field's name in SF at the controls' rung, above its field: the
        // pages set no mono or uppercase labels (Phase 4 §2.10).
        Text(title)
            .junoType(JunoType.ui.weight(.medium))
            .foregroundStyle(Color.junoForeground)
        #else
        Text(title)
            .junoCodeSmall()
            .junoSecondaryInk()
        #endif
    }
}

/// The one trailing signal a row may carry: a toned dot while the agent needs
/// the person, nothing otherwise. State, not decoration — and hidden from
/// assistive technology, because the row it sits in says "Needs you" in words.
public struct NativeAgentNeedsYouDot: View {
    public init() {}

    public var body: some View {
        Circle()
            .fill(Color.junoAccent)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

/// A line that says something went wrong, with the server's own sentence and
/// the one thing to do about it.
struct NativeAgentsProblem: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.error, size: 14)
                .foregroundStyle(Color.junoCaution)
            Text(message)
                .font(.callout)
                .junoInk()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                JunoIconView(.close, size: 12)
                    .junoSecondaryInk()
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, JunoSpace.cozy)
        .background {
            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                .fill(Color.junoCaution.opacity(0.10))
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Tiles

extension View {
    /// A single-line field on the Mac's pages: the web's `Input` — 32pt at
    /// the field radius, the `--input` hairline, on the raised fill. The
    /// iPhone keeps its rounded-border field.
    @ViewBuilder
    func nativeAgentField() -> some View {
        #if os(macOS)
        self
            .textFieldStyle(.plain)
            .junoType(.ui)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoInput, lineWidth: 1)
            )
        #else
        self.textFieldStyle(.roundedBorder)
        #endif
    }

    /// A bordered button's outline and label in the neutral ink on the Mac,
    /// where the detail column's accent tint would otherwise draw it coral
    /// (Phase 4 C3: coral is the send disc, switches, links, the live dot and
    /// one prominent button). The iPhone keeps its tint.
    @ViewBuilder
    func nativeAgentNeutralTint() -> some View {
        #if os(macOS)
        self.tint(nil)
        #else
        self
        #endif
    }
}

extension View {
    /// A flat tile: the surface fill and a hairline, with the chosen state
    /// carried by tone — the `--selected` fill and a darker edge — never by a
    /// shadow (FLAT_UI.md §2).
    func nativeAgentTile(selected: Bool = false, padding: CGFloat = JunoSpace.cozy) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(selected ? Color.junoMuted : Color.junoSurface)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(
                        selected ? Color.junoForeground.opacity(0.35) : Color.junoBorder,
                        lineWidth: selected ? 1 : 0.5
                    )
            }
    }

    /// A multi-line text field's frame: the same hairline well on both
    /// platforms, so a brief reads as something you can write in.
    func nativeAgentWell(minHeight: CGFloat) -> some View {
        self
            .scrollContentBackground(.hidden)
            .padding(JunoSpace.snug)
            .frame(minHeight: minHeight)
            .background {
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .fill(Color.junoSurface)
            }
            .overlay {
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 0.5)
            }
    }
}
