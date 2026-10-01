import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(ImageIO)
import ImageIO
#endif
#if canImport(Accelerate)
import Accelerate
#endif
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

/// What one route's model accepts for an image, read from the model manifest
/// (CODE_AGENT_SPEC §3.5).
///
/// Scaling is a correctness rule, not a cost one. Anthropic's computer
/// toolset "takes no display dimensions and the API doesn't downscale for
/// you, so an oversized `tool_result` image is rejected"; OpenAI's `high`
/// detail resizes on the server, after which the model's coordinates are in
/// a frame Juno never saw. Either way, the harness picks the frame.
public struct ImageBudget: Hashable, Codable, Sendable {
    public var maxLongEdge: Int
    /// A cap on the short edge, for providers that resize to one.
    public var maxShortEdge: Int?
    public var maxPixels: Int?
    /// Anthropic's visual-token rule: `⌈w/patch⌉ × ⌈h/patch⌉`.
    public var maxVisualTokens: Int?
    public var patch: Int
    public var coordinates: CoordinateConvention

    public init(
        maxLongEdge: Int,
        maxShortEdge: Int? = nil,
        maxPixels: Int? = nil,
        maxVisualTokens: Int? = nil,
        patch: Int = 28,
        coordinates: CoordinateConvention = .pixels
    ) {
        self.maxLongEdge = max(1, maxLongEdge)
        self.maxShortEdge = maxShortEdge
        self.maxPixels = maxPixels
        self.maxVisualTokens = maxVisualTokens
        self.patch = max(1, patch)
        self.coordinates = coordinates
    }

    /// Claude models before Opus 4.7, the `haiku` alias among them: "up to
    /// 1568 pixels on the long edge and approximately 1.15 megapixels".
    public static let anthropicStandard = ImageBudget(maxLongEdge: 1_568, maxPixels: 1_150_000)

    /// Opus 4.7 and later, every model with `computer_toolset_20260801`: "up
    /// to 2576 pixels on the long edge and 4784 visual tokens total".
    public static let anthropicHighResolution = ImageBudget(maxLongEdge: 2_576, maxVisualTokens: 4_784)

    /// OpenAI Chat Completions at `detail: high`, which fits an image into
    /// 2048×2048 and then its short side into 768 px. Sending an image already
    /// inside that box means the server leaves it alone and the model's
    /// coordinates are in Juno's frame.
    public static let openAIHighDetail = ImageBudget(maxLongEdge: 2_048, maxShortEdge: 768)

    /// OpenAI Responses with `detail: "original"`: kept at the size sent, so
    /// the bound is Juno's, chosen for cost (about 1080p).
    public static let openAIOriginal = ImageBudget(maxLongEdge: 1_920, maxPixels: 2_073_600)
}

/// Picks the frame size for a capture and makes the frame.
public enum CaptureScaler {
    /// `s = min(1, maxLongEdge / longEdge, maxShortEdge / shortEdge,
    /// sqrt(maxPixels / (w·h)))`, then reduced until the visual-token rule
    /// holds for the integer size the frame will actually have.
    public static func scale(pixelWidth width: Int, pixelHeight height: Int, budget: ImageBudget) -> Double {
        guard width > 0, height > 0 else { return 1 }
        let long = Double(max(width, height))
        let short = Double(min(width, height))
        var scale = min(1, Double(budget.maxLongEdge) / long)
        if let maxShort = budget.maxShortEdge {
            scale = min(scale, Double(maxShort) / short)
        }
        if let maxPixels = budget.maxPixels {
            scale = min(scale, (Double(maxPixels) / (Double(width) * Double(height))).squareRoot())
        }
        if let maxTokens = budget.maxVisualTokens {
            // Converges in a few steps: each pass shrinks by the square root
            // of the overshoot, then a hair more so rounding cannot stall it.
            for _ in 0..<64 {
                let size = scaledSize(pixelWidth: width, pixelHeight: height, scale: scale)
                let tokens = visualTokens(size, patch: budget.patch)
                if tokens <= maxTokens { break }
                scale *= (Double(maxTokens) / Double(tokens)).squareRoot() * 0.999
            }
        }
        return max(scale, 1 / long)
    }

    /// The integer frame a scale gives. Rounded down, so neither edge can go
    /// past the budget that chose the scale; never below one pixel.
    public static func scaledSize(pixelWidth width: Int, pixelHeight height: Int, scale: Double) -> PixelSize {
        PixelSize(
            width: max(1, Int((Double(width) * scale).rounded(.down))),
            height: max(1, Int((Double(height) * scale).rounded(.down)))
        )
    }

