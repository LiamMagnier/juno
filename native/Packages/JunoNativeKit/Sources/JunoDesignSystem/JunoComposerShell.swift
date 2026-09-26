import SwiftUI

/// The composer's geometry (§5.1–§5.2 of `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`),
/// in one place so the shell, the app's controls and the tests read the same
/// numbers.
///
/// **Why the numbers are what they are.** The field row's 16pt leading inset and
/// the controls row's 10pt one are chosen against each other: a 28pt `+` target
/// with a 16pt glyph centred in it, 10pt in from the edge, puts the glyph's left
/// edge at 16 — on the same vertical as the first character of the draft. The
/// 10pt cluster spacing is deliberately larger than the 8pt container spacing,
/// so the shell and anything else in the cluster (Scroll to latest, the
/// follow-up chips) never melt into one another while they sit still.
public enum JunoComposerMetrics {
    /// The transcript's reading measure. The composer and the transcript are one
    /// column, so they read one number for it.
    public static let maxWidth: CGFloat = JunoReadingMeasure.reading
    /// The shell's radius: the web's `rounded-composer`, the panel rung.
    public static let cornerRadius: CGFloat = JunoRadius.panel
    /// How close two glass shapes in the cluster may come before the container
    /// starts blending them.
    public static let containerSpacing: CGFloat = JunoSpace.snug
    /// The gap between the cluster's rows — larger than ``containerSpacing`` on
    /// purpose, so shapes never merge at rest.
    public static let clusterSpacing: CGFloat = JunoSpace.close
    /// The above slot's inset: attachment tiles and cards sit this far in.
    public static let aboveInset: CGFloat = JunoSpace.cozy
    /// The field row: h16, top 14, bottom 6.
    public static let fieldInsets = EdgeInsets(top: 14, leading: 16, bottom: 6, trailing: 16)
    /// One line of the 15pt draft at the body rung's 1.6 line height.
    public static let fieldMinimumHeight: CGFloat = 24
    /// The controls row: h10, top 2, bottom 10.
    public static let controlsInsets = EdgeInsets(top: 2, leading: 10, bottom: 10, trailing: 10)
    /// The Mac's pointer-control height (§0.6). Every control on the row is this
    /// tall; nothing in the composer is sized for a finger.
    public static let controlHeight: CGFloat = 28
    /// Between the controls on the row.
    public static let controlSpacing: CGFloat = JunoSpace.hairline
}

/// The composer cluster: one `GlassEffectContainer` holding the composer shell
/// and whatever floats with it, and the **one** custom glass shape in a chat
/// window (§0.1, §5.1).
///
/// **One component for every composer.** Chat drafts, conversations, the project
/// overview, private mode and Quick Entry all build on this. It replaced five
/// implementations that each owned a different amount of glass — a bar, a send
/// button, a model chip, a thinking chip and a microphone each sampling the
/// canvas on their own — which is why the composer used to read as five
/// materials on one row.
///
/// **Slots, top to bottom.**
/// - `accessory` — conversation-only things that ride above the cluster: Scroll
///   to latest (glass, its own shape in this container) and the follow-up chips
///   (opaque). Empty everywhere else.
/// - `captionAbove` — plain text rows outside the shell: the quota line, "New
///   chat in {Project}", a queued turn, an error. **Not glass.**
/// - `above` — inside the shell, inset 12: attachments, the long-paste card.
///   Inner cards use ``JunoRadius/concentric(minimum:)``, which resolves against
///   the shell's container shape.
/// - `field` — the field row: armed marks, then the draft.
/// - `disclosure` — the task-run disclosure line (Phase 5). Empty today.
/// - `controls` — the controls row, 28pt tall.
/// - `edge` — drawn over the shell: the private dashed edge or the drop-target
///   edge. The two strokes the design allows on the glass.
/// - `captionBelow` — the private footnote.
///
/// **What the shell never draws.** No glass on any control inside it, no
/// stroke, no shadow, no tint: the material supplies the depth, and anything
/// laid over its rim flattens the light it scatters. Focus has no ring either —
/// the caret is the focus signal.
///
/// **Accessibility.** Under Reduce Transparency the glass gives way to the
/// web's own recipe, an opaque card with a hairline, so the draft never reads
/// through a blur the reader asked to be rid of. Under Increase Contrast the
/// glass gains a hairline edge, which is the one case the rim needs help to
/// read as a boundary.
public struct JunoComposerShell<
    Accessory: View,
    CaptionAbove: View,
    Above: View,
    Field: View,
    Disclosure: View,
    Controls: View,
    Edge: View,
    CaptionBelow: View
