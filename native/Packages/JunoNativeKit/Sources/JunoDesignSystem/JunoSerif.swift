import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// Newsreader: the greeting's face, and the wordmark's. Nothing else.
///
/// The web keeps its serif to exactly two human moments — "How can I help,
/// *Liam*?" and the name set as type — and the redesign does the same (§0.2).
/// So this type returns real Newsreader at the size it is asked for, and the
/// ladder reaches it only through ``JunoType/display(size:)`` and
/// ``JunoType/displayItalic(size:)``.
///
/// **It used to return SF.** For a stretch every call here resolved to the
/// system face at the text style's size, ignoring the `size:` argument, and
/// about thirty call sites — learning blocks, the step lab, the phone's
/// thought-process and memory views, two Mac pages — had grown up on that
/// sans rendering while still spelling "serif". Those sites moved to sans
/// ``JunoType`` rungs *before* this started returning Newsreader, so nothing
/// turned serif by accident. The four sans helpers at the bottom
/// (``pageHeading(compact:)``, ``cardTitle``, ``greeting(compact:)``,
/// ``greetingName(compact:)``) live here for source compatibility only; none of
/// them sets Newsreader except the Mac greeting.
///
/// **Why named faces rather than the variable font.** The variable file reports
/// its legacy family as `Newsreader 16pt`, so looking it up as "Newsreader"
/// silently fails; and asking SwiftUI for `.weight(.medium)` on a single
/// registered face makes it synthesise a faux-bold. Shipping the real 24pt
/// faces and addressing each by its **PostScript** name avoids both traps. The
/// 24pt optical size is right because the serif is only ever set at display
/// sizes.
///
/// The faces ship in `native/iOS/JunoMobile/Resources/Fonts`, registered by
/// `UIAppFonts` on the phone and by `ATSApplicationFontsPath` on the Mac, whose
/// project references the same folder.
public enum JunoSerif {
  /// The faces bundled in `Resources/Fonts`. The raw value is the PostScript
  /// name — what `Font.custom` and `UIFont(name:)` resolve against — verified
  /// against each file's `name` table (ID 6).
  public enum Face: String, CaseIterable, Sendable {
    case regular = "Newsreader24pt-Regular"
    case medium = "Newsreader24pt-Medium"
    /// The only italic bundled. The web's greeting name is Newsreader's
    /// *regular* italic; `Newsreader24pt-Italic.ttf` is not in the bundle yet,
    /// so the name is a half-weight heavier than the web's until it is.
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

    /// The bundled face nearest a weight, upright or italic. Italic has one
    /// face, so every italic request lands on it.
    static func nearest(to weight: Font.Weight, italic: Bool) -> Face {
      if italic { return .mediumItalic }
      switch weight {
      case .medium: return .medium
      case .semibold, .bold, .heavy, .black: return .semibold
      default: return .regular
      }
    }
  }

  /// Whether the real Newsreader faces are installed in this process.
  ///
  /// Checked by resolving a face rather than by family name: the family a
  /// Newsreader file registers is not "Newsreader". When false every call
  /// returns the system serif (New York), which is metrically well-behaved and
  /// close in colour — a deliberate, *observable* fallback rather than a
  /// silent change of brand.
  public static let isBundled: Bool = {
    #if canImport(UIKit)
      return UIFont(name: Face.regular.rawValue, size: 12) != nil
    #elseif canImport(AppKit)
      return NSFont(name: Face.regular.rawValue, size: 12) != nil
    #else
      return false
    #endif
  }()

  /// Newsreader at `size`, scaling with Dynamic Type relative to `textStyle`.
  ///
  /// - Parameters:
  ///   - size: the point size at the default text size.
  ///   - textStyle: the style the size scales against on the phone. Pass the
  ///     one closest in role.
  ///   - face: which real face to use.
  ///
  /// Reach for ``JunoType/display(size:)`` rather than this: the greeting is
  /// the only thing that should be set in it.
  public static func font(
    size: CGFloat,
    relativeTo textStyle: Font.TextStyle,
    face: Face = .regular
  ) -> Font {
    font(size: size, relativeTo: textStyle, face: face, bundled: isBundled)
  }

