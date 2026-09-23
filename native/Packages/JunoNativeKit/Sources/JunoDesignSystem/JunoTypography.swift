import SwiftUI

// The type scale. **This file is the scale** — there is no second one.
//
// It used to be a decoy. Four modifiers lived here (`junoScreenTitle`,
// `junoSectionHeader`, `junoRowTitle`, `junoMetadata`) and three of them had
// zero call sites tree-wide, while the scale the product actually draws with
// sat unannounced at the bottom of `JunoSurfaces.swift` (`junoCaption` 312
// uses, `junoRowLabel` 88, `junoBody` 21, `junoMono` 16) with the monospaced
// pair off in `JunoStatus.swift` (`junoCodeSmall` 78, `junoCode` 31). A new
// author opening the file named "Typography" therefore picked the dead half —
// which is exactly how a type scale grows a second, unreviewed set of sizes.
//
// The live modifiers moved here unchanged in behaviour. `JunoSurfaces.swift`
// keeps the surfaces, `JunoStatus.swift` keeps the status colours, and neither
// carries type any more.
//
// Two faces, deliberately: SF Pro for everything (standing in for the web's
// Inter, as SF Mono stands in for JetBrains Mono), and `JunoSerif` (Newsreader)
// for the greeting and the wordmark. Nothing else — the web keeps its serif to
// exactly those two human moments, and a native app that sets its chrome in a
// webfont stops looking like a Mac app and starts looking like a website in a
// window.
//
// The file has two halves. `JunoType`, at the top, is the redesign's ladder:
// the web's `fontSize` rungs from `tailwind.config.ts`, projected into
// `JunoGeneratedType`, each carrying its size, weight, tracking and line
// height together. The text-style modifiers below it (`junoBody()`,
// `junoCaption()`, …) are the scale the app shipped with; they keep their
// rendering until each surface moves onto the ladder.

// MARK: - The ladder

/// One rung of Juno's type ladder: a size, a weight, tracking and a line
/// height that travel together, so a rung cannot be half-applied.
///
/// The values are the web's (`tailwind.config.ts` → `fontSize`, projected into
/// ``JunoGeneratedType``), with the web's pixels as points: the redesign sets
/// *content* at the web's sizes — prose, the bubble and the composer at 15 —
/// and lets *chrome* use the Mac's own 13pt metrics, which is the web's `ui`
/// rung anyway (§0.6). `JunoTypeLadderTests` pins every rung to the generated
/// value and to the number, so a web retune reaches the Mac and a Swift-side
/// literal cannot creep back in.
///
/// Apply a rung with ``SwiftUI/View/junoType(_:)``. Where only a `Font` can go
/// — `Text` concatenation, an `AttributedString` run — use ``font(scale:)``,
/// which carries size and weight but not tracking or line height.
///
/// **Scaling.** Every rung scales twice. On the phone it follows Dynamic Type,
/// relative to ``textStyle``. On both platforms it is multiplied by
/// ``SwiftUI/EnvironmentValues/junoTextScale`` — the reader's text-size setting
/// — because the Mac has no system Dynamic Type: a text-style font resolves to
/// the same size at every `dynamicTypeSize` there, so an app setting is the
/// only way a Mac reader can make Juno's text larger.
///
/// **No uppercase and nothing above semibold** — the ladder has neither, and a
/// call site that adds them is the drift this type exists to stop.
public struct JunoType: Equatable, Sendable {
    /// The family a rung is set in.
    public enum Face: Equatable, Sendable {
        /// SF Pro, standing in for the web's Inter.
        case sans
        /// SF Mono, standing in for JetBrains Mono.
        case mono
        /// Newsreader, with New York as the fallback. The greeting and the
        /// wordmark only.
        case serif
    }

    /// The size in points at the default text size.
    public let size: CGFloat
    public let weight: Font.Weight
    /// Letter spacing in em, as the web writes it; multiplied by the rendered
    /// size for points.
    public let tracking: CGFloat
    /// Line height as a multiple of the size — CSS's unitless `line-height`,
    /// which is also what `.lineHeight(.multiple(factor:))` means (measured:
    /// four lines of 20pt at factor 2 are 160pt tall).
    public let lineHeight: CGFloat
    public let face: Face
    public let isItalic: Bool
    /// The Dynamic Type style this rung grows with on the phone. Chosen for the
    /// rung's role, not for a matching default size.
    public let textStyle: Font.TextStyle

