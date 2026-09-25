import JunoDesignSystem
import JunoWorkKit
import SwiftUI

// MARK: - Choreography

/// The distances and beats the chat surface's motion travels, in the web's own
/// numbers.
///
/// **Not a motion ladder.** The curves live on ``JunoMotion`` (`riseIn`,
/// `exit`, `fast`, `emphasized`, `handoff(reduceMotion:)`); what is here is the
/// geometry those curves move through and the delays between beats, which are
/// not animations and belong to this surface alone. A second set of curves
/// beside the ladder is exactly what the motion gate refuses.
enum DesktopChoreography {
    /// The web's `slide-in-from-right-4`. Sixteen points, not a full-width
    /// sweep: opening reads as the card handing off to the workspace beside it
    /// rather than as a scene change.
    static let canvasSlide: CGFloat = 16
    /// `rise-in`'s travel: the web's 6px, the ladder's own distance.
    static let riseDistance: CGFloat = JunoMotion.riseDistance

    // The handoff (§10.1). Each beat is the web's, and each exists so the eye
    // reads the sequence in order — the question leaves, then the answer to it
    // arrives — rather than as one cut.

    /// The greeting rises a little as it leaves, rather than sinking: it is
    /// making room for the transcript, not falling into it.
    static let greetingExitLift: CGFloat = 4
    /// And shrinks by a hair, so the exit reads as receding, not as sliding.
    static let greetingExitScale: CGFloat = 0.985
    /// The first bubble waits this long before it rises, so the greeting is
    /// visibly on its way out before anything takes its place.
    static let firstTurnBeat: TimeInterval = 0.06
    /// The starter chips follow the greeting in: 120ms after it, so the row
    /// reads as an answer to the question above it, then 30ms apart.
    static let chipsBeat: TimeInterval = 0.12
    static let chipStagger: TimeInterval = 0.03
    /// A chip's own rise: shorter than a turn's, because it is smaller.
    static let chipRise: CGFloat = 4
}

// MARK: - The handoff

/// Where the greeting and the chips are in their life: waiting below to rise
/// in, on screen, or gone upward after a send (§4.2, §10.1).
///
/// **Why a pose and not a transition.** The handoff is one
/// `withAnimation(JunoMotion.handoff(…))` around the state change that ends a
/// draft — the first send, or a call dialled from the empty chat. The composer
/// is not moved by anything but the padding under it, which is what keeps its
/// focus, its draft and its attachments through the move. The greeting and the
/// chips hang off the composer (``ChatComposerDock``) and ride down with it
/// while they fade. Removing them with a transition put them wrong for the
/// length of the fade: a view leaving a stack keeps its old offset inside a
/// stack that is shrinking under it, so the chips surfaced above the composer
/// mid-handoff. So they are never removed. They stay mounted, invisible and
/// untouchable when there is no draft, and move between these three poses.
enum ChatEmptyPose: Equatable {
    /// Before a rise-in: 6pt low and transparent.
    case arriving
    case shown
    /// After a send: transparent, and — for the greeting — 4pt up and a hair
    /// smaller, so the exit reads as receding rather than sliding.
    case left
}

// MARK: - The greeting

/// The empty chat's headline (§4.2): "How can I help, *Liam*?" — or, in a
/// private draft, "You're incognito" and what that means.
///
/// **What it is not.** No Juno mark beside it, no halo behind it, no accent on
/// the name, no time of day. The greeting it replaced drew all four: a mark
/// that pushed the sentence off-centre, a two-layer text shadow that only made
/// sense over a coloured bloom, the name in the account's accent, and a phrase
/// picked at random by hour. The web's greeting is one sentence in Newsreader
/// on warm paper, and that is the whole of this view.
///
/// **One `Text`, interpolated.** The name is a `Text` run inside the sentence's
/// own string, so the sentence wraps as one line of type — two views side by
/// side would break between the comma and the name the moment either grew,
/// and `Text + Text` concatenation is deprecated for exactly that job.
///
/// **Rise-in, once per draft.** It arrives 6pt low and transparent and settles
/// over 220ms, starting from ``ChatEmptyPose/arriving`` so the first frame is
/// the hidden one — the greeting this replaced started its flags at `true` and
/// so never rose at all. A new draft (and a switch into or out of a private
/// draft) rises it again; a send takes it away on the exit curve. Under
/// Reduce Motion both keep their fades and lose their travel.
struct ChatGreeting: View {
    let profileName: String?
    let isPrivate: Bool
    /// The chat column's width, which the size is fluid against.
    let columnWidth: CGFloat
    /// Whether the column is a draft. Off, the greeting leaves and stays
    /// mounted but invisible, so it can rise again for the next draft.
    let isShown: Bool
    /// The agent whose empty thread this is: it greets in its own voice
    /// (``DesktopAgentGreeting``) instead of Juno's.
    var agent: NativeAgent? = nil

