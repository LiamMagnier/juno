import SwiftUI

/// Status and developer-surface tokens.
///
/// These live in the shared design system rather than in Juno Code because the
/// two products show the same states. A failed tool call in Code and a failed
/// send in Chat are the same red; a code block in a Chat transcript and a
/// terminal pane in Code sit on the same well. Keeping them here is what stops
/// the two halves of the app drifting into two palettes.
///
/// The status hues are chosen for contrast against `junoCanvasWarm` and
/// `junoRaised` in both appearances, not for saturation: dark mode lifts
/// lightness rather than pushing chroma, so coloured text stays legible without
/// glowing.
public extension JunoColorToken {
    // Success — a passing test, an approved request, a succeeded tool.
    static let successLight = JunoColorToken(unchecked: 0.106, 0.478, 0.243)
    static let successDark = JunoColorToken(unchecked: 0.376, 0.796, 0.518)

    // Danger — a failure, a denial, stderr.
    static let dangerLight = JunoColorToken(unchecked: 0.729, 0.145, 0.145)
    static let dangerDark = JunoColorToken(unchecked: 0.961, 0.443, 0.420)

    // Caution — awaiting approval, a recoverable error.
    //
    // Darkened from `40 91% 33.5%` to `40 91% 31.5%`. The old value measured
    // 4.11:1 against `canvasLight` — below the 4.5:1 that "Awaiting approval"
    // needs as *text*, which is how this ramp is actually drawn. The file's own
    // doc comment above claims these are chosen for contrast against the warm
    // canvas; it was true of success and danger and had never been checked for
    // this one. Hue and saturation are untouched, exactly as in the accent pass,
    // so the amber character is unchanged and only the value moved. Now 4.54:1,
    // asserted in `JunoInkContrastTests`.
    static let cautionLight = JunoColorToken(unchecked: 0.6009, 0.4103, 0.0291)
    static let cautionDark = JunoColorToken(unchecked: 0.957, 0.741, 0.337)

    // Diff row fills. Deliberately low-chroma: the whole row is tinted, so the
    // fill has to sit *under* monospaced text without fighting it.
    static let diffAddedLight = JunoColorToken(unchecked: 0.878, 0.953, 0.890)
    static let diffAddedDark = JunoColorToken(unchecked: 0.098, 0.204, 0.129)
    static let diffRemovedLight = JunoColorToken(unchecked: 0.988, 0.898, 0.898)
    static let diffRemovedDark = JunoColorToken(unchecked: 0.243, 0.110, 0.110)
}

public extension Color {
    /// A passing, approved or succeeded state.
    static let junoSuccess = Color.junoAdaptive(light: .successLight, dark: .successDark)
    /// A failing, denied or errored state.
    static let junoDanger = Color.junoAdaptive(light: .dangerLight, dark: .dangerDark)
    /// A waiting or recoverable state.
    static let junoCaution = Color.junoAdaptive(light: .cautionLight, dark: .cautionDark)

    /// The fill behind an added diff line.
    static let junoDiffAdded = Color.junoAdaptive(light: .diffAddedLight, dark: .diffAddedDark)
    /// The fill behind a removed diff line.
    static let junoDiffRemoved = Color.junoAdaptive(light: .diffRemovedLight, dark: .diffRemovedDark)
}

// The monospaced pair — `junoCode` and `junoCodeSmall`, plus their `Font`
// equivalents — used to live here, which put two rungs of the type scale in the
// file named "Status". They now sit with the rest of the scale in
// `JunoTypography.swift`, unchanged in value. Nothing about a diff's colour
// needed to know what size its text was.