    public init(
        size: CGFloat,
        weight: Font.Weight = .regular,
        tracking: CGFloat = 0,
        lineHeight: CGFloat,
        face: Face = .sans,
        isItalic: Bool = false,
        textStyle: Font.TextStyle
    ) {
        self.size = size
        self.weight = weight
        self.tracking = tracking
        self.lineHeight = lineHeight
        self.face = face
        self.isItalic = isItalic
        self.textStyle = textStyle
    }

    /// A rung from its generated projection.
    init(
        _ rung: JunoGeneratedTypeRung,
        size: CGFloat? = nil,
        weight: Font.Weight? = nil,
        face: Face = .sans,
        isItalic: Bool = false,
        textStyle: Font.TextStyle
    ) {
        self.init(
            size: size ?? rung.minSize,
            weight: weight ?? Self.weight(css: rung.weight),
            tracking: rung.tracking,
            lineHeight: rung.lineHeight,
            face: face,
            isItalic: isItalic,
            textStyle: textStyle
        )
    }

    // MARK: Rungs

    /// The greeting: Newsreader Regular, −0.02em, ×1.08, at `size`.
    ///
    /// Fluid from 32 to 48 on the web by column width; pass
    /// ``displaySize(forColumnWidth:)`` for the same size at the same column.
    /// **Weight 400**, although the web's `text-display` rung says 500: the
    /// only place the web sets a greeting, `EmptyGreeting`, overrides it with
    /// `font-normal`, and the greeting is the only thing this rung is for.
    public static func display(size: CGFloat) -> JunoType {
        JunoType(
            JunoGeneratedType.display,
            size: size,
            weight: .regular,
            face: .serif,
            textStyle: .largeTitle
        )
    }

    /// The greeting's first name: the italic of ``display(size:)``.
    ///
    /// Set in **Newsreader 24pt Medium Italic**, the only italic the apps
    /// bundle. The web sets the name in Newsreader's *regular* italic, so this
    /// is a half-weight heavier than the web; bundling `Newsreader24pt-Italic`
    /// would match it exactly and needs no code change here beyond the face.
    public static func displayItalic(size: CGFloat) -> JunoType {
        JunoType(
            JunoGeneratedType.display,
            size: size,
            weight: .medium,
            face: .serif,
            isItalic: true,
            textStyle: .largeTitle
        )
    }

    /// The web's fluid `display` size for a content column of `width` points:
    /// 32 at a 640pt column, 48 at 1024, linear between, clamped outside.
    public static func displaySize(forColumnWidth width: CGFloat) -> CGFloat {
        fluidSize(JunoGeneratedType.display, width: width)
    }

    /// A page's `<h1>`: SF 26 semibold, −0.02em, ×1.15. Page headers, Upgrade,
    /// onboarding, "You're incognito". Mark the text `.isHeader`.
    public static let pageTitle = JunoType(JunoGeneratedType.pageTitle, textStyle: .title)

    /// ``pageTitle`` at the web's fluid size for a content column of `width`
    /// points: 26 at 640, 32 at 1024.
    public static func pageTitle(columnWidth width: CGFloat) -> JunoType {
        JunoType(
            JunoGeneratedType.pageTitle,
            size: fluidSize(JunoGeneratedType.pageTitle, width: width),
            textStyle: .title
        )
    }

