import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI
import UIKit

// Projects as the website and the Mac draw them: a tile with a cover — the
// project's own picture (its `__cover__` file), or its dot-matrix orbit
// drawing — over the serif name and one line of counts.
//
// The drawing is the web's `ProjectCover` (src/components/projects/
// project-cover.tsx), ported from the Mac's `DesktopCoverDrawing` with the same
// seed, the same three arrangements and the same numbers, so a project wears
// the same drawing on the phone, the Mac and the website. It is a pure function
// of the project's id: nothing is stored, nothing is fetched.
//
// The phone's tile is the Mac's *compact* tile (the one it uses for folders),
// promoted to the Projects grid: two columns on a phone is not room for the
// Mac's instructions excerpt, and the cover is what tells two projects apart at
// a glance.

// MARK: - Summary

/// One project as a tile counts it: its chats, its files (the cover left out),
/// its folders, and the cover file when it has one.
@MainActor
struct JunoMobileProjectSummary {
  /// The project's picture is its file named `__cover__`
  /// (`src/app/api/projects/route.ts`). Never a source, never counted.
  static let coverFileName = "__cover__"

  let project: NativeProject
  let chats: Int
  let files: [NativeProjectFile]
  let folders: Int
  let cover: NativeProjectFile?

  init(_ project: NativeProject, model: NativeProjectModel<SQLiteAccountRepository>) {
    self.project = project
    chats = model.conversationsByProject[project.id]?.count ?? 0
    let all = model.filesByProject[project.id] ?? []
    files = all.filter { $0.fileName != Self.coverFileName }
    cover = all.first { $0.fileName == Self.coverFileName }
    folders = model.children(of: project.id).count
  }

  /// "3 chats · 2 files · 1 folder" — folders only when there are some.
  var countsLine: String {
    var parts = [
      JunoMobileProjectFolderLine.plural(chats, "chat"),
      JunoMobileProjectFolderLine.plural(files.count, "file"),
    ]
    if folders > 0 { parts.append(JunoMobileProjectFolderLine.plural(folders, "folder")) }
    return parts.joined(separator: " · ")
  }
}

// MARK: - Tile

/// A project or a folder as a tile: the cover, then the serif name and the
/// counts. The whole tile is the link, so it carries no controls of its own —
/// pin, rename, move and delete live in its context menu, as on the web's
/// touch layout.
struct JunoMobileProjectTile: View {
  let summary: JunoMobileProjectSummary
  /// The folder tile on a project page is shorter: it sits above the chats and
  /// should not push them off the screen.
  var compact = false
  /// Fetches the cover's bytes; nil draws the orbit drawing alone.
  var loadCover: ((String) async -> NativeProjectFileAccess?)?

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var coverHeight: CGFloat { compact ? JunoMobileProjectTileMetrics.compactCover : JunoMobileProjectTileMetrics.cover }

  var body: some View {
    let inner = RoundedRectangle(cornerRadius: JunoRadius.card - JunoSpace.hairline, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      ZStack(alignment: .topTrailing) {
        JunoMobileProjectCover(
          seed: summary.project.id,
          folders: summary.folders,
          coverID: summary.cover?.id,
          load: loadCover
        )
        .frame(maxWidth: .infinity)
        .frame(height: coverHeight)
        .clipShape(inner)
        if summary.project.starred {
          JunoIconView(.pin, size: 13, isOn: true)
            .foregroundStyle(Color.junoForeground.opacity(0.8))
            .padding(JunoSpace.snug)
            .accessibilityHidden(true)
        }
      }
      VStack(alignment: .leading, spacing: JunoSpace.hairline) {
        Text(summary.project.name)
          .font(JunoSerif.font(size: compact ? 16 : 18, relativeTo: .headline, face: .medium))
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(summary.countsLine)
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
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 1)
    )
    .contentShape(.rect(cornerRadius: JunoRadius.card))
    .opacity(summary.project.isPending ? 0.6 : 1)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "\(summary.project.name), \(summary.project.starred ? "Pinned · " : "")\(summary.countsLine)"
    )
    .accessibilityAddTraits(.isButton)
  }
}

enum JunoMobileProjectTileMetrics {
  /// The Projects grid's cover: tall enough for the drawing's rings to read
  /// as orbits at two columns.
  static let cover: CGFloat = JunoSpace.vast * 2 + JunoSpace.cozy
  /// A folder's cover on a project page: the Mac's 84.
  static let compactCover: CGFloat = JunoSpace.vast + JunoSpace.expanse - JunoSpace.hairline

  /// Two columns on a phone, more as the column widens — the web's `@[30rem]`
  /// and `@[48rem]` steps, measured on the content column.
  static func columns(forWidth width: CGFloat) -> [GridItem] {
    let count: Int
    switch width {
    case ..<560: count = 2
    case ..<820: count = 3
    case ..<1_100: count = 4
    default: count = 5
    }
    return Array(repeating: GridItem(.flexible(), spacing: JunoSpace.cozy, alignment: .top), count: count)
  }
}

// MARK: - Cover

/// The project's picture when it has one, with its drawing under it until (and
/// unless) the picture loads.
struct JunoMobileProjectCover: View {
  let seed: String
  var folders: Int = 0
  var coverID: String?
  var load: ((String) async -> NativeProjectFileAccess?)?

