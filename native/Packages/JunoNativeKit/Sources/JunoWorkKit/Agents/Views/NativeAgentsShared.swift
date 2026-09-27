import Foundation
import JunoCore
import JunoDesignSystem
import SwiftUI

// The small vocabulary every Agents surface shares on both platforms: the
// halo and the face on it, a section in prose, a suggestion line, the quiet
// icon button, and the words for times and task states. One place, so home,
// the thread and the profile cannot each grow their own idea of them.

/// A menu item's words: Title Case on the Mac (§0.7), as written on the phone.
func nativeAgentMenuTitle(_ words: String) -> String {
    #if os(macOS)
    words.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    #else
    words
    #endif
}

/// A control's target in the Agents views: a pointer's 28pt on the Mac, a
/// finger's 44pt on the phone.
public enum NativeAgentMetrics {
    #if os(macOS)
    public static let target: CGFloat = 28
    #else
    public static let target: CGFloat = 44
    #endif

    /// The face in a thread's presence header.
    public static let headerFace: CGFloat = 40
    /// The face on a home tile.
    public static let tileFace: CGFloat = 72
    /// The face at the top of the profile and an empty thread.
    public static let profileFace: CGFloat = JunoAgentFaceSize.lg
}

// MARK: - Words

/// How Agents says a time, a task state and a cost.
public enum NativeAgentFormat {
    /// "today at 09:00", "tomorrow at 09:00", "Mon at 09:00", "12 Oct", in
    /// the reader's own zone.
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

    /// The live sentence beside the face, re-said locally when it names a
    /// time. Every other state's sentence is the server's, which names the
    /// task.
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

    /// How much it asks, as one sentence about the agent by name.
    public static func autonomySentence(_ mode: JunoWorkPermissionPolicy, name: String) -> String {
        switch mode {
        case .conservative:
            "\(name) asks before it changes anything. Reading and research go ahead."
        case .balanced:
            "\(name) makes changes it can undo, and asks before anything risky or private."
        case .permissive:
            "\(name) gets on with the work, and asks only before things it cannot take back."
        }
    }

    /// The name an agent is greeted by before it has named itself.
    static let placeholderName = "New agent"

    /// "Hi, I'm Wren." An agent that has not named itself yet says so.
    public static func greeting(for agent: NativeAgent) -> String {
        agent.name == placeholderName ? "Hi, I’m new here." : "Hi, I’m \(agent.name)."
    }
}

// MARK: - Suggestions

/// The three lines under a composer, drawn from the starting points' first
/// goals. Pressing one fills the composer; it never sends.
public enum NativeAgentSuggestions {
    /// The home's three.
    public static let home: [String] = Array(
        NativeAgentTemplate.all.map(\.firstGoal).filter { !$0.isEmpty }.prefix(3)
    )

    /// An agent's own three, for its empty thread: its starting point's goal
    /// first, when it was hired from one, then the others.
    public static func forAgent(_ agent: NativeAgent) -> [String] {
        let own = NativeAgentTemplate.named(agent.template)?.firstGoal ?? ""
        var lines = own.isEmpty ? [] : [own]
        for goal in NativeAgentTemplate.all.map(\.firstGoal) where !goal.isEmpty && !lines.contains(goal) {
            lines.append(goal)
        }
        return Array(lines.prefix(3))
    }
}

/// One suggestion: plain text with an arrow, secondary until the pointer or a
/// finger is on it. A button, never a chip.
struct NativeAgentSuggestionLine: View {
    let text: String
    let action: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                JunoIconView(.arrowRight, size: 12)
                    .foregroundStyle(isHovering ? Color.junoForeground : Color.junoTertiaryInk)
                    .accessibilityHidden(true)
                Text(text)
                    .junoType(.ui)
                    .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minHeight: NativeAgentMetrics.target, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .accessibilityHint("Fills in the message")
    }
}

/// The suggestion lines, stacked tight.
struct NativeAgentSuggestionList: View {
    let lines: [String]
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines, id: \.self) { line in
                NativeAgentSuggestionLine(text: line) { pick(line) }
            }
        }
    }
}

// MARK: - The halo

/// The signature detail: a soft radial wash of the agent's own tone behind
/// its face, about 14% at the face's edge and clear at its rim. Static; only
/// the face animates, and only for a live state. You recognise an agent by
/// its colour before you read its name.
public struct NativeAgentHalo: View {
    private let tone: JunoAgentTone
    private let diameter: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    public init(tone: JunoAgentTone, diameter: CGFloat) {
        self.tone = tone
        self.diameter = diameter
    }