    /// SF 22 semibold, −0.012em, ×1.25. Sheet heroes.
    public static let title = JunoType(JunoGeneratedType.title, textStyle: .title2)
    /// SF 18 semibold, −0.006em, ×1.3. Sheet titles, card titles.
    public static let heading = JunoType(JunoGeneratedType.heading, textStyle: .title3)
    /// SF 17, ×1.6. Ledes, the search field, empty-state titles.
    public static let bodyLarge = JunoType(JunoGeneratedType.bodyLg, textStyle: .body)
    /// SF 15, ×1.6. The bubble, the composer field, anything read in flow.
    public static let body = JunoType(JunoGeneratedType.body, textStyle: .body)
    /// ``body`` at the assistant's reading leading, ×1.65 — the web's
    /// `.prose-juno`, which states `line-height: 1.65` itself (in `globals.css`,
    /// not on the Tailwind ladder, so it is pinned by test rather than
    /// generated).
    public static let prose = JunoType(
        size: JunoGeneratedType.body.minSize,
        weight: weight(css: JunoGeneratedType.body.weight),
        tracking: JunoGeneratedType.body.tracking,
        lineHeight: proseLineHeight,
        textStyle: .body
    )
    /// SF 13, ×1.5 — the Mac's own `.body` size. Controls, rows, chips, menus.
    public static let ui = JunoType(JunoGeneratedType.ui, textStyle: .callout)
    /// SF 12 medium, +0.01em, ×1.4. Metadata, pills.
    public static let label = JunoType(JunoGeneratedType.label, textStyle: .footnote)
    /// SF 11, +0.02em, ×1.45. Footnotes, section captions in panels.
    public static let caption = JunoType(JunoGeneratedType.caption, textStyle: .caption)
    /// SF Mono 10.5, +0.02em, ×1.45. Keycaps, machine metadata — the web pairs
    /// `text-micro` with `font-mono` everywhere it is used.
    public static let micro = JunoType(JunoGeneratedType.micro, face: .mono, textStyle: .caption2)
    /// SF Mono 13 on a 20pt line: code.
    public static let mono = JunoType(
        size: 13, lineHeight: 20.0 / 13.0, face: .mono, textStyle: .callout
    )
    /// SF Mono 12, ×1.5: ids, counts, costs.
    public static let monoSmall = JunoType(
        size: 12, lineHeight: 1.5, face: .mono, textStyle: .footnote
    )

    /// `.prose-juno`'s `line-height`.
    static let proseLineHeight: CGFloat = 1.65

    // MARK: Variants

    /// This rung at another weight. Semibold is the ceiling.
    public func weight(_ weight: Font.Weight) -> JunoType {
        JunoType(
            size: size, weight: weight, tracking: tracking, lineHeight: lineHeight,
            face: face, isItalic: isItalic, textStyle: textStyle
        )
    }

    /// This rung in italic.
    public func italic(_ isItalic: Bool = true) -> JunoType {
        JunoType(
            size: size, weight: weight, tracking: tracking, lineHeight: lineHeight,
            face: face, isItalic: isItalic, textStyle: textStyle
        )
    }

    // MARK: Resolving

    /// The rung as a `Font`, at `scale` × its size (pass the environment's
    /// ``SwiftUI/EnvironmentValues/junoTextScale``).
    ///
    /// For the places a view modifier cannot go. It carries size, weight,
    /// face and italic, but not tracking or line height; prefer
    /// ``SwiftUI/View/junoType(_:)`` wherever a view is available.
    public func font(scale: CGFloat = 1) -> Font {
        let points = size * scale
        switch face {
        case .serif:
            return JunoSerif.displayFont(
                size: points, relativeTo: textStyle, weight: weight, italic: isItalic
            )
        case .sans, .mono:
            let font = JunoType.systemFont(
                size: points,
                relativeTo: textStyle,
                weight: weight,
                design: face == .mono ? .monospaced : .default
            )
            return isItalic ? font.italic() : font
        }
    }

    /// Tracking in points at a rendered size.
    public func trackingPoints(atSize renderedSize: CGFloat) -> CGFloat {
        tracking * renderedSize
    }

    /// The system face at `size` points that still follows Dynamic Type on the
    /// phone, relative to `textStyle`.
    ///
    /// `Font.system(size:weight:design:)` is frozen — it has no `relativeTo:`
    /// — so on iOS the rung is the text style's font scaled by `size ÷` that
    /// style's default size: exactly `size` at the default setting, and growing
    /// at the style's rate from there. The Mac has no Dynamic Type (a text-style
    /// font resolves to the same size at every `dynamicTypeSize`), so there the
    /// exact size is the whole answer and ``SwiftUI/EnvironmentValues/junoTextScale``
    /// does the scaling.
    static func systemFont(
        size: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        weight: Font.Weight,
        design: Font.Design
    ) -> Font {
        #if os(macOS)
        return .system(size: size, weight: weight, design: design)
        #else
        return Font.system(textStyle, design: design, weight: weight)
            .scaled(by: size / defaultPointSize(textStyle))
        #endif
    }