    public static func visualTokens(_ size: PixelSize, patch: Int = 28) -> Int {
        let columns = (size.width + patch - 1) / patch
        let rows = (size.height + patch - 1) / patch
        return columns * rows
    }

    /// Whether a frame fits a budget, for tests and for the zoom's own check.
    public static func fits(_ size: PixelSize, _ budget: ImageBudget) -> Bool {
        if size.longEdge > budget.maxLongEdge { return false }
        if let maxShort = budget.maxShortEdge, size.shortEdge > maxShort { return false }
        if let maxPixels = budget.maxPixels, size.pixelCount > maxPixels { return false }
        if let maxTokens = budget.maxVisualTokens, visualTokens(size, patch: budget.patch) > maxTokens {
            return false
        }
        return true
    }
}

/// An encoded frame, ready for a tool result.
public struct EncodedFrame: Hashable, Sendable {
    public var data: Data
    public var mediaType: String
    public var size: PixelSize

    public init(data: Data, mediaType: String, size: PixelSize) {
        self.data = data
        self.mediaType = mediaType
        self.size = size
    }
}

#if canImport(CoreGraphics) && canImport(ImageIO)

extension CaptureScaler {
    /// Resamples `image` to `size` with a high-quality filter: vImage's
    /// Lanczos where Accelerate exists, CoreGraphics' high interpolation
    /// otherwise. Returns the image unchanged when it is already that size.
    public static func resample(_ image: CGImage, to size: PixelSize) -> CGImage? {
        if image.width == size.width, image.height == size.height { return image }
        #if canImport(Accelerate)
        if let scaled = lanczos(image, to: size) { return scaled }
        #endif
        return redraw(image, to: size)
    }

    /// The frame for `image` under `budget`: the scale, the resampled image.
    public static func frame(of image: CGImage, budget: ImageBudget) -> (image: CGImage, scale: Double)? {
        let scale = scale(pixelWidth: image.width, pixelHeight: image.height, budget: budget)
        let size = scaledSize(pixelWidth: image.width, pixelHeight: image.height, scale: scale)
        guard let scaled = resample(image, to: size) else { return nil }
        // The scale the frame really has, from its integer size, so the
        // map-back uses the same ratio the pixels were drawn at.
        return (scaled, Double(size.width) / Double(image.width))
    }

    /// PNG for text-heavy frames, where JPEG blurs the glyphs the model has
    /// to read; JPEG at 0.85 otherwise (CODE_AGENT_SPEC §3.5).
    public static func encode(_ image: CGImage, preferPNG: Bool? = nil) -> EncodedFrame? {
        let png = preferPNG ?? isTextHeavy(image)
        let type = png ? "public.png" : "public.jpeg"
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else {
            return nil
        }
        let options: [CFString: Any] = png ? [:] : [kCGImageDestinationLossyCompressionQuality: 0.85]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return EncodedFrame(
            data: data as Data,
            mediaType: png ? "image/png" : "image/jpeg",
            size: PixelSize(width: image.width, height: image.height)
        )
    }

    /// A frame is "text-heavy" when most of it is flat and nearly colourless:
    /// documents, code, terminals, settings panes. Photos and gradients are
    /// not. Sampled on a 48×48 grid, so it costs nothing next to the encode.
    public static func isTextHeavy(_ image: CGImage) -> Bool {
        guard let pixels = RGBAPixels(image, maxDimension: 48) else { return false }
        var flat = 0
        var total = 0
        for y in 0..<pixels.height {
            for x in 0..<pixels.width {
                let (r, g, b) = pixels.rgb(x, y)
                let maxChannel = max(r, max(g, b))
                let minChannel = min(r, min(g, b))
                if maxChannel - minChannel < 24 { flat += 1 }
                total += 1
            }
        }
        return total > 0 && Double(flat) / Double(total) > 0.7
    }

