import JunoDesignSystem
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

    var body: some View {
        // A fresh identity for each mode, so turning a draft private (or back)
        // is a new greeting arriving rather than the old one changing words.
        ChatGreetingBody(
            profileName: profileName,
            isPrivate: isPrivate,
            columnWidth: columnWidth,
            isShown: isShown
        )
        .id(isPrivate)
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

/// One starter chip (§4.3): a word, a glyph, and the sentence it starts.
///
/// **They seed; they never send.** Each seed ends in a space and stops where
/// the reader's own subject begins — a chip that wrote the whole question
/// would be a demo, and one that sent it would spend the reader's allowance on
/// a sentence they did not write. The seeds are the web's, verbatim
/// (`starter-chips.tsx`).
struct ChatStarterChip: Identifiable, Equatable {
    let label: String
    let icon: JunoIcon
    let seed: String

    var id: String { label }

    /// Research it will cite, a draft, code, and a plan — the four things Juno
    /// is for, rather than the "brainstorm / summarize" filler that would
    /// describe any chat product. Plan seeds a sentence and arms nothing.
    static let all: [ChatStarterChip] = [
        ChatStarterChip(label: "Research", icon: .research, seed: "Research and cite sources on "),
        ChatStarterChip(label: "Write", icon: .pencil, seed: "Help me write "),
        ChatStarterChip(label: "Code", icon: .code, seed: "Write code that "),
        ChatStarterChip(label: "Plan", icon: .task, seed: "Plan the steps to "),
    ]
}

/// The row of starter chips under the draft's composer: centred, wrapping,
/// 8pt apart, on the canvas — not glass (§0.1).
///
/// Dealt in after the greeting — 120ms, then 30ms a chip — so the row reads as
/// an answer to the question above it; faded out over 120ms on a send, ahead
/// of the greeting, because they are smaller and lower. Each chip's entrance
/// is its own `animation(_:value:)` with its own delay, which is what lets one
/// state flip stagger four views without four timers. Mounted for the life of
/// the column and untouchable while hidden, for the reason ``ChatEmptyPose``
/// gives.
struct ChatStarterChips: View {
    /// Whether the column is an ordinary draft — not private, not sent.
    let isShown: Bool
    let seed: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pose = ChatEmptyPose.arriving
    /// The greeting's guard against a late deal, for the same reason.
    @State private var generation = 0

    var body: some View {
        JunoChipFlow(
            spacing: JunoChipMetrics.spacing,
            lineSpacing: JunoChipMetrics.spacing,
            alignment: .center
        ) {
            ForEach(Array(ChatStarterChip.all.enumerated()), id: \.element.id) { index, chip in
                Button {
                    seed(chip.seed)
                } label: {
                    Label {
                        Text(chip.label)
                    } icon: {
                        JunoIconView(chip.icon, size: JunoChipMetrics.glyphSize)
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(JunoChipStyle())
                .accessibilityHint("Starts your message with “\(chip.seed.trimmingCharacters(in: .whitespaces))”")
                .accessibilityIdentifier("juno.desktop.chat.starter.\(chip.label.lowercased())")
                .opacity(pose == .shown ? 1 : 0)
                .offset(y: pose == .arriving ? JunoMotion.shift(DesktopChoreography.chipRise, reduceMotion: reduceMotion) : 0)
                // Dealt in one at a time; taken away all at once.
                .animation(
                    pose == .shown
                        ? JunoMotion.reduced(JunoMotion.riseIn, when: reduceMotion, tier: .tint)?
                            .delay(DesktopChoreography.chipsBeat + DesktopChoreography.chipStagger * Double(index))
                        : pose == .left ? JunoMotion.fast : nil,
                    value: pose
                )
            }
        }
        .frame(maxWidth: .infinity)
        .allowsHitTesting(isShown)
        .accessibilityHidden(!isShown)
        .onAppear { if isShown { deal() } }
        .onChange(of: isShown) { _, shown in
            if shown {
                deal()
            } else {
                generation += 1
                pose = .left
            }
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
