#if os(macOS)
import SwiftUI

/// The desktop chrome vocabulary: the small set of decisions every Juno macOS
/// screen shares, so a new page cannot invent its own sidebar, its own selection
/// shape or its own idea of what may be translucent.
///
/// The governing rule is the one ``JunoSurfaces`` already states — *the canvas is
/// quiet, the chrome carries the material* — expressed here as callable API
/// rather than as a comment a view author has to remember. Three consequences
/// follow, and they are the reason this file exists:
///
/// 1. **Nothing paints a background behind a sidebar or a toolbar.** Those
///    regions are vibrant on macOS. An opaque fill turns a native source list
///    into a grey slab, which is precisely the mistake this vocabulary exists to
///    make unavailable.
/// 2. **Selection is the system's.** `List(selection:)` in `.sidebar` style
///    already draws the focused/unfocused accent states, honours Increase
///    Contrast and Reduce Transparency, and animates with the platform. A
///    hand-rolled `RoundedRectangle` filled with `Color.primary.opacity(0.065)`
///    matches none of that and drifts the moment the platform moves. Juno only
///    supplies the *colour*, through `junoSidebarSelectionTint()`.
/// 3. **Glass is for things that float.** The composer, a transient control
///    group, a floating preview control. Never behind a transcript, a diff, a
///    terminal or a file's contents.
///
/// The glass half of this vocabulary is gated to macOS 26, where Liquid Glass
/// ships. The Juno desktop app's own floor is macOS 26, so from the app's side
/// these calls need no availability check and carry no material fallback branch
/// — a fallback path that never runs is a second design nobody reviews. The gate
/// exists only because this package is also compiled for the phone app, whose
/// floor is lower.

// MARK: - Column metrics

/// The navigation column's resize range.
///
/// A fixed-width sidebar was the single most un-Mac-like thing about the first
/// desktop shell: every real Mac source list can be dragged, and the width a
/// user picks is part of how they arrange their window. `ideal` is the width the
/// window opens at; `minimum` still fits the longest destination label
/// ("Connections") without truncating; `maximum` stops the column from eating
/// the reading canvas.
public enum JunoSidebarMetrics {
    public static let minimum: CGFloat = 208
    public static let ideal: CGFloat = 264
    public static let maximum: CGFloat = 380
}

/// The inspector column's resize range. Narrower than the sidebar because it
/// carries labelled values and short prose, not a navigable list.
public enum JunoInspectorMetrics {
    public static let minimum: CGFloat = 260
    public static let ideal: CGFloat = 320
    public static let maximum: CGFloat = 460
}

public extension View {
    /// Applies Juno's resizable navigation-column range.
    func junoSidebarColumn() -> some View {
        navigationSplitViewColumnWidth(
            min: JunoSidebarMetrics.minimum,
            ideal: JunoSidebarMetrics.ideal,
            max: JunoSidebarMetrics.maximum
        )
    }

    /// The opaque reading surface: a transcript, a report, a diff, a file, a
    /// terminal.
    ///
    /// Opaque on purpose. Long-form text over a translucent surface picks up
    /// whatever is behind the window and loses contrast as the user moves it,
    /// which is why the brief forbids glass here. Chrome floating *over* this
    /// surface is what carries the material.
    ///
    /// **Apply it once, at the window level** — on the `NavigationSplitView`'s
    /// detail column, or on a sheet's root — and never again inside a page. The
    /// canvas is a *backdrop*: content belongs on ``SwiftUI/View/junoCard(cornerRadius:)``
    /// above it, with the warm ground showing around and between, exactly as the
    /// web puts white `--card` surfaces on `--background`. A page that repaints
    /// the canvas over its own content is what turns the window into one flat
    /// cream field, and it is why a floating composer over it read as a solid
    /// pill: glass laid on a freshly-painted fill has nothing to refract.
    func junoReadingCanvas() -> some View {
        background(Color.junoCanvasWarm)
    }

    /// A panel one step off the canvas: a code block, a table, an inspector card.
    ///
    /// A solid fill rather than a material, for the same contrast reason — but
    /// with the system's continuous corner curve so a card nested in a panel
    /// reads as concentric instead of mixing radii.
    ///
    /// Prefer ``SwiftUI/View/junoCard(cornerRadius:)`` for anything that reads as
    /// a *card* on the canvas — it adds the web's hairline and soft throw. This
    /// stays for fills nested inside an already-raised surface, where a second
    /// border and a second shadow would just be noise.
    func junoPanel(cornerRadius: CGFloat = JunoRadius.panel) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.junoRaised)
        )
    }
}

