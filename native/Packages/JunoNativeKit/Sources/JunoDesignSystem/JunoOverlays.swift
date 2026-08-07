import SwiftUI

// The overlay contract.
//
// **Read this before adding a modifier to any presentation.** The audit that
// produced this file counted ~258 presentations against 0 `.presentationBackground`,
// 0 `.presentationCornerRadius` and 12 `.presentationDetents`, and read those
// zeroes as a gap. They are not a gap. They are very nearly the correct state,
// and the contract below is mostly a list of things not to do.
//
// The web's overlay contract exists because CSS gives you nothing: the browser
// draws no platter, so every surface has to be authored. SwiftUI on the OS 26
// SDKs is the opposite. The system authors the platter, its Liquid Glass
// material, its corner radius, its shadow, its scroll-edge treatment, its
// Reduce Transparency and Increase Contrast substitutions, and its enter/exit
// motion. Porting the CSS contract here would *remove* the glass the app
// already gets for free and hard-code radii the system varies per device and
// per detent.
//
// WHAT THE SYSTEM ALREADY DRAWS, AND WHICH THIS FILE THEREFORE DOES NOT TOUCH:
//
//   Menu (111)              system glass, both platforms. Not stylable.
//   .contextMenu (25)       same.
//   .alert (45)             system-drawn; SwiftUI alerts accept no background.
//   .confirmationDialog (29) iOS action sheet / macOS system sheet.
//   .popover (11)           glass by default — a background *removes* it.
//   .inspector (5)          macOS system chrome.
//
// That is ~226 of the 258, and the right change to all of them is none. The
// remaining 32 are sheets, and even there most of the work is deletion.
//
// FORBIDDEN EVERYWHERE, on any presentation:
//   · `.presentationBackground` — replaces the glass platter with a flat fill.
//     (The single legitimate use is `.clear` for a deliberately hand-drawn
//     floating panel. Juno has no such case.)
//   · `.presentationCornerRadius` — on iOS 26+ a sheet's radius is concentric
//     with the physical display corner and changes with the detent. Any fixed
//     value breaks that nesting on some device; on macOS the system owns it
//     outright.
//   · a custom shadow on a presentation.
//   · a hand-rolled material or blur standing in for glass.
//   · `.presentationDetents` / `.presentationDragIndicator` in macOS code —
//     both are declared there and both are no-ops.
//   · any `.glassEffect` inside a sheet, toolbar, tab bar, sidebar or
//     navigation bar. Glass cannot sample glass: the inner surface has nothing
//     meaningful to refract, so *both* surfaces flatten to a translucent wash.
//     The outer glass is invisible in source, which is how this rule gets
//     broken.

// MARK: - Sheets

/// How a macOS sheet asks to be sized.
///
/// The macOS-native counterpart of an "overlay contract" is `presentationSizing`,
/// not a background — it is the modifier this design system was actually missing
/// on the desktop. It is available on every Juno target (macOS 15 / iOS 18) and
/// is a no-op below that, which is what the availability branch below handles.
public enum JunoSheetSizing: Sendable {
    /// A short form: a rename, a single-field editor, a confirmation with input.
    case form
    /// A page of content: settings, a task editor, anything with sections.
    case page
    /// Exactly as large as its content, and no larger.
    case fitted
}

public extension View {
    /// The root of a **reading or form** sheet's content, on either platform.
    ///
    /// Supplies precisely what the system does not: the warm ground under the
    /// content, and — on macOS — a sizing intent. It never touches the platter.
    ///
    /// **What this fixes.** Eight of the app's nine macOS sheets painted no
    /// ground at all, so they rendered on the system's neutral window grey while
    /// the app behind them was warm — a cold rectangle opening out of a cream
    /// window. The ninth, `DesktopTaskEditor`, already did the right thing by
    /// painting `junoReadingCanvas()` inside its own content, and this is that
    /// pattern named. The presentation clips its content to the platter shape,
    /// so the canvas fills the interior while the system keeps the rim, the
    /// corner radius and the material edge.
    ///
    /// `scrollContentBackground(.hidden)` is not optional here: a `Form` or a
    /// `List` supplies its own opaque grouped background, which would cover the
    /// canvas this puts down and, on iOS, the platter underneath it. For a
    /// destination *pushed* inside the sheet's `NavigationStack`, add
    /// `.containerBackground(.clear, for: .navigation)` as well — a pushed
    /// container paints its own ground a second time.
    ///
    /// On iOS this deliberately implies a **full-height** sheet. A sheet that
    /// carries sustained text is a reading surface, and a reading surface does
    /// not get glass. For anything short and chrome-like, use
    /// ``junoUtilitySheet(detents:showsDragIndicator:)`` instead.
    func junoSheetSurface(_ sizing: JunoSheetSizing = .form) -> some View {
        modifier(JunoSheetSurface(sizing: sizing))
    }