    /// A text style's size at the default Dynamic Type setting (`.large`) on
    /// the phone — Apple's published table, which ``systemFont(size:relativeTo:weight:design:)``
    /// divides by to land on an exact point size.
    static func defaultPointSize(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline: 17
        case .subheadline: 15
        case .body: 17
        case .callout: 16
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
    }

    /// `clamp(min, intercept + slope × width, max)`.
    static func fluidSize(_ rung: JunoGeneratedTypeRung, width: CGFloat) -> CGFloat {
        min(max(rung.fluidIntercept + rung.fluidSlope * width, rung.minSize), rung.maxSize)
    }

    /// CSS numeric weight to SwiftUI. The ladder only uses 400–600; nil is
    /// the CSS default, 400.
    static func weight(css: Int?) -> Font.Weight {
        switch css {
        case .some(500): .medium
        case .some(600): .semibold
        case .some(700...): .bold
        default: .regular
        }
    }
}

public extension EnvironmentValues {
    /// The reader's text size, as a factor on every ``JunoType`` rung: 1 is
    /// the web's sizes.
    ///
    /// One factor for the whole ladder rather than a size per rung, so text
    /// grows as a system and the hierarchy holds. Set it once, at the scene
    /// root, from the text-size setting; the Mac has no system Dynamic Type, so
    /// this is the only thing that can make Juno's text larger there. On the
    /// phone it multiplies Dynamic Type rather than replacing it.
    @Entry var junoTextScale: CGFloat = 1
}

public extension View {
    /// Sets text in one rung of the ladder: font, tracking and line height
    /// together, scaled by the reader's text size.
    func junoType(_ type: JunoType) -> some View {
        modifier(JunoTypeModifier(type: type))
    }

    /// The greeting, in Newsreader at `size` (32–48; see
    /// ``JunoType/displaySize(forColumnWidth:)``). Mark it `.isHeader`.
    func junoDisplay(_ size: CGFloat) -> some View {
        junoType(.display(size: size))
    }

    /// The greeting's italic, for a view that is wholly the name. Inside the
    /// greeting's own `Text`, style the name run with
    /// `JunoType.displayItalic(size:).font(scale:)`.
    func junoDisplayItalic(_ size: CGFloat) -> some View {
        junoType(.displayItalic(size: size))
    }

    /// A page's title: ``JunoType/pageTitle``, fluid when given the column
    /// width. Mark it `.isHeader`.
    func junoPageTitle(columnWidth: CGFloat? = nil) -> some View {
        junoType(columnWidth.map { JunoType.pageTitle(columnWidth: $0) } ?? .pageTitle)
    }

    /// ``JunoType/heading``: sheet and card titles.
    func junoHeading() -> some View { junoType(.heading) }

    /// ``JunoType/bodyLarge``: ledes, the search field, empty-state titles.
    func junoBodyLarge() -> some View { junoType(.bodyLarge) }

    /// ``JunoType/ui``: controls, rows, chips, menus.
    func junoUI() -> some View { junoType(.ui) }

    /// ``JunoType/label``: metadata, pills.
    func junoLabel() -> some View { junoType(.label) }

    /// ``JunoType/micro``: keycaps, machine metadata.
    func junoMicro() -> some View { junoType(.micro) }

    // `title`, `body`, `caption` and `mono` have no shorthand on purpose:
    // `junoTitle()`, `junoBody()`, `junoCaption()` and `junoMono()` already
    // exist below as the shipped text-style rungs, with several hundred call
    // sites between them and different sizes from the ladder's. Reach those
    // rungs through `junoType(.title)` and friends.
}

private struct JunoTypeModifier: ViewModifier {
    let type: JunoType
    @Environment(\.junoTextScale) private var textScale
    /// The rung's size after Dynamic Type, so tracking is computed from what
    /// is actually rendered. Always the base size on the Mac.
    @ScaledMetric private var dynamicSize: CGFloat

    init(type: JunoType) {
        self.type = type
        _dynamicSize = ScaledMetric(wrappedValue: type.size, relativeTo: type.textStyle)
    }

