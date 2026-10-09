import AppKit
import JunoDesignSystem
import SwiftUI
import Testing

/// The icon set as the app actually loads it: compiled by actool into the
/// bundle, found by name, and drawn.
///
/// The package's `JunoBrandTests` can only read the catalogs on disk; this is
/// the check that the templates `scripts/generate-native-icons.mjs` writes are
/// ones the asset compiler accepts and the renderer draws. A symbol template
/// the compiler dislikes does not fail the build — it ships as nothing, and
/// `Image(_:)` draws empty space with no error.
@MainActor
struct DesktopIconCatalogTests {
    /// Every cut of every case: present, a template, and not empty.
    @Test
    func everyIconCutLoadsFromTheAppBundleAndDraws() {
        var names: Set<String> = []
        for icon in JunoIcon.allCases {
            names.insert(icon.assetName(.regular))
            names.insert(icon.assetName(.bold))
            if icon.hasFill { names.insert(icon.assetName(.fill)) }
        }
        for name in names.sorted() {
            guard let image = Self.symbol(name, pointSize: 32) else {
                Issue.record("\(name) is not in the app bundle")
                continue
            }
            #expect(image.isTemplate, "\(name) must draw in the foreground colour")
            #expect(image.size.width > 0 && image.size.height > 0, "\(name) has no size")
            #expect(Self.inkBounds(of: image) != nil, "\(name) draws nothing")
        }
    }

    /// The other direction (spec §A4.3): every symbol the Mac's catalog ships
    /// is worn by a `JunoIcon` case, and made it into the bundle.
    ///
    /// A symbol no case wears is weight the generator should not be emitting;
    /// one missing from the bundle is a template actool dropped without
    /// failing the build. `JunoBrandTests` makes the same case ↔ asset check
    /// against both catalogs on disk; this is the Mac's, against what ships.
    @Test
    func everyShippedSymbolHasACaseAndIsInTheBundle() throws {
        let catalog = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // → Tests
            .deletingLastPathComponent() // → JunoDesktop
            .appendingPathComponent("Resources/Icons.xcassets")
        let entries = try FileManager.default.contentsOfDirectory(atPath: catalog.path)
        let shipped = Set(
            entries.filter { $0.hasSuffix(".symbolset") }.map { String($0.dropLast(".symbolset".count)) }
        )
        #expect(shipped.count > 100, "Icons.xcassets was not read: \(catalog.path)")

        var worn: Set<String> = []
        for icon in JunoIcon.allCases {
            worn.insert(icon.assetName(.regular))
            worn.insert(icon.assetName(.bold))
            if icon.hasFill { worn.insert(icon.assetName(.fill)) }
        }
        #expect(shipped.subtracting(worn).sorted() == [], "symbols no JunoIcon case wears")
        #expect(worn.subtracting(shipped).sorted() == [], "JunoIcon cuts with no symbol in the catalog")
        for name in shipped.sorted() where NSImage(named: name) == nil {
            Issue.record("\(name) is in Icons.xcassets but not in the app bundle")
        }
    }

    /// The fixture: the Alevr family's `Plus` at 100pt. The box is 16/14 of the point
    /// size (114.3pt) and is the symbol's whole advance; the plus spans 178 of
    /// the grid's 256 units (39 to 217), so its ink is about 70% of the box.
    /// If the template's metrics drift, every glyph in the app changes size
    /// with it, and this is where that shows.
    @Test
    func symbolsAreSetOnTheWebsGridAtSixteenFourteenthsOfThePointSize() throws {
        let image = try #require(Self.symbol("ph.plus", pointSize: 100))
        #expect(abs(image.size.width - 100 * 16 / 14) <= 1, "advance is \(image.size.width)")
        let ink = try #require(Self.inkBounds(of: image))
        let expected = 100.0 * 16 / 14 * 178 / 256
        #expect(abs(ink.width - expected) <= 2, "ink is \(ink.width), expected \(expected)")
        #expect(abs(ink.height - expected) <= 2, "ink is \(ink.height), expected \(expected)")
    }

    /// `JunoIconView(size:)` maps the 256 grid onto `size`, as the web's `size`
    /// prop does: a 16pt plus is 11pt of ink (178 of 256), centred in the box.
    @Test
    func iconViewSetsTheGridToItsSize() throws {
        let renderer = ImageRenderer(content: JunoIconView(.plus, size: 16).foregroundStyle(.black))
        renderer.scale = 4
        let cgImage = try #require(renderer.cgImage)
        let image = NSImage(cgImage: cgImage, size: NSSize(width: 16, height: 16))
        let ink = try #require(Self.inkBounds(of: image))
        #expect(abs(ink.width - 16 * 178 / 256) <= 1, "ink is \(ink.width)pt wide")
        #expect(abs(ink.height - 16 * 178 / 256) <= 1, "ink is \(ink.height)pt tall")
        #expect(abs(ink.midX - 8) <= 0.75, "ink is centred at x \(ink.midX)")
        #expect(abs(ink.midY - 8) <= 0.75, "ink is centred at y \(ink.midY)")
    }

    // MARK: - Helpers

    private static func symbol(_ name: String, pointSize: CGFloat) -> NSImage? {
        guard let image = NSImage(named: name) else { return nil }
        return image.withSymbolConfiguration(.init(pointSize: pointSize, weight: .regular)) ?? image
    }

    /// The bounds of the drawn pixels, in points, or nil when nothing is drawn.
    private static func inkBounds(of image: NSImage) -> CGRect? {
        let scale: CGFloat = 2
        let width = Int((image.size.width * scale).rounded(.up))
        let height = Int((image.size.height * scale).rounded(.up))
        guard width > 0, height > 0,
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        let graphics = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        image.draw(in: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        NSGraphicsContext.restoreGraphicsState()
        guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where data[(y * width + x) * 4 + 3] > 127 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return nil }
        return CGRect(
            x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
            width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale
        )
    }
}