    /// A short, chrome-like **utility** sheet on iOS: a share picker, a model
    /// chooser, a handful of actions.
    ///
    /// Paints **no ground whatsoever**, and that omission is the whole design.
    /// A sheet gets the Liquid Glass appearance exactly when its detents include
    /// at least one partial-height option; at `.large` the background goes
    /// opaque and attaches to the screen edges. So on iOS the detent set is not
    /// a sizing hint — it is the switch that decides whether the sheet is chrome
    /// or a reading surface. Give a utility sheet a partial detent and let the
    /// system's glass *be* the surface. This is legitimate glass: the sheet is
    /// floating chrome, not something anyone reads at length.
    ///
    /// The drag indicator follows the HIG: a grabber belongs on a sheet the user
    /// can actually resize, so it is only offered when there are two or more
    /// detents, and it is off by default because an indicator on a fixed sheet
    /// promises an interaction that does not exist.
    ///
    /// **macOS: this is a no-op by construction.** Sheets there are not
    /// resizable by detent and both modifiers do nothing, so the whole body is
    /// compiled out rather than being written and silently ignored. Use
    /// ``junoSheetSurface(_:)`` on the desktop.
    func junoUtilitySheet(
        detents: Set<PresentationDetent> = [.medium],
        showsDragIndicator: Bool = false
    ) -> some View {
        modifier(
            JunoUtilitySheet(detents: detents, showsDragIndicator: showsDragIndicator)
        )
    }
}

private struct JunoSheetSurface: ViewModifier {
    let sizing: JunoSheetSizing

    func body(content: Content) -> some View {
        let grounded = content
            .scrollContentBackground(.hidden)
            .background(Color.junoCanvas)

        #if os(macOS)
        // `presentationSizing` is macOS 15 / iOS 18, one notch above this
        // package's own floor — hence the check even though every Juno app is
        // already at or above it.
        if #available(macOS 15.0, *) {
            switch sizing {
            case .form: grounded.presentationSizing(.form)
            case .page: grounded.presentationSizing(.page)
            case .fitted: grounded.presentationSizing(.fitted)
            }
        } else {
            grounded
        }
        #else
        grounded
        #endif
    }
}

private struct JunoUtilitySheet: ViewModifier {
    let detents: Set<PresentationDetent>
    let showsDragIndicator: Bool

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .presentationDetents(detents)
            .presentationDragIndicator(
                showsDragIndicator && detents.count > 1 ? .visible : .automatic
            )
        #else
        content
        #endif
    }
}

// MARK: - Popovers and menus

public extension View {
    /// The content of a `.popover`, an anchored `Menu` body, or an
    /// `.inspector`'s detail.
    ///
    /// **Padding and nothing else.** The system already draws these in Liquid
    /// Glass with its own material, rim and corner radius; the only thing that
    /// was ever inconsistent between them was how far the content sat from the
    /// edge. Adding a background here would remove the glass, which is why this
    /// modifier is deliberately this small — it exists so that the temptation to
    /// write a "popover surface" that paints something has an honest place to
    /// land instead.
    ///
    /// If a popover looks wrong on the warm canvas, the fault is almost always
    /// an opaque fill painted *inside* it, not a missing one outside.
    func junoPopoverContent(
        horizontal: CGFloat = JunoSpace.regular,
        vertical: CGFloat = JunoSpace.cozy
    ) -> some View {
        padding(.horizontal, horizontal)
            .padding(.vertical, vertical)
    }

    /// A dialog's action row: the trailing-aligned Cancel / confirm pair a
    /// custom sheet draws for itself.
    ///
    /// Only for sheets. `.alert` and `.confirmationDialog` build their own
    /// buttons from the roles you give them and must not be given a hand-drawn
    /// row.
    func junoDialogActions() -> some View {
        padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.regular)
    }
}