    func body(content: Content) -> some View {
        content
            .font(type.font(scale: textScale))
            .tracking(type.trackingPoints(atSize: dynamicSize * textScale))
            .lineHeight(.multiple(factor: type.lineHeight))
    }
}

// MARK: - Dynamic Type for a fixed point size

public extension View {
    /// The system face at an exact point size that still moves with Dynamic Type.
    ///
    /// **Why this exists.** `Font.system(size:weight:design:)` is frozen: it has
    /// no `relativeTo:` overload, so every one of the 96 `.font(.system(size:))`
    /// sites inside this package was pinned in place at every accessibility
    /// size. The dense surfaces are the worst of it — a gutter number at 11pt
    /// and a legacy badge at 8.5pt stay 11pt and 8.5pt at AX5, which is the
    /// native equivalent of the fixed-`px` bug the web just fixed for WCAG
    /// 1.4.4.
    ///
    /// `@ScaledMetric(relativeTo:)` is the only mechanism that scales an
    /// arbitrary point size, and it has to live on a `DynamicProperty`, which is
    /// why this is a modifier and not a `Font` factory. Pick `textStyle` for the
    /// *role* the text plays, not for a matching default size: the property
    /// scales by the ratio between that style's current and default size, so the
    /// number you pass is exactly what renders at the default Dynamic Type
    /// setting on both platforms.
    ///
    /// Prefer a named rung below (``junoBody()``, ``junoCaption()``,
    /// ``junoCode()``…) whenever one fits. Reach for this only where a specific
    /// size is genuinely load-bearing — a code gutter that has to align, a badge
    /// that has to fit inside a mark.
    func junoFont(
        size: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        weight: Font.Weight = .regular,
        design: Font.Design = .default
    ) -> some View {
        modifier(
            JunoScaledFont(size: size, textStyle: textStyle, weight: weight, design: design)
        )
    }
}

private struct JunoScaledFont: ViewModifier {
    @ScaledMetric private var scaled: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design

    init(size: CGFloat, textStyle: Font.TextStyle, weight: Font.Weight, design: Font.Design) {
        _scaled = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: scaled, weight: weight, design: design))
    }
}

// MARK: - The scale

/// Hierarchy is carried by weight and colour more than by size, so a window full
/// of text stays calm. Every rung is a system text style, so Dynamic Type moves
/// all of them without a single fixed number.
public extension View {
    /// A screen's primary title — the largest type in the product.
    func junoScreenTitle() -> some View {
        font(.system(.largeTitle, design: .default, weight: .bold))
    }

    /// An empty state's headline.
    func junoEmptyTitle() -> some View {
        font(.system(.title3, design: .default, weight: .semibold))
    }

    /// A window or conversation title in the toolbar.
    func junoTitle() -> some View {
        font(.system(.headline, design: .default, weight: .semibold))
    }

    /// Message body — the most-read text in the product.
    func junoBody() -> some View {
        font(.system(.body))
            .lineSpacing(3)
    }

    /// A navigation or list row label.
    func junoRowLabel() -> some View {
        font(.system(.callout, design: .default, weight: .regular))
    }

    /// A sidebar or grouped-section header: quiet, small, secondary.
    ///
    /// `textCase(nil)` because the platform upper-cases a `Section` header on
    /// macOS and the web's rail does not.
    func junoSidebarSection() -> some View {
        font(.system(.caption, design: .default, weight: .semibold))
            .junoSecondaryInk()
            .textCase(nil)
    }

    /// Timestamps, counts, provenance.
    func junoCaption() -> some View {
        font(.system(.caption))
            .junoSecondaryInk()
    }

    /// Terminal, diff and code content read at body weight.
    func junoMono() -> some View {
        font(.system(.callout, design: .monospaced))
    }

    /// Monospaced content read deliberately: diffs, paths, commit subjects.
    func junoCode() -> some View {
        font(.system(.footnote, design: .monospaced))
    }

    /// Monospaced content that is scanned: terminal output, gutters, hashes.
    func junoCodeSmall() -> some View {
        font(.system(.caption, design: .monospaced))
    }
}