// MARK: - Source-list selection

public extension View {
    /// Makes a `.sidebar`-style `List` resolve its selection to the web's
    /// `--sidebar-accent` instead of to Juno's coral.
    ///
    /// macOS draws the focused selection of a source list in the **app's accent**,
    /// and Juno's accent asset is coral — so every selected row came out as a
    /// full-width saturated coral bar, which is nothing like the web shell, where
    /// the active row is `bg-sidebar-accent`: a warm grey barely a step off the
    /// column. Coral on the web is spent on *one* primary action, never on a whole
    /// row.
    ///
    /// This is a tint, not a hand-drawn highlight, and that distinction is the
    /// whole point. `List(selection:)` keeps drawing the selection itself, so
    /// arrow-key navigation, type-select, the focus ring, the inactive-window
    /// state, Increase Contrast and Reduce Transparency all keep working; Juno
    /// only says what colour the fill is. A `RoundedRectangle` painted behind the
    /// row would match none of that.
    ///
    /// Pair it with ``junoSidebarRowInk()`` on the rows — see there for why the
    /// two are not one modifier.
    func junoSidebarSelectionTint() -> some View {
        tint(Color.junoSidebarSelection)
    }

    /// Pins a source-list row's ink so a pale selection cannot invert it.
    ///
    /// A selected, focused row is *emphasised*: the platform pushes a white
    /// foreground style into the row so a label stays legible on a saturated
    /// accent. That is right for coral and catastrophic for the warm grey
    /// ``junoSidebarSelectionTint()`` installs — white on `--sidebar-accent` is
    /// invisible. The web says the same thing in one class: the active row is
    /// `bg-sidebar-accent text-foreground`, not inverted text.
    ///
    /// An explicit colour set *inside* the row wins over the emphasis style the
    /// row container pushes in, which is why this cannot live on the `List`
    /// alongside the tint: applied there it would sit above the emphasis and lose.
    /// `Color.primary` rather than the hierarchical `.primary` for the same
    /// reason — the hierarchical level resolves against whatever style is current,
    /// including the emphasised one. Nested `.secondary` glyphs still work: they
    /// resolve as a quieter step off this colour.
    func junoSidebarRowInk() -> some View {
        foregroundStyle(Color.primary)
    }
}

// MARK: - Liquid Glass

/// A Liquid Glass container for a group of floating controls.
///
/// The container is not decoration. It is what tells the system which glass
/// elements belong to one another, so they refract a shared sample of the
/// content behind them and blend as they approach, instead of each sampling
/// independently and seaming where they meet. One glass element outside a
/// container is a lone pane; several inside one are a system.
@available(macOS 26.0, *)
public struct JunoDesktopGlass<Content: View>: View {
    private let spacing: CGFloat?
    private let content: Content

    public init(spacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    public var body: some View {
        GlassEffectContainer(spacing: spacing) { content }
    }
}

@available(macOS 26.0, *)
public extension View {
    /// Real Liquid Glass in `shape`.
    ///
    /// `interactive` is what makes glass respond to the pointer — it flexes and
    /// scatters light under a press. It belongs on anything clickable and
    /// nowhere else: a static panel that reacts to the pointer reads as a
    /// control the user cannot find.
    func junoGlass(
        in shape: some Shape,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
    }