    public var body: some View {
        // A touch stronger on the dark ground, where the same alpha reads
        // quieter against the charcoal.
        let strength = colorScheme == .dark ? 0.18 : 0.14
        Circle()
            .fill(
                RadialGradient(
                    stops: [
                        .init(color: tone.color.opacity(strength), location: 0),
                        .init(color: tone.color.opacity(strength), location: 0.46),
                        .init(color: tone.color.opacity(strength * 0.45), location: 0.7),
                        .init(color: tone.color.opacity(0), location: 1),
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: diameter / 2
                )
            )
            .frame(width: diameter, height: diameter)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// An agent's face on its halo. The halo spreads past the face without
/// taking layout, so a face sits in a row at its own size.
public struct NativeAgentPresence: View {
    private let avatar: JunoAgentAvatar
    private let state: JunoAgentState
    private let size: CGFloat
    private let name: String?

    public init(avatar: JunoAgentAvatar, state: JunoAgentState = .idle, size: CGFloat, name: String? = nil) {
        self.avatar = avatar
        self.state = state
        self.size = size
        self.name = name
    }

    public var body: some View {
        JunoAgentFace(avatar: avatar, state: state, size: size, name: name)
            .frame(width: size, height: size)
            .background {
                NativeAgentHalo(tone: avatar.tone, diameter: size * 2.1)
            }
    }
}

// MARK: - Needs you

/// "Needs you": the accent hand and the words, as plain text. Never a pill,
/// never a count.
public struct NativeAgentNeedsYouLine: View {
    private let text: String

    public init(_ text: String = "Needs you") {
        self.text = text
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            JunoIconView(.hand, size: 12)
                .accessibilityHidden(true)
            Text(text)
                .junoType(JunoType.ui.weight(.medium))
        }
        .foregroundStyle(Color.junoAccentInk)
    }
}

/// The one trailing signal a row may carry while the agent needs the person:
/// a raised hand in the accent. Hidden from assistive technology, because the
/// row it sits in says "Needs you" in words. The name is kept for its call
/// sites.
public struct NativeAgentNeedsYouDot: View {
    public init() {}

    public var body: some View {
        JunoIconView(.hand, size: 12)
            .foregroundStyle(Color.junoAccentInk)
            .accessibilityHidden(true)
    }
}

// MARK: - Sections

/// A section of the profile in prose: a sentence-case title in the
/// secondary ink, then its content. Space separates sections, never a rule.
struct NativeAgentSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text(title)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Controls

/// A quiet icon button: the glyph in the secondary ink on a hover fill, with
/// a tooltip. The presence header's Computer and Profile.
struct NativeAgentIconButton: View {
    let icon: JunoIcon
    let label: String
    let action: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            JunoIconView(icon, size: 16)
                .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                .background {
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(isHovering ? Color.junoHover : Color.clear)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .help(label)
        .accessibilityLabel(label)
    }
}

/// A plain text action in the secondary ink, lifting to the foreground under
/// the pointer: Open, Remove, Show in thread.
struct NativeAgentTextButton: View {
    let title: String
    var role: ButtonRole? = nil
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(role: role, action: action) {
            Text(title)
                .junoType(.ui)
                .foregroundStyle(
                    role == .destructive
                        ? Color.junoDanger
                        : (isHovering ? Color.junoForeground : Color.junoSecondaryInk)
                )
                .frame(minHeight: NativeAgentMetrics.target)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}

/// A line that says something went wrong, in the server's own words: the
/// caution mark and the sentence, as plain text.
struct NativeAgentsProblem: View {
    let message: String
    var dismiss: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            JunoIconView(.triangleAlert, size: 12)
                .foregroundStyle(Color.junoCaution)
                .accessibilityHidden(true)
            Text(message)
                .junoType(.ui)
                .foregroundStyle(Color.junoForeground)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let dismiss {
                Button(action: dismiss) {
                    JunoIconView(.close, size: 12)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .frame(width: NativeAgentMetrics.target, height: NativeAgentMetrics.target)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Page

/// A page of agent content. `JunoDetailPage` on the Mac, which keeps a tall
/// page from resizing the window's split view, and a plain scrolling column
/// on the phone, where the navigation stack owns the edges.
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