/// The same rungs as `Font` values, for the places a `View` modifier cannot go.
///
/// `Text + Text` concatenation is the one that matters: the operands must both
/// be `Text`, so `.font(_:)` is the only styling that may be applied to them and
/// a `View` modifier such as ``SwiftUI/View/junoBody()`` breaks the expression.
/// Concatenation is how a run of prose keeps one sentence with two inks on a
/// single line-breaking pass, which is worth keeping.
///
/// These are text styles rather than point sizes precisely *because* they cannot
/// go through ``SwiftUI/View/junoFont(size:relativeTo:weight:design:)`` —
/// `@ScaledMetric` needs a view to live in, so a fixed-size `Font` value would
/// be the one thing in the scale that Dynamic Type could not move.
public extension Font {
    /// Message body — the most-read text in the product.
    static let junoBody = Font.system(.body)
    /// A navigation or list row label.
    static let junoRowLabel = Font.system(.callout)
    /// Timestamps, counts, provenance.
    static let junoCaption = Font.system(.caption)
    /// Monospaced content read deliberately.
    static let junoCode = Font.system(.footnote, design: .monospaced)
    /// Monospaced content that is scanned.
    static let junoCodeSmall = Font.system(.caption, design: .monospaced)
}

// MARK: - Ink

/// The text ramp, as three modifiers.
///
/// **Why these exist.** `Color.junoForeground` — the native counterpart of the
/// web's `--foreground` — had two call sites tree-wide, against 375
/// `.foregroundStyle(.secondary)` and 129 `Color.primary`, 34 of the latter
/// inside this package. The platform's label colours are pure neutrals; laid on
/// a canvas whose whole identity is that red is the highest channel, a long run
/// of them is what makes the app read as a generic SwiftUI shell rather than as
/// Juno. Naming the ramp as three one-line modifiers makes the migration
/// mechanical: `.foregroundStyle(.secondary)` → `.junoSecondaryInk()`,
/// `.foregroundStyle(Color.primary)` → `.junoInk()`.
///
/// Use the *system* styles only where the system owns the surface — inside a
/// `Menu`, a toolbar, an alert — where the platform's own vibrancy is doing
/// work these absolute colours cannot.
public extension View {
    /// Primary ink: titles, message bodies, anything read at length.
    ///
    /// Measures 15.5:1 on the canvas in both appearances.
    func junoInk() -> some View {
        foregroundStyle(Color.junoForeground)
    }

    /// Secondary ink: labels, captions, metadata, provenance.
    ///
    /// Measures 5.2:1 light and 7.2:1 dark on the canvas — it clears WCAG AA for
    /// body text with no margin to spare, which is the reason for the next
    /// modifier's warning.
    func junoSecondaryInk() -> some View {
        foregroundStyle(Color.junoMutedForeground)
    }

    /// The quietest ink Juno draws. **There is no rung below it.**
    ///
    /// This is deliberately the same colour as ``junoSecondaryInk()`` rather
    /// than a third, fainter step, and the alias is the point. `.tertiary`
    /// measures 1.89:1 on the per-message meta line and 1.93:1 on the safety
    /// disclaimer in light appearance (2.24 / 2.27 dark) — illegible, not merely
    /// quiet, and the disclaimer compounded it by being
    /// `.accessibilityHidden(true)` as well, leaving a low-vision reader with
    /// neither contrast nor a VoiceOver path to the text.
    ///
    /// Anything genuinely tertiary should get *less weight or less size*, or
    /// stop being drawn. It must not get less contrast. Never use
    /// `.foregroundStyle(.tertiary)` or `.quaternary` on text.
    func junoMetaInk() -> some View {
        foregroundStyle(Color.junoMutedForeground)
    }
}

// MARK: - Superseded

public extension View {
    @available(*, deprecated, renamed: "junoSidebarSection()",
               message: "One scale: junoSidebarSection is the live section header.")
    func junoSectionHeader() -> some View {
        junoSidebarSection()
    }

    @available(*, deprecated, renamed: "junoRowLabel()",
               message: "One scale: junoRowLabel is the live row rung (88 call sites).")
    func junoRowTitle() -> some View {
        junoRowLabel()
    }

    @available(*, deprecated, renamed: "junoCaption()",
               message: "One scale: junoCaption is the live metadata rung (312 call sites).")
    func junoMetadata() -> some View {
        junoCaption()
    }
}
