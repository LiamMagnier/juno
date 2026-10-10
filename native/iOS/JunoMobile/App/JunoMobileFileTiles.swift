import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

// A file, drawn as itself: the tiles and rows the Library and a project's Files
// share. The website's `EntryTile` / `EntryRow` (src/components/library/
// library-items.tsx): a raised card with the preview at 4:3 inside it, then the
// name and "PDF · 412 KB"; or a row led by a small real thumbnail.
//
// The pictures come from ``NativeFilePreviewLoader`` — ImageIO for images, a
// QuickLook-rendered first page for documents — which the Mac's Library and
// both "attach from Library" pickers already use, so a PDF looks like *that*
// PDF on every surface.

// MARK: - Preview surface

/// The picture where there is one, the type's glyph on the inset fill where
/// there is not, and nothing at all — no spinner — while it loads.
struct JunoMobileFilePreviewSurface: View {
  let request: NativeFilePreviewRequest
  let state: NativeFilePreviewLoader.State
  var glyphSize: CGFloat = 26

  var body: some View {
    ZStack {
      Color.junoSecondary
      switch state {
      case .ready(let image):
        Image(decorative: image, scale: 1)
          .resizable()
          .scaledToFill()
          // A photo is recognised by its middle; a document by its first
          // lines. Cropping a page to its centre shows a paragraph from nowhere.
          .frame(
            maxWidth: .infinity,
            maxHeight: .infinity,
            alignment: request.isImage ? .center : .top
          )
          .transition(.opacity)
      case .loading:
        EmptyView()
      case .unavailable:
        VStack(spacing: JunoSpace.tight) {
          JunoIconView(JunoMobileFileKind.icon(for: request.fileName, isImage: request.isImage), size: glyphSize)
            .foregroundStyle(Color.junoSecondaryInk)
          if glyphSize > 20 {
            Text(JunoMobileFileKind.label(for: request.fileName, isImage: request.isImage))
              .junoFont(size: 11, relativeTo: .caption2, weight: .semibold, design: .monospaced)
              .foregroundStyle(Color.junoTertiaryInk)
          }
        }
      }
    }
    .clipped()
    .accessibilityHidden(true)
  }
}

// MARK: - Tile

/// One file as a grid tile: the preview at 4:3 in a raised card, the name, and
/// its kind and size.
struct JunoMobileFileTile: View {
  let request: NativeFilePreviewRequest
  let state: NativeFilePreviewLoader.State
  /// "2 hr", "Yesterday"… after the size, where the reader sorts by time.
  var date: Date?
  /// A file a chat or project uses wears a quiet note under its name.
  var note: String?

  var body: some View {
    let inner = RoundedRectangle(cornerRadius: JunoRadius.card - JunoSpace.hairline, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      JunoMobileFilePreviewSurface(request: request, state: state)
        .aspectRatio(4 / 3, contentMode: .fit)
        .clipShape(inner)
        .overlay(inner.strokeBorder(Color.junoHairline, lineWidth: 0.5))
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(request.fileName)
          .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .truncationMode(.middle)
        Text(detail)
          .junoFont(size: 12, relativeTo: .caption)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
      }
      .padding(.horizontal, JunoSpace.snug)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.tight)
    }
    .padding(JunoSpace.hairline)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
    )
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(request.fileName), \(detail)")
    .accessibilityAddTraits(.isButton)
  }

  private var detail: String {
    var parts = [JunoMobileFileKind.label(for: request.fileName, isImage: request.isImage), request.sizeLabel]
    if let note { parts.append(note) } else if let date { parts.append(JunoMobileRelativeDate.text(date)) }
    return parts.joined(separator: " · ")
  }
}

// MARK: - Row

/// One file as a list row: a 44pt real thumbnail, the name, then kind, size and
/// date.
struct JunoMobileFileRowLabel: View {
  let request: NativeFilePreviewRequest
  let state: NativeFilePreviewLoader.State
  var date: Date?
  var note: String?

  var body: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoMobileFilePreviewSurface(request: request, state: state, glyphSize: 18)
        .frame(width: JunoLayout.touchTarget, height: JunoLayout.touchTarget)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
            .strokeBorder(Color.junoHairline, lineWidth: 0.5)
        )
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(request.fileName)
          .junoFont(size: 16, relativeTo: .body, weight: .medium)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .truncationMode(.middle)
        Text(detail)
          .junoFont(size: 13, relativeTo: .footnote)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, JunoSpace.snug)
    .frame(minHeight: JunoLayout.touchTarget)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(request.fileName), \(detail)")
    .accessibilityAddTraits(.isButton)
  }

  private var detail: String {
    var parts = [JunoMobileFileKind.label(for: request.fileName, isImage: request.isImage), request.sizeLabel]
    if let note { parts.append(note) }
    if let date { parts.append(JunoMobileRelativeDate.text(date)) }
    return parts.joined(separator: " · ")
  }
}

