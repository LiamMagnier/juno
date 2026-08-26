import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// Juno's display typography API.
///
/// The public name is kept for source compatibility, but display text now uses
/// the system face too. Mixing an editorial web font into navigation titles and
/// cards made the native app feel like a web page in a sheet, broke the visual
/// rhythm at large Dynamic Type sizes, and gave iOS and iPadOS a different voice
/// from their controls. Weight, colour and spacing now carry hierarchy while SF
/// Pro supplies optical sizing and the platform's accessibility metrics.
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
    let system = Font.system(textStyle, design: .default, weight: face.systemWeight)
    return face.isItalic ? system.italic() : system
  }

  /// The home greeting — the largest expressive type in the product.
  /// Mirrors the web's `text-[1.95rem]` / `sm:text-[2.45rem]` pair.
  public static func greeting(compact: Bool = false) -> Font {
    .system(compact ? .title2 : .title, design: .default, weight: .semibold)
  }

  /// The greeting's trailing first name: medium italic, as on the web
  /// (`font-medium italic text-primary`). Colour is applied by the caller.
  public static func greetingName(compact: Bool = false) -> Font {
    .system(compact ? .title2 : .title, design: .default, weight: .semibold).italic()
  }

  /// A page heading: a project's name, an editorial section title.
  public static func pageHeading(compact: Bool = false) -> Font {
    .system(compact ? .title2 : .title, design: .default, weight: .bold)
  }

  /// A card or row title that earns the editorial voice.
  public static let cardTitle: Font = .system(.headline, design: .default, weight: .semibold)
}

extension View {
  /// Juno's greeting type: the editorial serif at its largest.
  public func junoGreeting(compact: Bool = false) -> some View {
    font(JunoSerif.greeting(compact: compact))
  }

  /// A page's editorial heading.
  public func junoPageHeading(compact: Bool = false) -> some View {
    font(JunoSerif.pageHeading(compact: compact))
  }
}
