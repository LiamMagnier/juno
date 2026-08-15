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
/// where this runs, what you are asking for, and what you can do about it — are
/// separated by hairlines *inside* that shape rather than by second shapes on
/// top of it. There is no seam left to mismatch, because there is no second
/// edge.
///
/// The shell states its corner **once** and publishes it as the container
/// shape, so anything nested inside — a chip, an attachment thumbnail, an
/// inline notice — takes `ConcentricRectangle()` and derives its corner from
/// this one instead of carrying a literal. The composer is the one place in
/// Juno Code where three levels of rounded container nest, so it is the one
/// place where getting that wrong is most visible.
///
/// Note the asymmetry, which is easy to state backwards: the *shell* is a
/// `RoundedRectangle` and only its *children* are concentric. `containerShape`
/// requires a `RoundedRectangularShape`, and `ConcentricRectangle` deliberately
/// is not one — it is the shape that reads a container, never the shape that is
/// one. `shellShape` below carries the same explanation at the point it
/// matters. An earlier draft of this paragraph claimed the shell itself was a
/// `ConcentricRectangle`, which the file then refuted forty lines later.
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
    ///   - context: the run's destination — project, branch, where it executes.
    ///     Drawn as the shell's top region, inside the same glass.
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
    ///
    /// `containerShape` takes a `RoundedRectangularShape`, which
    /// ``ConcentricRectangle`` deliberately is not — it is the shape that
    /// *reads* a container rather than one that can be a container. So the
    /// shell states its corner once, here, and hands it down through
    /// `containerShape`; nested content then draws `ConcentricRectangle()` and
    /// derives its own corner from this one.
    private var shellShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: JunoRadius.composer, style: .continuous)
    }

    public var body: some View {
        // One container, one participant. The container is what tells the
        // system this is a single glass surface rather than a stack of panes,
        // and it is what the send button's own glass blends against as it
        // approaches the shell's edge.
        GlassEffectContainer(spacing: JunoSpace.snug) {
            VStack(spacing: 0) {
                context
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)

                // A hairline, not a `Divider`: `Divider` inside a glass surface
                // draws the platform's opaque separator, which is a painted
                // line on a material that is already carrying its own edge.
                Rectangle()
                    .fill(Color.junoHairline)
                    .frame(height: 1)
                    .accessibilityHidden(true)

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
