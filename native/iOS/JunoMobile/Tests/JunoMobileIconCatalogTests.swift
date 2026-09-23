import JunoDesignSystem
import SwiftUI
import UIKit
import XCTest

/// The icon set as the phone loads it: compiled into the app's catalog, found
/// by name, and drawn. The package's `JunoBrandTests` can only read the
/// catalogs on disk; a symbol template the compiler dislikes ships as nothing,
/// and `Image(_:)` draws empty space with no error.
@MainActor
final class JunoMobileIconCatalogTests: XCTestCase {
    /// Every cut of every case is in the bundle, as a symbol, and draws ink.
    func testEveryIconCutLoadsFromTheAppBundleAndDraws() {
        var names: Set<String> = []
        for icon in JunoIcon.allCases {
            names.insert(icon.assetName(.regular))
            names.insert(icon.assetName(.bold))
            if icon.hasFill { names.insert(icon.assetName(.fill)) }
        }
        let configuration = UIImage.SymbolConfiguration(pointSize: 28)
        for name in names.sorted() {
            guard let image = UIImage(named: name, in: .main, with: configuration) else {
                XCTFail("\(name) is not in the app bundle")
                continue
            }
            XCTAssertTrue(image.isSymbolImage, "\(name) should be a symbol")
            XCTAssertNotNil(Self.inkBounds(of: Self.flatten(image)), "\(name) draws nothing")
        }
    }

    /// `JunoIconView(size:)` sets the 256 grid to `size`, as the web's `size`
    /// prop does: a 16pt plus is 12pt of ink, centred in the box.
    func testIconViewSetsTheGridToItsSize() throws {
        let renderer = ImageRenderer(content: JunoIconView(.plus, size: 16).foregroundStyle(.black))
        renderer.scale = 4
        let image = try XCTUnwrap(renderer.uiImage)
        let ink = try XCTUnwrap(Self.inkBounds(of: image))
        XCTAssertEqual(ink.width, 12, accuracy: 1)
        XCTAssertEqual(ink.height, 12, accuracy: 1)
        XCTAssertEqual(ink.midX, 8, accuracy: 0.75)
        XCTAssertEqual(ink.midY, 8, accuracy: 0.75)
    }

    // MARK: - Helpers

    private static func flatten(_ image: UIImage) -> UIImage {
        UIGraphicsImageRenderer(size: image.size).image { _ in
            image.withTintColor(.black, renderingMode: .alwaysOriginal).draw(at: .zero)
        }
    }

    /// The bounds of the drawn pixels, in points, or nil when nothing is drawn.
    private static func inkBounds(of image: UIImage) -> CGRect? {
        guard let cgImage = image.cgImage else { return nil }
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0,
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where data[(y * width + x) * 4 + 3] > 127 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return nil }
        let scale = image.scale
        return CGRect(
            x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
            width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale
        )
    }
}