    /// The floating-chrome treatment: glass in the floating radius.
    ///
    /// Deliberately draws no border. Real glass carries its own edge — a light
    /// scatter at the rim that reads as thickness. Stroking a hairline over it
    /// flattens that back into a translucent rounded rectangle, which is the
    /// hand-rolled look the brief rules out.
    func junoFloatingChrome(cornerRadius: CGFloat = JunoRadius.floating) -> some View {
        junoGlass(
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
    }

    /// Marks a glass element so the system animates it *as glass* — materialising
    /// rather than cross-fading. Without an id the container has nothing to track
    /// the element by across the transition.
    func junoGlassID(_ id: some Hashable & Sendable, in namespace: Namespace.ID) -> some View {
        glassEffectID(id, in: namespace)
            .glassEffectTransition(.materialize)
    }

    /// A secondary floating action, in the system's own glass button style.
    ///
    /// `.buttonStyle(.glass)` is a real component: it brings the press flex, the
    /// light scatter, and the platform's own shape and metrics, and it keeps up
    /// when those change. A hand-rolled capsule with a glass background looks
    /// similar today and drifts from the platform the moment the platform moves.
    func junoGlassButton() -> some View {
        buttonStyle(.glass)
    }

    /// The one primary action on a surface.
    func junoProminentGlassButton() -> some View {
        buttonStyle(.glassProminent).tint(Color.junoAccent)
    }

    /// A circular accent-tinted glass action — the composer's send/stop/voice
    /// button, and anything else that is the single obvious next step.
    ///
    /// The tint fades rather than the shape changing when the action is
    /// unavailable, so the control keeps its position and the pointer does not
    /// have to re-find it between states. Pair it with
    /// ``Color/junoOnAccent`` for the glyph, never a literal white: the accent is
    /// an account setting and white fails contrast on two of the five palettes.
    func accentGlassAction(active: Bool) -> some View {
        buttonStyle(.plain)
            .junoGlass(
                in: Circle(),
                tint: Color.junoAccent.opacity(active ? 0.95 : 0.32),
                interactive: true
            )
    }
}

// MARK: - Detail pages

/// A centred page of content in a detail column.
///
/// **This exists to stop a detail surface from resizing the window.** A
/// `NavigationSplitView` asks its detail for an ideal size and will grow its
/// AppKit split view to satisfy it. Any content that reports an unsatisfiable
/// height — a greedy `.frame(maxHeight: .infinity)` with padding applied outside
/// it, or a `LazyVGrid(.adaptive)` proposed an unbounded width — therefore sizes
/// the *window's* split view rather than being clipped by it. Measured on macOS
/// 27, one such surface produced a split view 1069pt taller than the window and
/// positioned 508pt above it, which pushed the sidebar's top sections off-screen
/// where they could not be scrolled back to. The window, not the page, was broken.
///
/// A `ScrollView` reports no ideal height: it takes the height it is given. So
/// every centred Code page goes through here, the content is bounded to
/// `maxWidth` before it is padded, and overflow scrolls instead of growing the
/// window. Short content still reads as centred via `minHeight`, which is
/// satisfiable and therefore safe.
@available(macOS 26.0, *)
public struct JunoDetailPage<Content: View>: View {
    private let maxWidth: CGFloat
    private let content: Content

    public init(maxWidth: CGFloat = 720, @ViewBuilder content: () -> Content) {
        self.maxWidth = maxWidth
        self.content = content()
    }

    public var body: some View {
        // `Color.clear.overlay { … }`, and the choice is load-bearing.
        //
        // A detail column reports an ideal size upward, and `NavigationSplitView`
        // grows its AppKit split view to satisfy an ideal it cannot otherwise
        // meet — so a tall page does not get clipped by the window, it *resizes*
        // the window's split view. Measured on macOS 27: one such page produced a
        // split view 227pt taller than the window and 54pt above it, which put the
        // sidebar's top rows off-screen and pushed the composer below the bottom
        // edge.
        //
        // A `ScrollView` does not prevent that: it propagates its content's ideal
        // height as its own. Neither does `.frame(maxHeight: .infinity)` or
        // `.frame(idealHeight: 0)` — both were measured and neither clamped.
        // `Color.clear` has no intrinsic size and accepts whatever height it is
        // proposed, and an `.overlay` is sized *by its base* and never reports
        // back. So the page fills the column exactly and can never influence it.
        Color.clear
            .overlay {
                ScrollView {
                    content
                        .frame(maxWidth: maxWidth)
                        .padding(JunoSpace.region)
                        .frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
    }
}

// MARK: - Empty states

/// A screen with nothing in it yet.
///
/// Wraps `ContentUnavailableView` so every empty state in the app has the same
/// weight and the same vertical placement, rather than each page inventing its
/// own centred `VStack`.
@available(macOS 26.0, *)
public struct JunoEmptyState: View {
    private let title: String
    private let message: String?
    private let symbol: String
    private let actionLabel: String?
    private let perform: (() -> Void)?

    public init(
        title: String,
        message: String? = nil,
        symbol: String,
        actionLabel: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.symbol = symbol
        self.actionLabel = actionLabel
        self.perform = action
    }

    public var body: some View {
        VStack(spacing: JunoSpace.roomy) {
            Spacer()
            ZStack {
                Circle()
                    .fill(Color.junoRaised)
                    .frame(width: 72, height: 72)
                Image(systemName: symbol)
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(Color.secondary)
            }

            VStack(spacing: JunoSpace.snug) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.primary)

                if let message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 440)
                }
            }

            if let actionLabel, let perform {
                Button(actionLabel, action: perform)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .controlSize(.regular)
            }
            Spacer()
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
