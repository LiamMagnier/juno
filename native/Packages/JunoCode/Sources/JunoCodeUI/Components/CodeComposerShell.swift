import JunoDesignSystem
import SwiftUI

/// The composer, as **one** pane of glass.
///
/// **This is the fix for the visible seam.** The composer used to be two glass
/// elements stacked with a negative gap: a target-picker bar in
/// `JunoRadius.well` (10) sitting on the input in `JunoRadius.composer` (26),
/// each at a different width, each sampling the content behind it
/// independently. The join was visible as two different corner curves meeting
/// at two different insets — which is exactly the failure
/// `GlassEffectContainer` exists to prevent, and exactly what "one Liquid Glass
/// layer per screen" means in practice.
///
/// What replaced it is one glass element in one shape. The three regions —
/// where this runs, what you are asking for, and what you can do about it — sit
/// *inside* that shape with nothing but spacing between them: no hairline, no
/// second fill, no second edge. The context strip is a row of quiet chips at
/// the top of the same surface, the way the Codex app puts "repo · Local ·
/// main" above its field; a thread screen passes none and gets no strip.
///
/// The shell states its corner **once** and publishes it as the container
/// shape, so anything nested inside — a chip, an attachment thumbnail, an
/// inline notice — takes `ConcentricRectangle()` and derives its corner from
/// this one instead of carrying a literal.
///
/// Note the asymmetry, which is easy to state backwards: the *shell* is a
/// `RoundedRectangle` and only its *children* are concentric. `containerShape`
/// requires a `RoundedRectangularShape`, and `ConcentricRectangle` deliberately
/// is not one — it is the shape that reads a container, never the shape that is
/// one.
@available(macOS 26.0, *)
public struct CodeComposerShell<Context: View, Input: View, Actions: View>: View {
    private let tint: Color?
    private let maxWidth: CGFloat
    private let context: Context
    private let input: Input
    private let actions: Actions

    /// - Parameters:
    ///   - tint: full-alpha or nil, never a diluted accent. `Glass.tint(_:)`
    ///     honours alpha, so a faded tint stops establishing a predictable
    ///     luminance and the text on it reads against whatever is behind the
    ///     window. A drag hovering over the composer is its one moment of full
    ///     emphasis.
    ///   - context: the run's destination — project, where it executes, branch
    ///     — as small chips inside the same glass. Pass `EmptyView()` for none.
    public init(
        tint: Color? = nil,
        maxWidth: CGFloat = 680,
        @ViewBuilder context: () -> Context,
        @ViewBuilder input: () -> Input,
        @ViewBuilder actions: () -> Actions
    ) {
        self.tint = tint
        self.maxWidth = maxWidth
        self.context = context()
        self.input = input()
        self.actions = actions()
    }

    /// The shell's outline, and the reference every corner inside it is
    /// concentric *to*.
    private var shellShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: JunoRadius.composer, style: .continuous)
    }

    private var hasContext: Bool { Context.self != EmptyView.self }

    public var body: some View {
        // One container, one participant. The container is what tells the
        // system this is a single glass surface rather than a stack of panes,
        // and it is what the send button's own glass blends against as it
        // approaches the shell's edge.
        GlassEffectContainer(spacing: JunoSpace.snug) {
            VStack(spacing: 0) {
                if hasContext {
                    context
                        .padding(.horizontal, JunoSpace.cozy)
                        .padding(.top, JunoSpace.cozy)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                input

                actions
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.bottom, JunoSpace.snug)
            }
            .frame(maxWidth: maxWidth)
            .junoGlass(in: shellShape, tint: tint)
            .containerShape(shellShape)
        }
    }
}

/// One fact about where a task lands — "juno", "Local", "main" — as a quiet
/// chip inside the composer's context strip. A menu when the fact can be
/// changed, plain text when it cannot.
public struct CodeContextChip: View {
    private let title: String
    private let icon: JunoIcon
    private let tint: Color?

    public init(_ title: String, icon: JunoIcon, tint: Color? = nil) {
        self.title = title
        self.icon = icon
        self.tint = tint
    }

    public var body: some View {
        HStack(spacing: JunoSpace.hairline) {
            JunoIconView(icon, size: 12)
            Text(title)
                .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundStyle(tint ?? Color.junoMutedForeground)
        .padding(.horizontal, JunoSpace.snug)
        .frame(height: 24)
        .background(
            Color.junoMuted.opacity(0.55),
            in: RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
        )
        .frame(minHeight: 44)
        .contentShape(RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous))
    }
}