    #if canImport(Accelerate)
    private static func lanczos(_ image: CGImage, to size: PixelSize) -> CGImage? {
        guard let format = vImage_CGImageFormat(
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)
                .union(.byteOrder32Little)
        ) else { return nil }
        guard var source = try? vImage_Buffer(cgImage: image, format: format) else { return nil }
        defer { source.free() }
        guard var destination = try? vImage_Buffer(
            width: size.width,
            height: size.height,
            bitsPerPixel: format.bitsPerPixel
        ) else { return nil }
        defer { destination.free() }
        let error = vImageScale_ARGB8888(&source, &destination, nil, vImage_Flags(kvImageHighQualityResampling))
        guard error == kvImageNoError else { return nil }
        return try? destination.createCGImage(format: format)
    }
    #endif

    private static func redraw(_ image: CGImage, to size: PixelSize) -> CGImage? {
        guard let context = CGContext(
            data: nil,
            width: size.width,
            height: size.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return context.makeImage()
    }
}

/// An image's pixels as plain RGBA bytes, top row first, for the small
/// amount of image analysis screen control does: the text-heavy guess, frame
/// comparison and the calibration test's target finder.
public struct RGBAPixels: Sendable {
    public let width: Int
    public let height: Int
    public let bytes: [UInt8]

    /// Draws `image` into an sRGB buffer, shrunk so its long edge is at most
    /// `maxDimension` when one is given.
    public init?(_ image: CGImage, maxDimension: Int? = nil) {
        var width = image.width
        var height = image.height
        if let maxDimension, max(width, height) > maxDimension {
            let ratio = Double(maxDimension) / Double(max(width, height))
            width = max(1, Int(Double(width) * ratio))
            height = max(1, Int(Double(height) * ratio))
        }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            // CoreGraphics draws with y up; the buffer's first row is the
            // image's top row either way, because CGContext memory is laid
            // out top row first.
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        self.width = width
        self.height = height
        self.bytes = bytes
    }

    public func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let index = (y * width + x) * 4
        return (Int(bytes[index]), Int(bytes[index + 1]), Int(bytes[index + 2]))
    }

    public func luminance(_ x: Int, _ y: Int) -> Double {
        let (r, g, b) = rgb(x, y)
        return 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
    }
}

/// Whether the screen still shows what a frame showed, around one point.
///
/// An approval is bound to the frame the reader looked at (CODE_AGENT_SPEC
/// §3.3): if the target moved, a dialog opened over it, or the window
/// scrolled while the card waited, the action is refused with "the screen
/// changed" rather than delivered to whatever is there now. A byte-for-byte
/// hash would refuse every time a caret blinks or a clock ticks, so this
/// compares the neighbourhood of the target on a coarse luminance grid.
public enum FrameComparison {
    /// Mean absolute luminance difference, 0…255, of the square `radius`
    /// frame pixels around `center` in the two images. Both are first drawn
    /// at the same size, so frames of different scale compare too.
    public static func difference(
        _ first: CGImage,
        _ second: CGImage,
        around center: (x: Double, y: Double)? = nil,
        radius: Double = 40,
        frameSize: PixelSize
    ) -> Double {
        let crop: CGRect
        if let center {
            crop = CGRect(
                x: max(0, center.x - radius),
                y: max(0, center.y - radius),
                width: radius * 2,
                height: radius * 2
            ).intersection(CGRect(x: 0, y: 0, width: frameSize.width, height: frameSize.height))
        } else {
            crop = CGRect(x: 0, y: 0, width: frameSize.width, height: frameSize.height)
        }
        guard !crop.isEmpty,
              let a = Self.crop(first, to: crop, frameSize: frameSize),
              let b = Self.crop(second, to: crop, frameSize: frameSize),
              let pa = RGBAPixels(a, maxDimension: 24),
              let pb = RGBAPixels(b, maxDimension: 24),
              pa.width == pb.width, pa.height == pb.height
        else { return 255 }
        var total = 0.0
        for y in 0..<pa.height {
            for x in 0..<pa.width {
                total += abs(pa.luminance(x, y) - pb.luminance(x, y))
            }
        }
        return total / Double(pa.width * pa.height)
    }

    /// Above this, the neighbourhood counts as changed. A caret, a hover
    /// tint or anti-aliasing stays well under it; a new dialog does not.
    public static let changedThreshold = 14.0

    private static func crop(_ image: CGImage, to rect: CGRect, frameSize: PixelSize) -> CGImage? {
        // The image may be at a different scale from the frame; crop in its
        // own pixels.
        let sx = Double(image.width) / Double(max(frameSize.width, 1))
        let sy = Double(image.height) / Double(max(frameSize.height, 1))
        let scaled = CGRect(x: rect.minX * sx, y: rect.minY * sy, width: rect.width * sx, height: rect.height * sy)
            .integral
        return image.cropping(to: scaled)
    }
}

#endif