    var body: some View {
        // A fresh identity for each mode, so turning a draft private (or back),
        // or opening an agent's thread, is a new greeting arriving rather than
        // the old one changing words.
        ChatGreetingBody(
            profileName: profileName,
            isPrivate: isPrivate,
            columnWidth: columnWidth,
            isShown: isShown,
            agent: agent
        )
        .id("\(isPrivate):\(agent?.id ?? "")")
    }

    /// The first name the greeting addresses: the first word of the account's
    /// name, as the web's `user.name?.trim().split(/\s+/)[0]`. Nil — and "How
    /// can I help?" — when the account has no name.
    static func firstName(from fullName: String?) -> String? {
        fullName?
            .split(whereSeparator: \.isWhitespace)
            .first
            .map(String.init)
    }

    /// The display size for a column `width` points wide: the web's
    /// `clamp(2rem, .3333rem + 4.1667cqi, 3rem)` — 32 at a 640pt column, 48
    /// at 1024, linear between.
    static func size(forColumnWidth width: CGFloat) -> CGFloat {
        JunoType.displaySize(forColumnWidth: width)
    }
}

private struct ChatGreetingBody: View {
    let profileName: String?
    let isPrivate: Bool
    let columnWidth: CGFloat
    let isShown: Bool
    let agent: NativeAgent?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.junoTextScale) private var textScale
    @State private var pose = ChatEmptyPose.arriving
    /// Bumped by every pose change, so a rise that was waiting its turn when
    /// the draft ended does not bring the greeting back over a conversation.
    @State private var generation = 0

    /// The greeting's measure, the web's `max-w-2xl`: a long name wraps to a
    /// second line rather than running the width of a wide window.
    private static let measure: CGFloat = 672

    var body: some View {
        Group {
            if isPrivate {
                privateHeader
            } else if let agent {
                DesktopAgentGreeting(agent: agent, columnWidth: columnWidth)
            } else {
                greeting
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: Self.measure)
        .opacity(pose == .shown ? 1 : 0)
        .scaleEffect(pose == .left ? JunoMotion.scaleFrom(DesktopChoreography.greetingExitScale, reduceMotion: reduceMotion) : 1)
        .offset(y: offset)
        .allowsHitTesting(isShown)
        .accessibilityHidden(!isShown)
        .onAppear { if isShown { rise() } }
        .onChange(of: isShown) { _, shown in
            if shown {
                rise()
            } else {
                generation += 1
                // `--dur-exit` on `--ease-in`: 160ms, and gone before the
                // composer has finished settling.
                withAnimation(JunoMotion.exit) { pose = .left }
            }
        }
    }

    private var offset: CGFloat {
        switch pose {
        case .arriving: JunoMotion.shift(DesktopChoreography.riseDistance, reduceMotion: reduceMotion)
        case .shown: 0
        case .left: JunoMotion.shift(-DesktopChoreography.greetingExitLift, reduceMotion: reduceMotion)
        }
    }

    /// Down to the arriving pose with no animation, then up on the rise-in.
    /// The two cannot share an update — SwiftUI would coalesce them and
    /// animate from wherever the greeting last was — so the rise waits a turn.
    private func rise() {
        generation += 1
        let rising = generation
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { pose = .arriving }
        Task { @MainActor in
            await Task.yield()
            guard generation == rising else { return }
            // The tint tier: under Reduce Motion the fade keeps its 220ms and
            // the offset is already zero, so what is left is opacity.
            withAnimation(JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)) {
                pose = .shown
            }
        }
    }

    private var greeting: some View {
        let size = ChatGreeting.size(forColumnWidth: columnWidth)
        return Group {
            if let name = ChatGreeting.firstName(from: profileName) {
                // The name's run carries its own face — Newsreader's italic —
                // and inherits the sentence's ink. Never the accent (§0.4).
                Text("How can I help, \(Text(name).font(JunoType.displayItalic(size: size).font(scale: textScale)))?")
            } else {
                Text("How can I help?")
            }
        }
        .junoType(.display(size: size))
        .foregroundStyle(Color.junoForeground)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("juno.desktop.chat.greeting")
    }

    /// The web's `PrivateGreeting`: the page-title rung and one line of what
    /// private means, in the web's words.
    private var privateHeader: some View {
        VStack(spacing: JunoSpace.snug) {
            Text("You're incognito")
                .junoPageTitle()
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Text("Chats aren't saved, added to memory, or used to train models.")
                .junoBodyLarge()
                .foregroundStyle(Color.junoSecondaryInk)
                // The web's `max-w-md`.
                .frame(maxWidth: 448)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.desktop.chat.private-greeting")
    }
}