// MARK: - Kind

/// What a file is, from its name: the glyph and the short label ("PDF",
/// "Image", "Sheet").
enum JunoMobileFileKind {
  static func label(for fileName: String, isImage: Bool) -> String {
    if isImage { return String(localized: "Image") }
    let ext = URL(fileURLWithPath: fileName).pathExtension.lowercased()
    switch ext {
    case "pdf": return "PDF"
    case "doc", "docx", "pages", "rtf": return String(localized: "Document")
    case "xls", "xlsx", "csv", "numbers": return String(localized: "Sheet")
    case "ppt", "pptx", "key": return String(localized: "Deck")
    case "md", "txt": return String(localized: "Text")
    case "": return String(localized: "File")
    default: return ext.uppercased()
    }
  }

  static func icon(for fileName: String, isImage: Bool) -> JunoIcon {
    if isImage { return .image }
    switch URL(fileURLWithPath: fileName).pathExtension.lowercased() {
    case "xls", "xlsx", "csv", "numbers": return .grid
    case "ppt", "pptx", "key": return .artifacts
    case "zip", "gz", "tar": return .box
    case "mp3", "m4a", "wav", "aac": return .audioLines
    case "mov", "mp4", "m4v": return .video
    case "swift", "js", "ts", "tsx", "py", "json", "html", "css": return .fileCode
    default: return .file
    }
  }
}

// MARK: - Entry tile

/// A way into another shelf of the Library — Made by Alevr, Artifacts — as a
/// tile with its own small orbit drawing, the serif name and one line.
struct JunoMobileLibraryEntryTile: View {
  enum Art { case made, artifacts }

  let title: String
  let detail: String
  let art: Art

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      drawing
        .frame(maxWidth: .infinity)
        .frame(height: JunoMobileLibraryMetrics.entryArt)
        .background(Color.junoSecondary)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card - JunoSpace.hairline, style: .continuous))
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        HStack(spacing: JunoSpace.hairline) {
          Text(title)
            .font(JunoSerif.font(size: 18, relativeTo: .headline, face: .medium))
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1)
          Spacer(minLength: 0)
          JunoIconView(.chevronRight, size: 12)
            .foregroundStyle(Color.junoTertiaryInk)
        }
        Text(detail)
          .junoFont(size: 12, relativeTo: .caption)
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(2, reservesSpace: true)
      }
      .padding(.horizontal, JunoSpace.snug)
      .padding(.bottom, JunoSpace.tight)
    }
    .padding(JunoSpace.hairline)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
    )
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title). \(detail)")
    .accessibilityAddTraits(.isButton)
  }

  @ViewBuilder
  private var drawing: some View {
    switch art {
    case .made:
      // Three nested orbits with the presence arc travelling the middle one:
      // the construction, small — things Alevr itself drew.
      JunoDotRings(
        rings: [
          JunoDotRing(cx: 0.5, cy: 0.56, rx: 0.13, ry: 0.22),
          JunoDotRing(cx: 0.5, cy: 0.56, rx: 0.2, ry: 0.33),
          JunoDotRing(cx: 0.5, cy: 0.56, rx: 0.3, ry: 0.5, faint: true),
        ],
        lines: [JunoDotLine(x1: 0.04, y1: 0.56, x2: 0.96, y2: 0.56, strength: 0.14)],
        arcs: [JunoDotArc(ring: 1, from: -80, to: 30)],
        pitch: 3
      )
    case .artifacts:
      // Three orbits laid side by side, like stacked pages fanned out.
      JunoDotRings(
        rings: [
          JunoDotRing(cx: 0.3, cy: 0.55, rx: 0.16, ry: 0.27),
          JunoDotRing(cx: 0.5, cy: 0.55, rx: 0.16, ry: 0.27),
          JunoDotRing(cx: 0.7, cy: 0.55, rx: 0.16, ry: 0.27, faint: true),
        ],
        arcs: [JunoDotArc(ring: 0, from: 200, to: 300)],
        pitch: 3
      )
    }
  }
}

enum JunoMobileLibraryMetrics {
  /// The entry tiles' drawing band.
  static let entryArt: CGFloat = JunoSpace.vast + JunoSpace.region
  /// The narrowest a file tile may get before the grid adds no more columns.
  static let tileMinimum: CGFloat = 150

  static func columns(forWidth width: CGFloat) -> [GridItem] {
    let usable = max(width, tileMinimum * 2)
    let count = max(2, min(6, Int((usable + JunoSpace.cozy) / (tileMinimum + JunoSpace.cozy + 30))))
    return Array(repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top), count: count)
  }
}
