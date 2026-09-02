#if DEBUG
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The bytes behind the preview transcript's pictures.
///
/// Drawn at launch rather than bundled: a package resource would need a bundle
/// the harness does not otherwise carry, and a picture that is *generated* can
/// be told apart from a photo by its content alone — the two fixtures below
/// are deliberately different compositions so a reviewer can see which row is
/// which. Both are real PNGs that go through the same decode path a server
/// image does, so a screenshot of the transcript is also evidence the image
/// pipeline works.
public enum PreviewImageFixtures {
    /// The photo the reader attached to their question.
    public static let userPhotoID = "img-user-1"
    /// The picture Juno generated in its answer.
    public static let generatedID = "img-gen-1"

    /// Answers `/api/attachments/<id>` with PNG bytes, or nil for an id this
    /// fixture does not draw.
    public static func png(for id: String) -> Data? {
        switch id {
        case userPhotoID: return cached(id) { draw(width: 1200, height: 800, kind: .photo) }
        case generatedID: return cached(id) { draw(width: 1024, height: 1024, kind: .generated) }
        default: return nil
        }
    }

    private enum Kind { case photo, generated }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var cache: [String: Data] = [:]

    private static func cached(_ id: String, _ make: () -> Data?) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        if let data = cache[id] { return data }
        let data = make()
        cache[id] = data
        return data
    }

    private static func draw(width: Int, height: Int, kind: Kind) -> Data? {
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)

        switch kind {
        case .photo:
            // A warm evening sky over a dark hill line — reads as a snapshot.
            let colors = [
                CGColor(red: 0.98, green: 0.72, blue: 0.48, alpha: 1),
                CGColor(red: 0.85, green: 0.45, blue: 0.42, alpha: 1),
                CGColor(red: 0.35, green: 0.28, blue: 0.48, alpha: 1),
            ] as CFArray
            if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 0.55, 1]) {
                context.drawLinearGradient(
                    gradient, start: CGPoint(x: 0, y: height), end: CGPoint(x: 0, y: 0), options: []
                )
            }
            context.setFillColor(CGColor(red: 1, green: 0.93, blue: 0.75, alpha: 0.95))
            context.fillEllipse(in: CGRect(x: Double(width) * 0.62, y: Double(height) * 0.58, width: Double(width) * 0.11, height: Double(width) * 0.11))
            context.setFillColor(CGColor(red: 0.16, green: 0.14, blue: 0.2, alpha: 1))
            let hill = CGMutablePath()
            hill.move(to: CGPoint(x: 0, y: 0))
            hill.addLine(to: CGPoint(x: 0, y: Double(height) * 0.3))
            hill.addQuadCurve(
                to: CGPoint(x: Double(width) * 0.55, y: Double(height) * 0.22),
                control: CGPoint(x: Double(width) * 0.25, y: Double(height) * 0.42)
            )
            hill.addQuadCurve(
                to: CGPoint(x: Double(width), y: Double(height) * 0.34),
                control: CGPoint(x: Double(width) * 0.8, y: Double(height) * 0.12)
            )
            hill.addLine(to: CGPoint(x: Double(width), y: 0))
            hill.closeSubpath()
            context.addPath(hill)
            context.fillPath()
        case .generated:
            // Concentric rings in the brand's coral on cream — obviously made.
            context.setFillColor(CGColor(red: 0.97, green: 0.95, blue: 0.91, alpha: 1))
            context.fill(rect)
            let centre = CGPoint(x: Double(width) * 0.5, y: Double(height) * 0.5)
            for ring in stride(from: 9, through: 1, by: -1) {
                let radius = Double(width) * 0.045 * Double(ring)
                let shade = 1 - Double(ring) / 12
                context.setFillColor(CGColor(red: 0.93 * shade + 0.05, green: 0.45 * shade + 0.1, blue: 0.36 * shade + 0.1, alpha: 1))
                context.fillEllipse(in: CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
            }
            context.setFillColor(CGColor(red: 0.97, green: 0.95, blue: 0.91, alpha: 1))
            let small = Double(width) * 0.05
            context.fillEllipse(in: CGRect(x: centre.x - small, y: centre.y - small, width: small * 2, height: small * 2))
        }

        guard let image = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
#endif