>: View {
    private let accessory: Accessory
    private let captionAbove: CaptionAbove
    private let above: Above
    private let field: Field
    private let disclosure: Disclosure
    private let controls: Controls
    private let edge: Edge
    private let captionBelow: CaptionBelow

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.colorSchemeContrast) private var contrast

    public init(
        @ViewBuilder accessory: () -> Accessory,
        @ViewBuilder captionAbove: () -> CaptionAbove,
        @ViewBuilder above: () -> Above,
        @ViewBuilder field: () -> Field,
        @ViewBuilder disclosure: () -> Disclosure,
        @ViewBuilder controls: () -> Controls,
        @ViewBuilder edge: () -> Edge,
        @ViewBuilder captionBelow: () -> CaptionBelow
    ) {
        self.accessory = accessory()
        self.captionAbove = captionAbove()
        self.above = above()
        self.field = field()
        self.disclosure = disclosure()
        self.controls = controls()
        self.edge = edge()
        self.captionBelow = captionBelow()
    }

    public var body: some View {
        // One container for the whole cluster. Anything else that is glass in
        // it — Scroll to latest, from Phase 2 — samples the same backdrop as the
        // shell and morphs with it, instead of seaming where the two meet.
        GlassEffectContainer(spacing: JunoComposerMetrics.containerSpacing) {
            VStack(spacing: JunoComposerMetrics.clusterSpacing) {
                accessory
                captionAbove
                shell
                captionBelow
            }
        }
        .frame(maxWidth: JunoComposerMetrics.maxWidth)
    }

    /// The shell itself: four rows on one glass shape.
    ///
    /// Each slot is padded here rather than by its caller, so the geometry in
    /// §5.2 has one owner. An empty slot contributes nothing — a modifier on a
    /// slot with no views in it lays out no views — so a draft with no
    /// attachments has no 12pt gap where the tiles would be.
    private var shell: some View {
        VStack(alignment: .leading, spacing: 0) {
            above
                .padding(.top, JunoComposerMetrics.aboveInset)
                .padding(.horizontal, JunoComposerMetrics.aboveInset)

            field
                .frame(
                    maxWidth: .infinity,
                    minHeight: JunoComposerMetrics.fieldMinimumHeight,
                    alignment: .topLeading
                )
                .padding(JunoComposerMetrics.fieldInsets)

            disclosure
                .padding(.horizontal, JunoComposerMetrics.fieldInsets.leading)

            controls
                .frame(height: JunoComposerMetrics.controlHeight)
                .padding(JunoComposerMetrics.controlsInsets)
        }
        // Inside the container shape, so the edges' `ContainerRelativeShape`
        // resolves to the shell's radius rather than to whatever encloses it.
        .overlay { edge }
        // Declared on the view that owns the padding, so every inset child that
        // asks for `ConcentricRectangle()` resolves against this radius less its
        // own inset — the native form of the web's concentric-radius rule.
        .containerShape(.rect(cornerRadius: JunoComposerMetrics.cornerRadius))
        .modifier(
            JunoComposerSurface(
                reduceTransparency: reduceTransparency || snapshotOpaqueGlass,
                increaseContrast: contrast == .increased
            )
        )
        // The caret is the only focus signal. A focus ring on a glass rim is a
        // second rim.
        .focusEffectDisabled()
    }
}

public extension JunoComposerShell
where Accessory == EmptyView, Disclosure == EmptyView {
    /// A shell with no cluster accessory and no disclosure line — every
    /// composer until Phase 2 adds Scroll to latest and Phase 5 adds the task
    /// disclosure.
    init(
        @ViewBuilder captionAbove: () -> CaptionAbove,
        @ViewBuilder above: () -> Above,
        @ViewBuilder field: () -> Field,
        @ViewBuilder controls: () -> Controls,
        @ViewBuilder edge: () -> Edge,
        @ViewBuilder captionBelow: () -> CaptionBelow
    ) {
        self.init(
            accessory: { EmptyView() },
            captionAbove: captionAbove,
            above: above,
            field: field,
            disclosure: { EmptyView() },
            controls: controls,
            edge: edge,
            captionBelow: captionBelow
        )
    }
}