  /// The resolution itself, with the bundle check passed in so a test can
  /// exercise both halves in one process.
  static func font(
    size: CGFloat,
    relativeTo textStyle: Font.TextStyle,
    face: Face,
    bundled: Bool
  ) -> Font {
    if bundled {
      // A registered face already carries its slant: no `.italic()` on top,
      // which would ask for an oblique of an italic.
      return .custom(face.rawValue, size: size, relativeTo: textStyle)
    }
    // New York, at the same size and scaling the same way.
    let fallback = JunoType.systemFont(
      size: size, relativeTo: textStyle, weight: face.systemWeight, design: .serif
    )
    return face.isItalic ? fallback.italic() : fallback
  }

  /// The display rung's font: the nearest bundled face to `weight`.
  static func displayFont(
    size: CGFloat,
    relativeTo textStyle: Font.TextStyle,
    weight: Font.Weight,
    italic: Bool
  ) -> Font {
    font(size: size, relativeTo: textStyle, face: .nearest(to: weight, italic: italic))
  }

  // MARK: - Source compatibility

  /// The home greeting. On the Mac, Newsreader at the display rung; on the
  /// phone, the system face its greeting was composed in, until the phone's
  /// own pass.
  ///
  /// The Mac's size is fixed at 40 (the web's size at an 832pt column) because
  /// this signature has no column to measure; the redesigned empty state sets
  /// ``JunoType/display(size:)`` from ``JunoType/displaySize(forColumnWidth:)``.
  public static func greeting(compact: Bool = false) -> Font {
    #if os(macOS)
      JunoType.display(size: compact ? displayCompactSize : displayRegularSize).font()
    #else
      .system(compact ? .title2 : .title, design: .default, weight: .semibold)
    #endif
  }

  /// The greeting's trailing first name, italic. Colour is applied by the
  /// caller — and is never the accent (§0.4).
  public static func greetingName(compact: Bool = false) -> Font {
    #if os(macOS)
      JunoType.displayItalic(size: compact ? displayCompactSize : displayRegularSize).font()
    #else
      .system(compact ? .title2 : .title, design: .default, weight: .semibold).italic()
    #endif
  }

  /// A page heading — **sans**, despite the namespace. On the Mac it is the
  /// ladder: ``JunoType/pageTitle``, or ``JunoType/title`` when compact. The
  /// phone keeps its bold text styles until its own pass.
  ///
  /// Prefer ``SwiftUI/View/junoPageTitle(columnWidth:)`` in new code, which
  /// also carries the rung's tracking and line height.
  public static func pageHeading(compact: Bool = false) -> Font {
    #if os(macOS)
      (compact ? JunoType.title : JunoType.pageTitle).font()
    #else
      .system(compact ? .title2 : .title, design: .default, weight: .bold)
    #endif
  }

  /// A card or row title — **sans**, despite the namespace. On the Mac it is
  /// the ladder's ``JunoType/ui`` rung at semibold, which is the 13pt semibold
  /// these titles have always rendered at there; the phone keeps its headline.
  ///
  /// New card designs use ``JunoType/heading`` (§8.2: "sheet titles, card
  /// titles").
  public static let cardTitle: Font = {
    #if os(macOS)
      JunoType.ui.weight(.semibold).font()
    #else
      .system(.headline, design: .default, weight: .semibold)
    #endif
  }()

  /// The fixed greeting sizes the source-compatible helpers use: the web's
  /// display size at a 640pt and an 832pt column.
  static let displayCompactSize: CGFloat = JunoGeneratedType.display.minSize
  static let displayRegularSize: CGFloat = 40
}

extension View {
  /// The greeting's type. See ``JunoSerif/greeting(compact:)``.
  public func junoGreeting(compact: Bool = false) -> some View {
    font(JunoSerif.greeting(compact: compact))
  }

  /// A page heading — **sans**. On the Mac, ``JunoType/pageTitle`` (or
  /// ``JunoType/title`` when compact) with the rung's tracking and line
  /// height; the phone keeps its bold text styles until its own pass.
  ///
  /// New code: ``junoPageTitle(columnWidth:)``.
  @ViewBuilder
  public func junoPageHeading(compact: Bool = false) -> some View {
    #if os(macOS)
      junoType(compact ? .title : .pageTitle)
    #else
      font(JunoSerif.pageHeading(compact: compact))
    #endif
  }
}
