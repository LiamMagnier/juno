import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Geometry

/// A rectangle in screen points, top-left origin.
///
/// Declared here rather than borrowed from `CGRect` so the containment rules
/// stay free of a graphics framework and can be tested, compared and encoded on
/// a phone. The conversion to `CGRect` happens in exactly one place — the
/// redactor below — where the coordinate flip is visible.
public struct AutomationRect: Hashable, Codable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public func contains(_ point: AutomationPoint) -> Bool {
        point.x >= x && point.y >= y && point.x <= x + width && point.y <= y + height
    }
}

public struct AutomationPoint: Hashable, Codable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

// MARK: - The image that survived the policy

/// A screen capture that has already been redacted.
///
/// The initializer is `fileprivate` and ``ScreenshotPolicy/capture(raw:surfaces:baseSensitivity:redactor:runID:at:)``
/// is the only thing in the file that calls it, so the sole way to hold one is
/// to have gone through the redaction pass. That is the structural half of
/// "redaction happens before storage and before relay": storing and relaying
/// take this type, and there is no way to make one out of a raw capture.
///
/// The alternative — a `redact()` method callable at any point — is the design
/// this exists to prevent. A redaction pass over an image that has already been
/// written to disk and pushed to a phone has redacted nothing; both copies are
/// still the copy with the password in it.
public struct RedactedScreenshot: Hashable, Sendable {
    public let bytes: Data
    /// The classification of what was on screen, after every detected surface
    /// has raised it. Decides whether this may leave the Mac at all.
    public let sensitivity: AutomationSensitivity
    public let redactedRegionCount: Int
    public let capturedAt: Date
    /// When this must be gone. Retention is a property of the image rather than
    /// of whatever happens to be holding it, so a copy that outlives its owner
    /// still knows it has expired.
    public let expiresAt: Date

    fileprivate init(
        bytes: Data,
        sensitivity: AutomationSensitivity,
        redactedRegionCount: Int,
        capturedAt: Date,
        expiresAt: Date
    ) {
        self.bytes = bytes
        self.sensitivity = sensitivity
        self.redactedRegionCount = redactedRegionCount
        self.capturedAt = capturedAt
        self.expiresAt = expiresAt
    }

    public func isExpired(at date: Date) -> Bool { date >= expiresAt }
}

// MARK: - The redaction seam

public enum ScreenRedactionError: Error, Equatable, Sendable {
    case undecodableImage
    case couldNotDraw
    case couldNotEncode
}

/// Paints opaque rectangles over an encoded image and hands back the encoded
/// result.
///
/// A seam rather than a free function because the only honest test of "the
/// stored bytes are the redacted bytes" is one that can see which regions were
/// asked for, and because a capture pipeline on a Mac with no window server
/// still has to be able to run the policy.
public protocol ScreenRedacting: Sendable {
    func blanking(_ image: Data, regions: [AutomationRect]) throws -> Data
}

/// The real redactor: decode, draw, paint, re-encode.
///
/// Uses ImageIO and CoreGraphics, both of which exist on macOS and iOS, so the
/// redaction pass is the same code wherever an image is handled. There is no
/// availability guard because there is no platform-specific call — the capture
/// that produces the input needs one, and that seam is in ``VisualControl``.
public struct CoreGraphicsScreenRedactor: ScreenRedacting {
    /// JPEG quality of the re-encoded image. Matches the capture quality used by
    /// Juno Code's screen driver so a redacted image and an unredacted one are
    /// not distinguishable by file size.
    public static let compressionQuality: Double = 0.82

    public init() {}

    public func blanking(_ image: Data, regions: [AutomationRect]) throws -> Data {
        guard let source = CGImageSourceCreateWithData(image as CFData, nil),
            let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw ScreenRedactionError.undecodableImage
        }
        let width = decoded.width
        let height = decoded.height
        guard width > 0, height > 0,
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            )
        else {
            throw ScreenRedactionError.couldNotDraw
        }
        context.draw(decoded, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(gray: 0, alpha: 1)
        for region in regions {
            // The flip is the whole reason this conversion is in one place.
            // Screen points run downwards from the top-left; a CGContext runs
            // upwards from the bottom-left, and a redaction drawn without the
            // flip covers the mirror image of the password field.
            context.fill(
                CGRect(
                    x: region.x,
                    y: Double(height) - region.y - region.height,
                    width: region.width,
                    height: region.height
                )
            )
        }
        guard let painted = context.makeImage() else {
            throw ScreenRedactionError.couldNotDraw
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ScreenRedactionError.couldNotEncode
        }
        CGImageDestinationAddImage(
            destination,
            painted,
            [kCGImageDestinationLossyCompressionQuality: Self.compressionQuality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw ScreenRedactionError.couldNotEncode
        }
        return output as Data
    }
}

// MARK: - The policy