// MARK: - Starter chips

/// One starter chip (§4.3): a word, a glyph, and three example prompts.
///
/// **A chip opens examples; it does not write.** Pressing one unfolds three
/// whole prompts under the row, and picking one seeds the composer with it.
/// **An example seeds; it never sends**: a suggestion that sent itself would
/// spend the reader's allowance on a sentence they did not write. The words
/// are the web's `STARTER_CHIP_COPY`, verbatim (`starter-chips.tsx`).
struct ChatStarterChip: Identifiable, Equatable {
    let label: String
    let icon: JunoIcon
    let examples: [String]

    var id: String { label }

    /// Research it will cite, a draft, code, and a plan: the four things Juno
    /// is for, rather than the "brainstorm / summarize" filler that would
    /// describe any chat product.
    static let all: [ChatStarterChip] = [
        ChatStarterChip(label: "Research", icon: .research, examples: [
            "What does the latest research say about intermittent fasting? Cite the strongest studies.",
            "Compare the three most popular note-taking apps for a small team, with sources.",
            "Summarise what changed in EU AI regulation this year and link the primary texts.",
        ]),
        ChatStarterChip(label: "Write", icon: .pencil, examples: [
            "Draft a short, friendly follow-up email after a job interview.",
            "Write a toast for my sister’s wedding that is warm and under two minutes long.",
            "Turn my rough notes into a clear one-page project update.",
        ]),
        ChatStarterChip(label: "Code", icon: .code, examples: [
            "Write a Python script that renames photos by the date they were taken.",
            "Build a React table component that sorts by any column.",
            "Explain how this regular expression works, one part at a time.",
        ]),
        ChatStarterChip(label: "Plan", icon: .task, examples: [
            "Plan a three-day trip to Lisbon with a mix of food, museums and walks.",
            "Turn my goals for this quarter into a week-by-week plan.",
            "Make a launch checklist for a small product release.",
        ]),
    ]
}

/// The row of starter chips under the draft's composer: centred, wrapping,
/// 8pt apart, on the canvas, not glass (§0.1).
///
/// Dealt in after the greeting (120ms, then 30ms a chip) so the row reads as
/// an answer to the question above it; faded out over 120ms on a send, ahead
/// of the greeting, because they are smaller and lower. Each chip's entrance
/// is its own `animation(_:value:)` with its own delay, which is what lets one
/// state flip stagger four views without four timers. Mounted for the life of
/// the column and untouchable while hidden, for the reason ``ChatEmptyPose``
/// gives.
///
/// **One chip is open at a time.** Its examples hang below the row as an
/// overlay, so opening them never adds to the dock's footer or moves the
/// composer the reader is about to type in. Pressing the chip again, or Esc,
/// folds them away and gives focus back to the chip.
///
/// **The row steps aside once there is a draft** (`hasDraft`): suggestions
/// under a half-written message are for a message the reader is no longer
/// writing. It fades (opacity only, keeping its space so the composer never
/// moves) and leaves the focus order, and comes back when the field is cleared.
struct ChatStarterChips: View {
    /// Whether the column is an ordinary draft, not private and not sent.
    let isShown: Bool
    /// Whether the composer holds any text.
    var hasDraft: Bool = false
    /// Snapshots draw a chip open; the app never sets it.
    var startsOpen: String? = nil
    let seed: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pose = ChatEmptyPose.arriving
    /// The greeting's guard against a late deal, for the same reason.
    @State private var generation = 0
    /// The chip whose examples are showing.
    @State private var openLabel: String?
    @FocusState private var focusedChip: String?
    /// The chip row's height, which the examples hang below.
    @State private var rowHeight: CGFloat = JunoChipMetrics.height

    /// Hidden by a draft, not by the landing ending: a fade, never a re-deal.
    private var isAvailable: Bool { isShown && !hasDraft }

    private var open: ChatStarterChip? {
        ChatStarterChip.all.first { $0.label == openLabel }
    }

