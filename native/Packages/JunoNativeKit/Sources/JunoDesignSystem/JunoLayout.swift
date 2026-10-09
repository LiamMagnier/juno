import SwiftUI

// MARK: - Placement metrics (spacing pass, 2026-10-09)
//
// The owner, on an iPhone top bar with a truncated title and an odd capsule:
// "everywhere on the app rework the placement of icons, object, but also
// paddings and everything." Before this file every screen spelled its own
// numbers: a drawer row 44pt tall with a 19pt glyph in a 24pt slot beside one
// with an 18pt glyph in a 20pt slot, row fills at 8, 10, 11 and 12, glyph gaps
// of 7, 10 and 12, a top-bar title capped at a fixed 220pt that truncated
// with 60pt of bar to spare.
//
// `JunoLayout` names each placement once. Every number is a step of
// ``JunoSpace`` (itself ``JunoGeneratedSpace``, the web's Tailwind scale) or a
// platform constant (the 44pt touch target); nothing here is a fresh literal.
// See docs/native/spacing-pass/AUDIT.md for the screen-by-screen findings.

/// Where things sit: bar, controls, rows, pages and sheets, on both apps.
public enum JunoLayout {

    // MARK: Touch

    /// The smallest thing a finger may be asked to hit (Apple HIG): 44pt.
    public static let touchTarget: CGFloat = JunoGeneratedSpace.step10 + JunoGeneratedSpace.step1

    /// The smallest thing a pointer may be asked to hit on the Mac: 28pt, the
    /// system's regular control height plus its focus ring.
    public static let pointerTarget: CGFloat = JunoGeneratedSpace.step7

    // MARK: Top bar

    /// The iOS 26 navigation bar: one round glass button at each end, the
    /// title centred between them.
    ///
    /// The system draws a bar item's glass at 44pt on the bar's centre line
    /// 16pt from the screen edge, so these numbers *describe* the bar rather
    /// than override it. Custom headers that stand in for the bar (the
    /// drawer's, the iPad's docked panels) use them to land on the same line.
    public enum Bar {
        /// A bar button's glass circle.
        public static let button: CGFloat = JunoLayout.touchTarget
        /// The glyph inside it: the web's 20pt interface icon.
        public static let glyph: CGFloat = JunoSpace.roomy
        /// The bar's edge inset, screen edge to the first circle.
        public static let edge: CGFloat = JunoSpace.regular
        /// Between two separate circles on one side.
        public static let gap: CGFloat = JunoSpace.snug
        /// The least air between the title and a circle.
        public static let titleClearance: CGFloat = JunoSpace.cozy

        /// The widest a centred title may be in a bar `width` points wide with
        /// `leading` and `trailing` circles, so it never reaches either side.
        ///
        /// The system centres a principal item on the bar, not in the space
        /// left between the items, so the room is symmetric: the bar less
        /// twice the wider side, less the clearance on both. A fixed cap (the
        /// old 220) wasted 40–60pt on a 402pt phone and overflowed on a 320pt
        /// Display Zoom one, which is when iOS folds bar items into "…".
        public static func titleWidth(barWidth width: CGFloat, leading: Int = 1, trailing: Int = 1) -> CGFloat {
            let side = max(extent(of: leading), extent(of: trailing))
            return max(0, width - 2 * side - 2 * titleClearance)
        }

        /// How far `count` circles reach in from the edge.
        public static func extent(of count: Int) -> CGFloat {
            guard count > 0 else { return edge }
            return edge + CGFloat(count) * button + CGFloat(count - 1) * gap
        }
    }

    // MARK: Controls

    /// Capsule and circle controls — "rounded like the iPhone Calendar app".
    /// Icon-only controls are circles, labelled ones capsules, both on one
    /// height so a row of them shares a centre line.
    public enum Control {
        /// A full-size control: a bar button, a sheet's close, a composer key.
        public static let height: CGFloat = JunoLayout.touchTarget
        /// A control inside a card or a row (Run, Send answer, a hint), still
        /// a 44pt target through its content shape.
        public static let compactHeight: CGFloat = JunoSpace.region + JunoSpace.hairline
        /// A capsule's horizontal pad around its label.
        public static let capsulePadding: CGFloat = JunoSpace.regular
        /// A compact capsule's horizontal pad.
        public static let compactCapsulePadding: CGFloat = JunoSpace.cozy
        /// Glyph to label inside a capsule.
        public static let labelGap: CGFloat = JunoSpace.tight
        /// Between neighbouring controls in a row.
        public static let gap: CGFloat = JunoSpace.snug
        /// A control's glyph.
        public static let glyph: CGFloat = JunoSpace.ample
    }

    // MARK: Rows

