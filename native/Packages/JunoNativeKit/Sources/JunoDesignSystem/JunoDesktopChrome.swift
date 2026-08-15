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
        background(Color.junoCanvas)
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
    func junoPanel(cornerRadius: CGFloat = JunoRadius.well) -> some View {
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
    /// `Color.junoForeground` rather than the hierarchical `.primary` for the
    /// same reason — the hierarchical level resolves against whatever style is
    /// current, including the emphasised one. It is also the warm ink the web
    /// draws this row in (`--foreground`); `Color.primary` is a pure neutral,
    /// and a column of pure-neutral labels on a warm sidebar is the single most
    /// visible way the app stops looking like Juno. Nested `.secondary` glyphs
    /// still work: they resolve as a quieter step off this colour.
    func junoSidebarRowInk() -> some View {
        junoInk()
    }

    /// A source-list row's mark, in the column's ink rather than the accent.
    ///
    /// This has to be stated on the glyph itself. A `Label` inside a `.sidebar`
    /// list resolves its icon slot against the *system accent*, and neither
    /// ``junoSidebarRowInk()`` on the row nor a `foregroundStyle` on the `Label`
    /// reaches it — which is how both navigation columns ended up drawing coral
    /// glyphs nobody had asked for. The web's rail is greyscale: the mark rests
    /// on `--sidebar-foreground` and lifts to `--foreground` with its label.
    func junoSidebarMarkInk(selected: Bool = false) -> some View {
        foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
    }

    /// The bottom of a source list, where a pinned footer meets the rows that
    /// scroll behind it.
    ///
    /// **What this replaced, and why it was wrong.** The footer used to paint
    /// `Color.junoSidebar` and a `Divider` behind itself, to stop the list
    /// drawing through it. That solved the overlap and broke something larger:
    /// the sidebar is a vibrant region, and an opaque fill laid over the bottom
    /// of it is a grey slab sitting on translucency — visible as a hard-edged
    /// bar under the last row, in a column that is otherwise sampling the
    /// desktop behind the window. The divider made the seam louder rather than
    /// hiding it. Rule 1 at the top of this file forbids exactly that, and the
    /// footer was the one place in the app breaking it.
    ///
    /// The platform's own answer is the scroll edge effect: rows approaching the
    /// bottom are progressively blurred and faded *into* the material instead of
    /// disappearing under a painted lid. The column stays translucent from top to
    /// bottom, and nothing draws over anything. `.soft` rather than `.hard`
    /// because a hard edge reintroduces the line this is removing.
    ///
    /// Pair it with `safeAreaBar(edge: .bottom)` — not `safeAreaInset` — on the
    /// list. The bar variant is what tells the system a pinned bar lives there,
    /// which is what the effect is measured against.
    @available(macOS 26.0, *)
    func junoSidebarScrollEdge() -> some View {
        scrollEdgeEffectStyle(.soft, for: .bottom)
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

    /// The floating-chrome treatment: glass in the floating radius, and
    /// *nothing else*.
    ///
    /// This deliberately draws no border, no shadow and no glow. Real glass
    /// carries its own edge — a light scatter at the rim that reads as
    /// thickness. Stroking a hairline over it flattens that back into a
    /// translucent rounded rectangle, and a painted drop shadow restates a
    /// separation the material already earns by refracting the content behind
    /// it. The call sites — both composers among them — quote this contract
    /// verbatim as the reason they add no decoration of their own, so the
    /// contract is load-bearing far beyond this one function.
    ///
    /// **An ornamented build of this modifier shipped briefly and was removed.**
    /// It stacked three decorations over the glass: a `Color.white.opacity(0.12)`
    /// strokeBorder (a white rim even in light mode), a black-30% radius-18
    /// shadow (four times the alpha and three times the blur of the one
    /// sanctioned elevation, ``SwiftUI/Color/junoCardShadow`` under
    /// `junoCard`), and a hand-rolled accent "focus glow". Each contradicted
    /// the contract above while the call sites were still citing it, and
    /// together they flattened every floating surface in the app back into the
    /// translucent box the contract exists to forbid. Focus was never this
    /// modifier's job either: a focused control inside the chrome gets the
    /// system focus ring, and the one sanctioned emphasis on the material is a
    /// full-alpha tint through ``junoGlass(in:tint:interactive:)`` — never a
    /// diluted stroke or a coloured shadow.
    func junoFloatingChrome(
        cornerRadius: CGFloat = JunoRadius.floating
    ) -> some View {
        junoGlass(
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
    }

    // **The `isFocused:` shim that used to sit here is gone, deliberately.** It
    // accepted and ignored the parameter so the composers left over from the
    // ornamented build kept compiling while they migrated; the migration is
    // finished — the Work home composer was the last caller — and a deprecated
    // overload with no callers is an attractive nuisance the deprecation
    // warning can no longer police, because nothing trips it. Anything reaching
    // for it again should read the contract above instead: focus is the system
    // focus ring on the control inside the chrome, never a treatment on the
    // material.
}

@available(macOS 26.0, *)
public extension View {

    /// Marks a glass element so the container can track it across a transition.
    ///
    /// **This used to force `.glassEffectTransition(.materialize)` and that was
    /// wrong for its main caller.** `matchedGeometry` — the system default this
    /// now leaves in place — is the one where the material *stretches* between
    /// an element's old and new positions, which is precisely the effect a
    /// segmented control's knob exists to produce. `.materialize` explicitly
    /// opts out of geometry matching and fades the material in and out instead,
    /// so the helper was cancelling the behaviour every one of its call sites
    /// wanted, under a name that gave no hint it was doing so.
    ///
    /// The distinction is about distance, not taste: `matchedGeometry` is for
    /// elements *within* the container's `spacing`, `materialize` for elements
    /// farther apart than that. Use ``junoGlassMaterialize(_:in:)`` for the
    /// second case. Both are inert at rest — they only take effect during a
    /// view-hierarchy transition.
    func junoGlassID(_ id: some Hashable & Sendable, in namespace: Namespace.ID) -> some View {
        glassEffectID(id, in: namespace)
    }

    /// The same, for glass elements far enough apart that stretching the
    /// material between them would read as a smear rather than as one surface
    /// moving. Fades the content and animates the material in and out.
    func junoGlassMaterialize(
        _ id: some Hashable & Sendable,
        in namespace: Namespace.ID
    ) -> some View {
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

    /// The metric every toolbar action in the product uses.
    ///
    /// **Apply this to the `Button` inside each `ToolbarItem`, not to the
    /// `.toolbar` modifier.** That is counter-intuitive and was got wrong once
    /// already: `.controlSize` and `.imageScale` normally flow down the
    /// environment, so putting them on the view that carries `.toolbar {…}`
    /// looks like it should size the whole bar. It does nothing at all. Toolbar
    /// item content is hosted by `NSToolbar`, in a view hierarchy that is a
    /// sibling of the content view rather than a descendant, so the content
    /// view's environment never reaches it. The change built, ran, and produced
    /// a pixel-identical toolbar.
    ///
    /// **Why the default was wrong.** A bare `Button { Label(…) }` in a toolbar
    /// inherits `.regular`, which on this OS draws roughly a 22pt glass capsule
    /// around a 13pt glyph. That is smaller than the standard macOS toolbar
    /// button, and Liquid Glass makes it read smaller still: the material is
    /// mostly transparent, so a small capsule has very little of its own
    /// presence and the glyph is doing all the work of being a target. Measured
    /// against `mac-work.png` in `docs/native/design/rework/`, the compose and
    /// overflow actions came out at about 22pt in a window 1512pt wide.
    ///
    /// `.large` is the platform's own next rung — about 32pt — not a
    /// hand-picked number. That distinction matters more than usual here: a
    /// literal `.frame(width:height:)` on a glass button overrides the shape the
    /// material is lensing through, so the capsule stops matching its own
    /// highlight and the press flex deforms. The size has to come from the
    /// control metric, never from a frame.
    ///
    /// Pointer targets have no 44pt rule the way touch does, but the AppKit apps
    /// this sits beside — Mail, Notes, Xcode — all land near 30pt, and matching
    /// them is most of what makes a Mac toolbar feel native.
    func junoToolbarMetrics() -> some View {
        controlSize(.large)
            .imageScale(.large)
            .fontWeight(.medium)
    }

    /// The one primary action on a surface.
    ///
    /// Prefer the cross-platform ``SwiftUI/View/junoProminentAction()`` in new
    /// code — it is the same treatment with a pre-26 fallback, so a shared view
    /// can use it. This stays because macOS-only chrome reads better without the
    /// availability branch.
    func junoProminentGlassButton() -> some View {
        buttonStyle(.glassProminent).tint(Color.junoAccent)
    }

    /// A circular accent-tinted glass action — the composer's send/stop/voice
    /// button, and anything else that is the single obvious next step.
    ///
    /// The tint appears and disappears rather than the shape changing when the
    /// action is unavailable, so the control keeps its position and the pointer
    /// does not have to re-find it between states. Pair it with
    /// ``Color/junoOnAccent`` for the glyph, never a literal white: the accent is
    /// an account setting and white fails contrast on two of the five palettes.
    ///
    /// **The inactive state is untinted, not a faded accent.** It used to be
    /// `Color.junoAccent.opacity(0.32)`, and a diluted tint is the one thing
    /// `Glass.tint(_:)` must never be given: it honours the alpha, so the tint
    /// stops establishing a predictable luminance under the glyph and the
    /// glyph's contrast becomes a function of whatever is behind the window.
    /// Passing `nil` gives plain `.regular` glass — which is the honest reading
    /// of the state anyway, since an unavailable action is not the primary
    /// action. The active value went to full strength from 0.95 for the same
    /// reason. Note this is one expression rather than an `if`, so the control
    /// keeps a single view identity and the change animates.
    func accentGlassAction(active: Bool) -> some View {
        buttonStyle(.junoPress)
            .junoGlass(
                in: Circle(),
                tint: active ? Color.junoAccent : nil,
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
    private let junoIcon: JunoIcon?
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
        self.junoIcon = nil
        self.actionLabel = actionLabel
        self.perform = action
    }

    /// The same state, drawn with one of the website's own marks.
    ///
    /// Use this wherever the thing that is missing has a glyph on the web — a
    /// project, a pull request, a connection — so the empty state names it the
    /// way every other surface does.
    public init(
        title: String,
        message: String? = nil,
        icon: JunoIcon,
        actionLabel: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.symbol = ""
        self.junoIcon = icon
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
                if let junoIcon {
                    JunoIconView(junoIcon, size: 28)
                        .foregroundStyle(Color.junoMutedForeground)
                } else {
                    Image(systemName: symbol)
                        // Not scaled with Dynamic Type: this glyph is centred in
                        // a fixed 72pt plate, so growing it at AX5 would push it
                        // outside the circle. The empty state's *text* below
                        // scales, which is where the reading is.
                        .font(.system(size: 30, weight: .regular))
                        .foregroundStyle(Color.junoMutedForeground)
                }
            }

            VStack(spacing: JunoSpace.snug) {
                Text(title)
                    .junoEmptyTitle()
                    .junoInk()

                if let message {
                    Text(message)
                        .font(.callout)
                        .junoSecondaryInk()
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 440)
                }
            }

            if let actionLabel, let perform {
                Button(actionLabel, action: perform)
                    .junoProminentAction()
                    .controlSize(.regular)
            }
            Spacer()
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
