import CoreText
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
/// **Named upright faces, one pinned variable italic.** The upright variable
/// file reports its legacy family as `Newsreader 16pt`, so looking it up as
/// "Newsreader" silently fails; and asking SwiftUI for `.weight(.medium)` on a
/// single registered face makes it synthesise a faux-bold. Shipping the real
/// 24pt upright faces and addressing each by its **PostScript** name avoids
/// both traps. The 24pt optical size is right because the serif is only ever
/// set at display sizes.
///
/// The italic is the other way round, because Google Fonts ships no static
/// 24pt Regular Italic: it is Newsreader Italic's variable file
/// (`Newsreader-Italic-Variable.ttf`, axes `opsz` 6–72 and `wght` 200–800),
/// pinned through a font descriptor at **`opsz` 24 and `wght` 400**
/// (``italicAxes``) — the same optical size and weight as ``Face/regular``, so
/// the greeting's name is the exact italic of the words around it, and the
/// web's `font-normal italic`. The pin matters: left to itself CoreText sets
/// `opsz` to the point size, and a 40pt name would take the 40pt cut, finer
/// and tighter than the 24pt upright beside it.
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
    /// The italic: the variable file's default instance, which names itself
    /// `Newsreader16pt-Italic` whatever its axes, drawn at ``JunoSerif/italicAxes``.
    case italic = "Newsreader16pt-Italic"
    case semibold = "Newsreader24pt-SemiBold"

    /// The file in `Resources/Fonts` that carries the face.
    public var fileName: String {
      switch self {
      case .italic: "Newsreader-Italic-Variable.ttf"
      default: "\(rawValue).ttf"
      }
    }

    /// The system-serif equivalent, used when the face is not bundled.
    var systemWeight: Font.Weight {
      switch self {
      case .regular, .italic: .regular
      case .medium: .medium
      case .semibold: .semibold
      }
    }

    var isItalic: Bool { self == .italic }

    /// The bundled face nearest a weight, upright or italic. Italic has one
    /// face, pinned at the greeting's weight, so every italic request lands
    /// on it.
    static func nearest(to weight: Font.Weight, italic: Bool) -> Face {
      if italic { return .italic }
      switch weight {
      case .medium: return .medium
      case .semibold, .bold, .heavy, .black: return .semibold
      default: return .regular
      }
    }
  }

  /// The italic's pinned variation axes, by OpenType tag: the 24pt optical
  /// size of the upright faces, at weight 400.
  public static let italicAxes: [String: Double] = ["opsz": 24, "wght": 400]

  /// ``italicAxes`` keyed as CoreText wants them: each tag's four bytes as a
  /// number (`'opsz'` is 0x6F70737A).
  static var italicVariation: [NSNumber: NSNumber] {
    Dictionary(uniqueKeysWithValues: italicAxes.map { tag, value in
      (NSNumber(value: axisIdentifier(tag)), NSNumber(value: value))
    })
  }

  /// An OpenType axis tag as CoreText's numeric identifier.
  static func axisIdentifier(_ tag: String) -> UInt32 {
    tag.unicodeScalars.reduce(UInt32(0)) { ($0 << 8) | ($1.value & 0xFF) }
  }

  /// The italic at `size` points with its axes pinned.
  ///
  /// A `CTFont` rather than `Font.custom`, which has no way to carry a
  /// variation. Nil when the variable file is not registered: CoreText
  /// answers an unknown name with a default face, which is caught by its
  /// PostScript name (a pinned instance keeps the default's name as a prefix,
  /// `Newsreader16pt-Italic_wght_opsz…`).
  public static func pinnedItalic(size: CGFloat) -> CTFont? {
    let base = CTFontDescriptorCreateWithNameAndSize(Face.italic.rawValue as CFString, size)
    let pinned = CTFontDescriptorCreateCopyWithAttributes(
      base,
      [kCTFontVariationAttribute: italicVariation] as CFDictionary
    )
    let font = CTFontCreateWithFontDescriptor(pinned, size, nil)
    guard (CTFontCopyPostScriptName(font) as String).hasPrefix(Face.italic.rawValue) else { return nil }
    return font
  }

  /// Whether the real Newsreader faces are installed in this process.
  ///
  /// Checked by resolving a face rather than by family name: the family a
  /// Newsreader file registers is not "Newsreader". When false every call
  /// returns the system serif (New York), which is metrically well-behaved and
  /// close in colour — a deliberate, *observable* fallback rather than a
  /// silent change of brand.
  public static let isBundled: Bool = isRegistered(.regular)

  /// Whether the variable italic is installed in this process. Checked on its
  /// own: an app could ship the upright faces without it, and the italic then
  /// falls back to New York's italic while the upright stays Newsreader.
  public static let isItalicBundled: Bool = isRegistered(.italic)

  static func isRegistered(_ face: Face) -> Bool {
    #if canImport(UIKit)
      return UIFont(name: face.rawValue, size: 12) != nil
    #elseif canImport(AppKit)
      return NSFont(name: face.rawValue, size: 12) != nil
    #else
      return false
    #endif
  }

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
    font(size: size, relativeTo: textStyle, face: face, bundled: face.isItalic ? isItalicBundled : isBundled)
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
      if face.isItalic, let italic = pinnedItalic(size: dynamicTypeSize(size, relativeTo: textStyle)) {
        return Font(italic)
      }
      if !face.isItalic {
        return .custom(face.rawValue, size: size, relativeTo: textStyle)
      }
    }
    // New York, at the same size and scaling the same way.
    let fallback = JunoType.systemFont(
      size: size, relativeTo: textStyle, weight: face.systemWeight, design: .serif
    )
    return face.isItalic ? fallback.italic() : fallback
  }

  /// `size` after Dynamic Type on the phone, for the italic, whose `CTFont`
  /// cannot scale itself the way `Font.custom(_:size:relativeTo:)` does. The
  /// Mac has no Dynamic Type; ``SwiftUI/EnvironmentValues/junoTextScale`` has
  /// already scaled `size` there.
  static func dynamicTypeSize(_ size: CGFloat, relativeTo textStyle: Font.TextStyle) -> CGFloat {
    #if canImport(UIKit) && !os(watchOS)
      return UIFontMetrics(forTextStyle: uiTextStyle(textStyle)).scaledValue(for: size)
    #else
      return size
    #endif
  }

  #if canImport(UIKit) && !os(watchOS)
    static func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
      switch style {
      case .largeTitle: .largeTitle
      case .title: .title1
      case .title2: .title2
      case .title3: .title3
      case .headline: .headline
      case .subheadline: .subheadline
      case .body: .body
      case .callout: .callout
      case .footnote: .footnote
      case .caption: .caption1
      case .caption2: .caption2
      @unknown default: .body
      }
    }
  #endif

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
