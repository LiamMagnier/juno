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
// Two faces, deliberately: SF Pro for everything, and `JunoSerif` (Newsreader)
// reserved for the editorial moments the web sets in a serif — the greeting, a
// deep dive's pull quote. Nothing else. The web's own display face is not
// bundled and must not be: a native app that ships a webfont for its chrome
// stops looking like a Mac app and starts looking like a website in a window.

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