    var body: some View {
        JunoChipFlow(
            spacing: JunoChipMetrics.spacing,
            lineSpacing: JunoChipMetrics.spacing,
            alignment: .center
        ) {
            ForEach(Array(ChatStarterChip.all.enumerated()), id: \.element.id) { index, chip in
                chipButton(chip, index: index)
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeight = $0 }
        // Hung below the row, outside its layout: the list's top sits 12pt
        // under the row's foot, at its own height, and the row's own height
        // never changes.
        .overlay(alignment: .top) {
            if let open, isAvailable {
                ChatStarterExamples(chip: open) { prompt in
                    seed(prompt)
                    openLabel = nil
                }
                .fixedSize(horizontal: false, vertical: true)
                .offset(y: rowHeight + JunoSpace.cozy)
                .id(open.label)
                .transition(.opacity)
            }
        }
        .opacity(hasDraft ? 0 : 1)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hasDraft)
        .allowsHitTesting(isAvailable)
        .accessibilityHidden(!isAvailable)
        .onKeyPress(.escape) {
            guard let label = openLabel else { return .ignored }
            openLabel = nil
            focusedChip = label
            return .handled
        }
        .onAppear {
            if isShown { deal() }
            if let startsOpen { openLabel = startsOpen }
        }
        .onChange(of: isShown) { _, shown in
            if shown {
                deal()
            } else {
                generation += 1
                openLabel = nil
                pose = .left
            }
        }
        // A draft closes the list along with the row, so it is not still
        // open when the row comes back.
        .onChange(of: hasDraft) { _, drafting in
            if drafting { openLabel = nil }
        }
    }

    private func chipButton(_ chip: ChatStarterChip, index: Int) -> some View {
        let expanded = openLabel == chip.label
        return Button {
            toggle(chip)
        } label: {
            Label {
                Text(chip.label)
            } icon: {
                JunoIconView(chip.icon, size: JunoChipMetrics.glyphSize)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(JunoChipStyle(isSelected: expanded))
        .focused($focusedChip, equals: chip.label)
        .accessibilityHint(expanded ? "Hides the examples" : "Shows example prompts")
        .accessibilityAddTraits(expanded ? .isSelected : [])
        .accessibilityIdentifier("juno.desktop.chat.starter.\(chip.label.lowercased())")
        .opacity(pose == .shown ? 1 : 0)
        .offset(y: pose == .arriving ? JunoMotion.shift(DesktopChoreography.chipRise, reduceMotion: reduceMotion) : 0)
        // Dealt in one at a time; taken away all at once.
        .animation(dealAnimation(index: index), value: pose)
    }

    private func dealAnimation(index: Int) -> Animation? {
        switch pose {
        case .shown:
            let delay = DesktopChoreography.chipsBeat + DesktopChoreography.chipStagger * Double(index)
            return JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)?.delay(delay)
        case .left:
            return JunoMotion.fast
        default:
            return nil
        }
    }

    private func toggle(_ chip: ChatStarterChip) {
        let next: String? = openLabel == chip.label ? nil : chip.label
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
            openLabel = next
        }
    }

    /// Back to the arriving pose, then dealt in a turn later — the same
    /// reason as the greeting's rise.
    private func deal() {
        generation += 1
        let dealing = generation
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { pose = .arriving }
        Task { @MainActor in
            await Task.yield()
            guard generation == dealing else { return }
            pose = .shown
        }
    }
}

/// The open chip's three examples: plain rows between hairlines, muted at rest
/// and foreground under the pointer the way a menu row lights, at most 576pt
/// wide (the web's `max-w-xl divide-y divide-border/60`). Three prompts in
/// full ink would read as a paragraph competing with the greeting.
struct ChatStarterExamples: View {
    let chip: ChatStarterChip
    let pick: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(chip.examples.enumerated()), id: \.element) { index, prompt in
                if index > 0 {
                    Rectangle()
                        .fill(Color.junoBorder.opacity(0.6))
                        .frame(height: 1)
                        .accessibilityHidden(true)
                }
                Button {
                    pick(prompt)
                } label: {
                    Text(verbatim: prompt)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(ChatStarterExampleRowStyle())
                .padding(.vertical, 2)
                .accessibilityHint("Puts this prompt in the message field")
                .accessibilityIdentifier("juno.desktop.chat.starter.example.\(index)")
            }
        }
        .frame(maxWidth: 576)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(chip.label)
    }
}

/// A menu row on the canvas: 28pt, the control radius, hover wash.
private struct ChatStarterExampleRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false

        var body: some View {
            configuration.label
                .junoType(.ui)
                .multilineTextAlignment(.leading)
                .foregroundStyle(hovered || configuration.isPressed ? Color.junoForeground : Color.junoSecondaryInk)
                .padding(.horizontal, JunoSpace.cozy)
                .padding(.vertical, 6)
                .frame(minHeight: 28)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                        .fill(configuration.isPressed ? Color.junoSelectedFill : hovered ? Color.junoHover : Color.clear)
                )
                .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
                .onHover { hovered = $0 }
        }
    }
}
