import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Juno's editorial serif — Newsreader, the same face the website loads through
/// `next/font/google` (see `src/app/layout.tsx`).
///
/// **Where it is used.** On the web the serif is the *whole* UI typeface:
/// `tailwind.config.ts` maps `font-sans` onto it as well as `font-serif`. Native
/// deliberately does not follow that all the way. Controls, lists and body copy
/// stay on the system font, where SF Pro's optical sizing and Dynamic Type
/// metrics are most of what makes a phone UI feel native. The serif carries the
/// web's editorial voice exactly where that voice is the point — the home
/// greeting, page headings, project titles.
///
/// **Why named faces rather than the variable font.** The variable file reports
/// its legacy family as `Newsreader 16pt`, so looking it up as "Newsreader"
/// silently fails; and asking SwiftUI for `.weight(.medium)` on a single
/// registered face makes it synthesise a faux-bold. Shipping the four real 24pt
/// faces and addressing each by its **PostScript** name avoids both traps. The
/// 24pt optical size is the right one because the serif is only used at display
/// sizes here, never for body text.
public enum JunoSerif {
    /// The faces bundled in `Resources/Fonts` and registered via `UIAppFonts`.
    /// The raw value is the PostScript name, which is what `Font.custom` and
    /// `UIFont(name:)` resolve against — not the family name.
    public enum Face: String, CaseIterable, Sendable {
        case regular = "Newsreader24pt-Regular"
        case medium = "Newsreader24pt-Medium"
        case mediumItalic = "Newsreader24pt-MediumItalic"
        case semibold = "Newsreader24pt-SemiBold"

        /// The system-serif equivalent, used when the face is not bundled.
        var systemWeight: Font.Weight {
            switch self {
            case .regular: .regular
            case .medium, .mediumItalic: .medium
            case .semibold: .semibold
            }
        }

        var isItalic: Bool { self == .mediumItalic }
    }

    /// Whether the real Newsreader faces are installed in this process.
    ///
    /// Checked by resolving a face rather than by family name: the family a
    /// Newsreader file registers is not "Newsreader". When false every call
    /// below returns the system serif (New York), which is metrically
    /// well-behaved and close in colour — a deliberate, *observable* fallback
    /// rather than a silent change of brand.
    public static let isBundled: Bool = {
        #if canImport(UIKit)
        return UIFont(name: Face.regular.rawValue, size: 12) != nil
        #elseif canImport(AppKit)
        return NSFont(name: Face.regular.rawValue, size: 12) != nil
        #else
        return false
        #endif
    }()

    /// A serif font that scales with Dynamic Type.
    ///
    /// - Parameters:
    ///   - size: the point size at the `.large` content size.
    ///   - textStyle: the style the size scales against. Pass the one closest in
    ///     role, or the text will grow at the wrong rate for its purpose.
    ///   - face: which real face to use.
    public static func font(
        size: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        face: Face = .regular
    ) -> Font {
        guard isBundled else {
            let system = Font.system(size: size, weight: face.systemWeight, design: .serif)
            return face.isItalic ? system.italic() : system
        }
        return .custom(face.rawValue, size: size, relativeTo: textStyle)
    }

    /// The home greeting — the largest expressive type in the product.
    /// Mirrors the web's `text-[1.7rem]` / `sm:text-[2.35rem]` pair.
    public static func greeting(compact: Bool = false) -> Font {
        font(size: compact ? 27 : 38, relativeTo: .largeTitle)
    }

    /// The greeting's trailing first name: medium italic, as on the web
    /// (`font-medium italic text-primary`). Colour is applied by the caller.
    public static func greetingName(compact: Bool = false) -> Font {
        font(size: compact ? 27 : 38, relativeTo: .largeTitle, face: .mediumItalic)
    }

    /// A page heading: a project's name, an editorial section title.
    public static func pageHeading(compact: Bool = false) -> Font {
        font(size: compact ? 24 : 28, relativeTo: .title, face: .medium)
    }

    /// A card or row title that earns the editorial voice.
    public static let cardTitle: Font = font(size: 19, relativeTo: .title3, face: .medium)
}

public extension View {
    /// Juno's greeting type: the editorial serif at its largest.
    func junoGreeting(compact: Bool = false) -> some View {
        font(JunoSerif.greeting(compact: compact))
    }

    /// A page's editorial heading.
    func junoPageHeading(compact: Bool = false) -> some View {
        font(JunoSerif.pageHeading(compact: compact))
    }
}
