import SwiftUI
import JunoDesignSystem

/// Juno Code's visual rules, in one place.
///
/// The shared design system supplies the palette, the spacing ladder and the
/// motion curves; this adds the few decisions that belong to Code alone. The
/// audit that led here counted ten type sizes, six radii and nine status
/// mappers in the old workbench; everything in the Studio views draws from the
/// short lists below instead.
///
/// - **Type.** Reading text is 14pt — the thread is the product and is read at
///   length. Controls are 13pt, metadata 12pt, and nothing is smaller than
///   11pt. Monospace is for code, paths and commands, never for labels.
/// - **Colour.** Warm neutrals do the work. The primary action is solid ink,
///   not colour. Coral marks exactly two states — working, and needs you — so
///   it always means something when it appears.
/// - **Surfaces.** Opaque for anything read at length; one hairline between
///   regions; no shadows on content, a soft one only on the floating composer.
public enum Studio {
    // MARK: Type

    /// Semantic styles, so every size moves with the reader's text-size
    /// setting. On the Mac they land exactly on the scale: largeTitle 26,
    /// title3 15, body 13, callout 12, subheadline 11. The one size with no
    /// style of its own — 14pt reading text — is ``SwiftUI/View/studioReadingFont()``.
    public enum Font {
        /// The landing greeting.
        public static let display = SwiftUI.Font.system(.largeTitle, weight: .semibold)
        /// A thread's title, a settings page's heading.
        public static let title = SwiftUI.Font.system(.title3, weight: .semibold)
        /// Messages as a `Font` value, for the few views that need one; prefer
        /// `.studioReadingFont()`, which is 14pt.
        public static let reading = SwiftUI.Font.system(.body)
        /// Buttons, rows, menus.
        public static let label = SwiftUI.Font.system(.body)
        public static let labelEmphasis = SwiftUI.Font.system(.body, weight: .medium)
        /// Secondary facts beside a label.
        public static let meta = SwiftUI.Font.system(.callout)
        public static let metaEmphasis = SwiftUI.Font.system(.callout, weight: .medium)
        /// Section headings in lists; the floor.
        public static let caption = SwiftUI.Font.system(.subheadline, weight: .medium)
        /// Code, paths, commands.
        public static let mono = SwiftUI.Font.system(.callout, design: .monospaced)
        public static let monoSmall = SwiftUI.Font.system(.subheadline, design: .monospaced)
        /// Numbers that tick — elapsed time, diff counts — so they do not jitter.
        public static let metaDigits = SwiftUI.Font.system(.callout).monospacedDigit()
    }

    // MARK: Colour

    public enum Ink {
        public static let primary = Color.junoForeground
        public static let secondary = Color.junoMutedForeground
        public static let tertiary = Color.junoMutedForeground.opacity(0.72)
        public static let accent = Color.junoAccent
        public static let danger = Color.junoDanger
        public static let success = Color.junoSuccess
        public static let added = Color.junoSuccess
        public static let removed = Color.junoDanger
    }

    public enum Surface {
        /// The thread and every reading surface.
        public static let canvas = Color.junoCanvas
        /// Cards and fields that sit on the canvas.
        public static let raised = Color.junoSurface
        /// Quiet fills: a user's message, a code well, a hovered row.
        public static let muted = Color.junoMuted
        public static let hairline = Color.junoHairline
        public static let hover = Color.junoForeground.opacity(0.05)
        public static let selected = Color.junoForeground.opacity(0.08)
    }

    // MARK: Geometry

    public enum Radius {
        public static let small: CGFloat = 6
        public static let row: CGFloat = 8
        public static let card: CGFloat = 10
        public static let composer: CGFloat = JunoRadius.composer
    }

    public enum Metrics {
        /// The thread's line length: long enough for code, short enough to read.
        public static let measure: CGFloat = 720
        /// Horizontal gutter either side of the measure.
        public static let gutter: CGFloat = JunoSpace.section
        /// One row of a list or menu.
        public static let rowHeight: CGFloat = 28
        /// A button or chip on the composer's control row.
        public static let control: CGFloat = 28
        /// The side panel's comfortable width.
        public static let panelIdeal: CGFloat = 440
        public static let panelMinimum: CGFloat = 340
        public static let panelMaximum: CGFloat = 720
    }
}

// MARK: - Shared modifiers

public extension View {
    /// The thread's reading size: 14pt at the default text size, scaling with
    /// the reader's setting like everything else.
    func studioReadingFont() -> some View {
        junoFont(size: 14, relativeTo: .body)
    }
}

extension View {
    /// A hairline rule under or beside a region.
    func studioHairline(_ edge: Edge = .bottom) -> some View {
        overlay(alignment: edge.alignment) {
            Rectangle()
                .fill(Studio.Surface.hairline)
                .frame(
                    width: edge.isHorizontal ? 1 : nil,
                    height: edge.isHorizontal ? nil : 1
                )
        }
    }
}

private extension Edge {
    var isHorizontal: Bool { self == .leading || self == .trailing }

    var alignment: Alignment {
        switch self {
        case .top: .top
        case .bottom: .bottom
        case .leading: .leading
        case .trailing: .trailing
        }
    }
}