  @State private var image: UIImage?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      JunoMobileProjectCoverArt(seed: seed, folders: folders)
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .transition(.opacity)
      }
    }
    .accessibilityHidden(true)
    .task(id: coverID) {
      guard let coverID, let load else {
        image = nil
        return
      }
      let picture = await Self.picture(from: await load(coverID))
      withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { image = picture }
    }
  }

  private static func picture(from access: NativeProjectFileAccess?) async -> UIImage? {
    switch access {
    case .downloaded(let data):
      return UIImage(data: data)
    case .remote(let url):
      guard let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
      return UIImage(data: data)
    case nil:
      return nil
    }
  }
}

/// A project's cover drawing, after the web's `ProjectCover`: nested orbits at
/// the 1.5 ratio laid on the dot matrix, in one of three arrangements
/// (concentric, tangent like a shell, or drawn from a corner and cropped), with
/// one dotted spoke per folder. Monochrome ink on the inset fill.
struct JunoMobileProjectCoverArt: View {
  let seed: String
  var folders: Int = 0

  var body: some View {
    let drawing = JunoMobileCoverDrawing(seed: seed, folders: folders)
    Canvas { context, size in
      drawing.draw(in: &context, size: size)
    }
    .background(Color.junoSecondary)
    .accessibilityHidden(true)
  }
}

/// The drawing behind ``JunoMobileProjectCoverArt``: seeded, so pure. The
/// same numbers as the Mac's `DesktopCoverDrawing` and the web's.
struct JunoMobileCoverDrawing {
  struct Ring { var cx: CGFloat; var cy: CGFloat; var r: CGFloat }

  let rings: [Ring]
  let spokes: [CGFloat]

  init(seed: String, folders: Int) {
    var generator = JunoMobileSeededRandom(seed: seed)
    let mode = Int(generator.next() * 3)
    let count = 3 + Int(generator.next() * 2)
    let outer: CGFloat = mode == 2 ? generator.pick(0.46, 0.56) : generator.pick(0.3, 0.36)
    let cx: CGFloat = mode == 2
      ? (generator.next() < 0.5 ? generator.pick(0.18, 0.26) : generator.pick(0.74, 0.82))
      : generator.pick(0.4, 0.6)
    let cy: CGFloat = mode == 2 ? generator.pick(0.6, 0.72) : 0.5
    var rings: [Ring] = []
    var r = outer
    for index in 0..<count {
      // Concentric shares a centre; tangent rolls each ring to touch the
      // outer one's edge, like a shell.
      let shift: CGFloat = mode == 1 ? (outer - r) : 0
      rings.append(Ring(cx: cx + shift * (index.isMultiple(of: 2) ? 1 : 0.6), cy: cy, r: r))
      r /= 1.5
    }
    self.rings = rings
    let start = generator.pick(0, .pi * 2)
    spokes = (0..<min(folders, 6)).map { start + CGFloat($0) * (.pi * 2 / CGFloat(max(folders, 1))) }
  }

  func draw(in context: inout GraphicsContext, size: CGSize) {
    let unit = size.height
    let pitch: CGFloat = 5
    let ink = Color.junoForeground
    // The matrix: every dot faint, the dots on an orbit firm.
    var y = pitch / 2
    while y < size.height {
      var x = pitch / 2
      while x < size.width {
        var strength: CGFloat = 0.07
        for ring in rings {
          let dx = x - ring.cx * size.width
          let dy = y - ring.cy * unit
          let distance = abs((dx * dx + dy * dy).squareRoot() - ring.r * unit)
          // Half a pitch either side of the orbit: every column the circle
          // crosses lights one dot, so it reads as an unbroken dotted line.
          if distance <= pitch / 2 { strength = max(strength, 0.5); break }
          if distance <= pitch { strength = max(strength, 0.16) }
        }
        let dot = CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)
        context.fill(Path(ellipseIn: dot), with: .color(ink.opacity(strength)))
        x += pitch
      }
      y += pitch
    }
    // One spoke per folder, from the inner ring out past the outer one.
    guard let outer = rings.first, let inner = rings.last else { return }
    let center = CGPoint(x: outer.cx * size.width, y: outer.cy * unit)
    for angle in spokes {
      var path = Path()
      path.move(to: CGPoint(x: center.x + cos(angle) * inner.r * unit, y: center.y + sin(angle) * inner.r * unit))
      path.addLine(to: CGPoint(
        x: center.x + cos(angle) * outer.r * unit * 1.15,
        y: center.y + sin(angle) * outer.r * unit * 1.15
      ))
      context.stroke(
        path,
        with: .color(ink.opacity(0.35)),
        style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [1.5, 3])
      )
    }
  }
}

/// FNV-1a over the id, then mulberry32: the web's `hash` and `seeded`.
struct JunoMobileSeededRandom {
  private var state: UInt32

  init(seed: String) {
    var h: UInt32 = 2_166_136_261
    for unit in seed.utf16 {
      h ^= UInt32(unit)
      h = h &* 16_777_619
    }
    state = h
  }

  mutating func next() -> CGFloat {
    state = state &+ 0x6D2B_79F5
    var t = state
    t = (t ^ (t >> 15)) &* (1 | t)
    t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
    return CGFloat(t ^ (t >> 14)) / 4_294_967_296
  }

  mutating func pick(_ low: CGFloat, _ high: CGFloat) -> CGFloat {
    low + (high - low) * next()
  }
}