    /// List and sidebar rows. The web sidebar's two text edges hold on every
    /// platform: glyphs start 16pt in, in a 20pt slot, and labels start at 46
    /// (slot + 10pt gap); a glyph-less row's text sits on the 16pt edge.
    public enum Row {
        /// An iOS row: the touch target.
        public static let height: CGFloat = JunoLayout.touchTarget
        /// A Mac / web sidebar row: 32, abutting.
        public static let compactHeight: CGFloat = JunoSpace.region
        /// A section heading's height on the Mac / web sidebar.
        public static let headingHeight: CGFloat = JunoSpace.wide
        /// The row's text edge from its container.
        public static let edge: CGFloat = JunoSpace.regular
        /// The glyph's slot; glyphs centre in it.
        public static let glyphSlot: CGFloat = JunoSpace.roomy
        /// The web's interface glyph, 16pt (Mac, iPad sidebar).
        public static let glyph: CGFloat = JunoSpace.regular
        /// The phone's larger glyph, 18pt, still inside the 20pt slot.
        public static let touchGlyph: CGFloat = JunoSpace.ample
        /// Slot to label.
        public static let glyphGap: CGFloat = JunoSpace.close
        /// Where a label after a glyph starts: 16 + 20 + 10 = 46.
        public static var labelEdge: CGFloat { edge + glyphSlot + glyphGap }
        /// A selection or press fill's distance from the container edge.
        public static let fillInset: CGFloat = JunoSpace.snug
        /// The fill's own inner pad, so text inside a fill lands on ``edge``.
        public static var fillPadding: CGFloat { edge - fillInset }
        /// A row fill's corner on iOS: the web's `field`, concentric with a
        /// 44pt row 8pt in from a 16pt-radius card edge.
        public static let fillRadius: CGFloat = JunoRadius.field
        /// A row fill's corner on the Mac / iPad sidebar: the web's `md`.
        public static let compactFillRadius: CGFloat = JunoRadius.md
        /// The quiet trailing slot (a count, a kebab, a spinner), so every
        /// trailing mark down a column shares one centre.
        public static let trailingSlot: CGFloat = JunoSpace.roomy
        /// A section label's air above it.
        public static let sectionTop: CGFloat = JunoSpace.cozy
        /// A section label's air below it.
        public static let sectionBottom: CGFloat = JunoSpace.hairline
    }

    // MARK: Pages

    /// A scrolling page: gutters, section rhythm, cards.
    public enum Page {
        /// The phone's page gutter: 16, iOS's own readable margin on a phone.
        public static let gutter: CGFloat = JunoSpace.regular
        /// Between a page's header and its first section.
        public static let headerGap: CGFloat = JunoSpace.section
        /// Between sections.
        public static let sectionGap: CGFloat = JunoSpace.section
        /// Between rows of cards, or a card and the next block.
        public static let blockGap: CGFloat = JunoSpace.cozy
        /// A content card's inner pad.
        public static let cardPadding: CGFloat = JunoSpace.regular
        /// A content card's corner.
        public static let cardRadius: CGFloat = JunoRadius.card
        /// The bottom margin a page keeps above a floating composer or bar.
        public static let bottomMargin: CGFloat = JunoSpace.region
    }

    // MARK: Empty states

    /// The centred block a page shows when it has nothing yet.
    public enum Empty {
        /// Mark or glyph to title.
        public static let markGap: CGFloat = JunoSpace.regular
        /// Title to its sentence.
        public static let textGap: CGFloat = JunoSpace.tight
        /// Sentence to the action.
        public static let actionGap: CGFloat = JunoSpace.roomy
        /// The block's side margin, so a sentence never runs to the edge.
        public static let sideMargin: CGFloat = JunoSpace.region
        /// The widest a sentence runs.
        public static let measure: CGFloat = 320
    }

    // MARK: Sheets

    /// A sheet's own content (the system draws the sheet, its corners and
    /// grabber; these place what sits inside).
    public enum Sheet {
        /// The sheet's side gutter.
        public static let gutter: CGFloat = JunoSpace.roomy
        /// Air under the sheet's bar before the first content.
        public static let top: CGFloat = JunoSpace.snug
        /// Air above the sheet's bottom edge.
        public static let bottom: CGFloat = JunoSpace.section
    }

    // MARK: Transcript

    /// The conversation column.
    public enum Transcript {
        /// The column's side gutter on a phone.
        public static let gutter: CGFloat = JunoSpace.regular
        /// Between turns.
        public static let turnGap: CGFloat = JunoSpace.section
        /// Under the last turn, above the composer.
        public static let bottom: CGFloat = JunoSpace.section
        /// The quiet message-action keys under an answer: each a 44pt target,
        /// glyph 16, the first glyph on the text's edge.
        public static let actionGlyph: CGFloat = JunoSpace.regular
    }
}