public extension EnvironmentValues {
    /// Draws the composer's glass as its Reduce Transparency recipe — the
    /// web's opaque card and hairline. For the offscreen snapshot harness
    /// only: Liquid Glass is composited by the window server, so a view drawn
    /// with `cacheDisplay` shows no shell at all. Production never sets it.
    @Entry var junoSnapshotOpaqueGlass = false
}

public extension View {
    /// Chat's composer material on another composer — Code's — so the two
    /// products type into the same surface: native Liquid Glass inside its own
    /// `GlassEffectContainer`, or, under Reduce Transparency (and in the
    /// offscreen snapshot harness), the web's opaque card with a hairline;
    /// a hairline edge under Increase Contrast. The one composer material,
    /// owned by this file so the glass gate's allow-list stays one site.
    func junoComposerGlass(cornerRadius: CGFloat = JunoComposerMetrics.cornerRadius) -> some View {
        modifier(JunoComposerGlassHost(cornerRadius: cornerRadius))
    }
}

private struct JunoComposerGlassHost: ViewModifier {
    let cornerRadius: CGFloat

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.junoSnapshotOpaqueGlass) private var snapshotOpaqueGlass
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        GlassEffectContainer(spacing: JunoComposerMetrics.containerSpacing) {
            content
                .containerShape(.rect(cornerRadius: cornerRadius))
                .modifier(
                    JunoComposerSurface(
                        reduceTransparency: reduceTransparency || snapshotOpaqueGlass,
                        increaseContrast: contrast == .increased,
                        cornerRadius: cornerRadius
                    )
                )
        }
    }
}

/// The shell's material: Liquid Glass, or the opaque card that stands in for it.
///
/// A modifier rather than two branches of the shell, so the rows inside keep
/// their identity when the reader toggles Reduce Transparency with a draft in
/// the field.
private struct JunoComposerSurface: ViewModifier {
    let reduceTransparency: Bool
    let increaseContrast: Bool
    var cornerRadius: CGFloat = JunoComposerMetrics.cornerRadius

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    func body(content: Content) -> some View {
        if reduceTransparency {
            // The web's composer, which is opaque on purpose: the card fill and
            // one hairline, at full strength when contrast is raised too.
            content
                .background(Color.junoCard, in: shape)
                .overlay {
                    shape.strokeBorder(
                        Color.junoBorder.opacity(JunoHairline.opacity(increaseContrast: increaseContrast)),
                        lineWidth: 1
                    )
                }
        } else {
            content
                .glassEffect(.regular, in: shape)
                .overlay {
                    if increaseContrast {
                        shape.strokeBorder(Color.junoBorder, lineWidth: 1)
                    }
                }
        }
    }
}

// MARK: - Edges

/// Private mode's edge: one dashed hairline in secondary ink (§5.8).
///
/// The only way private mode changes the composer's look — the same composer,
/// the same controls, a boundary that reads as provisional. Never coral: the
/// accent is the send disc's.
public struct JunoComposerPrivateEdge: View {
    public init() {}

    public var body: some View {
        ContainerRelativeShape()
            .strokeBorder(
                Color.junoSecondaryInk.opacity(0.5),
                style: StrokeStyle(lineWidth: 1, dash: [4, 4])
            )
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The drop target's edge: a dashed 1.5pt line inset 4, and what a drop will do
/// (§5.8).
///
/// Secondary ink rather than coral (§0.4): a file hovering over the composer is
/// a state, not the one action on the surface.
public struct JunoComposerDropEdge: View {
    private let label: String

    public init(label: String) {
        self.label = label
    }

    public var body: some View {
        ZStack {
            ContainerRelativeShape()
                .inset(by: 4)
                .strokeBorder(
                    Color.junoSecondaryInk,
                    style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])
                )
            Text(label)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
    }
}
