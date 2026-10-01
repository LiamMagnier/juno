import Foundation

/// A point in global screen space: CoreGraphics' display coordinates, in
/// points, with the origin at the top-left of the main display and y growing
/// down. A secondary display to the left of or above the main one has
/// negative coordinates, and that has to keep working.
public struct ScreenPoint: Hashable, Codable, Sendable, CustomStringConvertible {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public func distance(to other: ScreenPoint) -> Double {
        ((x - other.x) * (x - other.x) + (y - other.y) * (y - other.y)).squareRoot()
    }

    public var description: String { "(\(Self.format(x)), \(Self.format(y)))" }

    static func format(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}

/// A rectangle in global screen space, in points (see ``ScreenPoint``).
public struct ScreenRect: Hashable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
    public var center: ScreenPoint { ScreenPoint(x: x + width / 2, y: y + height / 2) }
    public var isEmpty: Bool { width <= 0 || height <= 0 }

    /// Half-open on the far edges, like `CGRect.contains`.
    public func contains(_ point: ScreenPoint) -> Bool {
        point.x >= minX && point.x < maxX && point.y >= minY && point.y < maxY
    }

    public func intersects(_ other: ScreenRect) -> Bool {
        minX < other.maxX && other.minX < maxX && minY < other.maxY && other.minY < maxY
    }
}

/// A size in whole pixels: what the model sees.
public struct PixelSize: Hashable, Codable, Sendable, CustomStringConvertible {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public var description: String { "\(width)×\(height)" }
    public var longEdge: Int { max(width, height) }
    public var shortEdge: Int { min(width, height) }
    public var pixelCount: Int { width * height }
}

/// How a model writes coordinates back.
public enum CoordinateConvention: String, Hashable, Codable, Sendable {
    /// Pixels of the frame it was sent. Anthropic and OpenAI.
    case pixels
    /// 0…999 on each axis, whatever the frame's size. Some other labs; none
    /// is enabled until its convention is verified (CODE_AGENT_SPEC §3.4).
    case normalized1000
}

/// Where one frame came from and how its pixels map back to the screen.
///
/// The whole map-back is one formula (CODE_AGENT_SPEC §3.5):
///
///     pointX = originX + (x / scale) / backingScale
///
/// `x` is in the frame the model saw, `scale` is what the harness shrank the
/// capture by, `backingScale` is device pixels per point (2 on Retina), and
/// `origin` is the captured window's or display's top-left in global points.
/// With the origin global, a window on a display at a negative origin maps as
/// well as one on the main display — the audit's CU-18 was the bounds check
/// running against the main display only.
public struct FrameGeometry: Hashable, Codable, Sendable {
    /// Global top-left of the captured area, in points.
    public var origin: ScreenPoint
    /// The captured area's size in points.
    public var pointWidth: Double
    public var pointHeight: Double
    /// Device pixels per point of the source.
    public var backingScale: Double
    /// What the device-pixel capture was multiplied by to make the frame. ≤ 1.
    public var scale: Double
    /// The frame the model sees, in pixels.
    public var frameSize: PixelSize
    /// The display the area is on.
    public var displayID: UInt32
    public var coordinates: CoordinateConvention

    public init(
        origin: ScreenPoint,
        pointWidth: Double,
        pointHeight: Double,
        backingScale: Double,
        scale: Double,
        frameSize: PixelSize,
        displayID: UInt32 = 0,
        coordinates: CoordinateConvention = .pixels
    ) {
        self.origin = origin
        self.pointWidth = pointWidth
        self.pointHeight = pointHeight
        self.backingScale = max(backingScale, 0.0001)
        self.scale = max(scale, 0.0001)
        self.frameSize = frameSize
        self.displayID = displayID
        self.coordinates = coordinates
    }

    /// The captured area in global points.
    public var globalBounds: ScreenRect {
        ScreenRect(x: origin.x, y: origin.y, width: pointWidth, height: pointHeight)
    }

    /// Device pixels of the source, before scaling.
    public var sourcePixelSize: PixelSize {
        PixelSize(
            width: Int((pointWidth * backingScale).rounded()),
            height: Int((pointHeight * backingScale).rounded())
        )
    }

    /// A model coordinate in frame pixels, whatever convention it came in.
    public func framePixels(x: Double, y: Double) -> (x: Double, y: Double) {
        switch coordinates {
        case .pixels:
            return (x, y)
        case .normalized1000:
            return (x / 1_000 * Double(frameSize.width), y / 1_000 * Double(frameSize.height))
        }
    }

    /// Where a model coordinate lands on the screen.
    public func globalPoint(frameX: Double, frameY: Double) -> ScreenPoint {
        let (x, y) = framePixels(x: frameX, y: frameY)
        return ScreenPoint(
            x: origin.x + (x / scale) / backingScale,
            y: origin.y + (y / scale) / backingScale
        )
    }

    /// The frame pixel a global point is drawn at — the inverse of
    /// ``globalPoint(frameX:frameY:)``, in pixels whatever the convention.
    public func framePoint(global point: ScreenPoint) -> (x: Double, y: Double) {
        (
            (point.x - origin.x) * backingScale * scale,
            (point.y - origin.y) * backingScale * scale
        )
    }

    /// Whether a model coordinate is inside the frame it was given.
    public func containsFramePoint(x: Double, y: Double) -> Bool {
        let (px, py) = framePixels(x: x, y: y)
        return px >= 0 && py >= 0 && px < Double(frameSize.width) && py < Double(frameSize.height)
    }

    /// A region of the frame `[x0, y0, x1, y1]` as device pixels of the
    /// source, for a zoom that crops at native resolution. Clamped to the
    /// source; nil when nothing of it is inside.
    public func sourcePixelRect(frameRegion region: [Double]) -> (x: Int, y: Int, width: Int, height: Int)? {
        guard region.count == 4 else { return nil }
        let (ax, ay) = framePixels(x: region[0], y: region[1])
        let (bx, by) = framePixels(x: region[2], y: region[3])
        let toSource = 1 / scale
        let source = sourcePixelSize
        let minX = max(0, Int((min(ax, bx) * toSource).rounded(.down)))
        let minY = max(0, Int((min(ay, by) * toSource).rounded(.down)))
        let maxX = min(source.width, Int((max(ax, bx) * toSource).rounded(.up)))
        let maxY = min(source.height, Int((max(ay, by) * toSource).rounded(.up)))
        guard maxX > minX, maxY > minY else { return nil }
        return (minX, minY, maxX - minX, maxY - minY)
    }

    /// The line every frame result starts with, so the model always knows
    /// which frame its next coordinates are in.
    public func header(app: String?, window: String?) -> String {
        var parts = [
            "frame \(frameSize)",
            "scale \(String(format: "%.3f", scale))",
            "display \(displayID)",
        ]
        if coordinates == .normalized1000 { parts.append("coordinates 0-999") }
        if let app { parts.append("app \(app)") }
        if let window, !window.isEmpty { parts.append("window \"\(window)\"") }
        return parts.joined(separator: " · ")
    }
}