/// When a screenshot may be taken, what is painted over before it is stored,
/// how long it is kept, and whether it may leave the Mac at all.
///
/// The four questions are answered in that order and never in any other, because
/// each one is only meaningful before the next has happened. Deciding whether an
/// image may leave *after* it has been relayed is not a decision.
public struct ScreenshotPolicy: Hashable, Sendable {
    /// The ceiling on retention, whatever a caller asks for.
    ///
    /// A screen capture is the single most revealing artefact automation
    /// produces: it contains whatever else was on the display, including the
    /// windows nobody granted. Keeping one for a working session is a debugging
    /// convenience; keeping it for a day is a breach waiting for a backup.
    public static let maximumRetention: TimeInterval = 15 * 60

    public var capturePermitted: Bool
    /// How long a stored capture lives. Clamped to ``maximumRetention``.
    public var retention: TimeInterval
    /// Whether an image may be sent off this Mac at all — to the phone, to a
    /// model, anywhere. Independent of ``capturePermitted``, because "Juno may
    /// look at my screen to find the button" and "Juno may put my screen on the
    /// internet" are different answers and are routinely given differently.
    public var relayPermitted: Bool
    /// Whether a capture may proceed when a sensitive surface was found that the
    /// tier could not give a region for.
    ///
    /// Defaults to false, which refuses. The alternative stores an image
    /// containing a password field alongside a note saying redaction was
    /// attempted, which is worse than having no image at all because somebody
    /// will trust it.
    public var allowsCaptureWithUnredactableSurface: Bool

    public init(
        capturePermitted: Bool = false,
        retention: TimeInterval = 5 * 60,
        relayPermitted: Bool = false,
        allowsCaptureWithUnredactableSurface: Bool = false
    ) {
        self.capturePermitted = capturePermitted
        self.retention = min(max(0, retention), Self.maximumRetention)
        self.relayPermitted = relayPermitted
        self.allowsCaptureWithUnredactableSurface = allowsCaptureWithUnredactableSurface
    }

    /// Nothing is captured and nothing leaves. The state a Mac starts from.
    public static let refused = ScreenshotPolicy()

    /// Whether content at this classification may appear in an image that leaves
    /// the Mac.
    ///
    /// Mirrors `allowsScreenshotRelay` in `src/lib/work/domain.ts`, including the
    /// part that matters: `restricted` never does, and the check runs before the
    /// image is stored or relayed rather than after.
    public static func allowsRelay(_ sensitivity: AutomationSensitivity) -> Bool {
        sensitivity < .restricted
    }

    /// Whether a capture may be taken at all, given what was found on screen.
    public func captureRuling(surfaces: [SensitiveSurface]) -> AutomationDecision {
        guard capturePermitted else {
            return .refused(
                AutomationRefusal(
                    .screenshotNotPermitted,
                    "Juno is not allowed to take pictures of this Mac's screen."
                )
            )
        }
        guard allowsCaptureWithUnredactableSurface
            || SensitiveSurfaceDetector.allSurfacesAreRedactable(surfaces)
        else {
            return .refused(
                AutomationRefusal(
                    .sensitiveSurface,
                    "There is something on screen Juno could not cover up, so it did not take the picture."
                )
            )
        }
        return .allowed
    }

    /// Captures: redacts first, then produces the only value that can be stored
    /// or relayed.
    ///
    /// - Parameter raw: encoded bytes straight from the driver. They are not
    ///   returned, not stored and not reachable from the result; the only thing
    ///   that leaves this function is the painted copy.
    public func capture(
        raw: Data,
        surfaces: [SensitiveSurface],
        baseSensitivity: AutomationSensitivity = .internalContent,
        redactor: any ScreenRedacting,
        at date: Date
    ) throws -> RedactedScreenshot {
        if let refusal = captureRuling(surfaces: surfaces).refusal { throw refusal }
        let regions = SensitiveSurfaceDetector.redactionRegions(of: surfaces)
        let painted = try redactor.blanking(raw, regions: regions)
        let sensitivity = AutomationSensitivity.highest(
            [baseSensitivity, SensitiveSurfaceDetector.sensitivity(of: surfaces)]
        )
        return RedactedScreenshot(
            bytes: painted,
            sensitivity: sensitivity,
            redactedRegionCount: regions.count,
            capturedAt: date,
            expiresAt: date.addingTimeInterval(retention)
        )
    }

    /// Whether this image may leave the Mac now.
    ///
    /// Three ways to say no, and they are all checked every time it is asked
    /// rather than once when the image was made: the switch may have been turned
    /// off since, the classification may be restricted, and the image may have
    /// outlived its retention while sitting in a queue.
    public func relayRuling(for screenshot: RedactedScreenshot, at date: Date) -> AutomationDecision {
        guard relayPermitted else {
            return .refused(
                AutomationRefusal(
                    .screenshotNotPermitted,
                    "Pictures of this Mac's screen stay on this Mac."
                )
            )
        }
        guard Self.allowsRelay(screenshot.sensitivity) else {
            return .refused(
                AutomationRefusal(
                    .sensitiveSurface,
                    "What was on screen is too sensitive to send anywhere, so Juno kept it here."
                )
            )
        }
        guard !screenshot.isExpired(at: date) else {
            return .refused(
                AutomationRefusal(
                    .screenshotExpired,
                    "That picture of the screen is older than Juno keeps them for."
                )
            )
        }
        return .allowed
    }
}
