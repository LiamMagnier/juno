import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import JunoWorkAutomation

// MARK: - Shared doubles
//
// Declared here rather than in a file of their own because a test target
// compiles as one module, and a sixth file nobody asked for would hide the
// redactor from the suite that exercises it most.

/// A redactor that records what it was asked to paint over and returns bytes
/// that could not possibly be the input.
///
/// Returning something visibly different is the point: the assertion that
/// matters is "what was stored is the redacted copy", and a double that echoed
/// its input would pass that assertion whether or not redaction happened.
final class RecordingRedactor: ScreenRedacting, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedRegions: [[AutomationRect]] = []
    let output: Data
    let failure: (any Error)?

    init(output: Data = Data("redacted".utf8), failure: (any Error)? = nil) {
        self.output = output
        self.failure = failure
    }

    var regionsSeen: [[AutomationRect]] {
        lock.lock()
        defer { lock.unlock() }
        return recordedRegions
    }

    func blanking(_ image: Data, regions: [AutomationRect]) throws -> Data {
        lock.lock()
        recordedRegions.append(regions)
        lock.unlock()
        if let failure { throw failure }
        return output
    }
}

/// A clock a test can move.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date = Date(timeIntervalSince1970: 1_700_000_000)) {
        self.current = start
    }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(_ interval: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(interval)
        lock.unlock()
    }

    var reader: @Sendable () -> Date {
        { [self] in self.now }
    }
}

final class ScreenshotPolicyTests: XCTestCase {
    private let clock = TestClock()

    private func surface(
        _ kind: SensitiveSurfaceKind = .password,
        region: AutomationRect? = AutomationRect(x: 10, y: 20, width: 60, height: 24)
    ) -> SensitiveSurface {
        SensitiveSurface(kind: kind, signal: .secureTextEntry, region: region)
    }

    // MARK: - Whether a capture happens at all

    func testCaptureIsRefusedUntilItIsSwitchedOn() {
        XCTAssertEqual(
            ScreenshotPolicy.refused.captureRuling(surfaces: []).refusal?.code,
            .screenshotNotPermitted
        )
    }

    /// A password field the tier could not give a frame for is a password field
    /// the capture cannot hide. Storing the image with a note saying redaction
    /// was attempted is worse than having no image, because somebody trusts it.
    func testASensitiveSurfaceThatCannotBePaintedOverRefusesTheCapture() {
        let policy = ScreenshotPolicy(capturePermitted: true)
        XCTAssertTrue(policy.captureRuling(surfaces: [surface()]).isAllowed)
        XCTAssertEqual(
            policy.captureRuling(surfaces: [surface(region: nil)]).refusal?.code, .sensitiveSurface
        )
    }

    func testTheOverrideExistsAndIsOffByDefault() {
        let permissive = ScreenshotPolicy(
            capturePermitted: true,
            allowsCaptureWithUnredactableSurface: true
        )
        XCTAssertTrue(permissive.captureRuling(surfaces: [surface(region: nil)]).isAllowed)
        XCTAssertFalse(ScreenshotPolicy(capturePermitted: true).allowsCaptureWithUnredactableSurface)
    }

    // MARK: - Redaction happens before storage

    /// The only constructor of a ``RedactedScreenshot`` runs the redaction, so
    /// the bytes anything else can reach are the painted ones. A redaction pass
    /// over an image already written to disk and pushed to a phone has redacted
    /// nothing.
    func testTheStoredBytesAreTheRedactedBytesAndTheRawOnesAreUnreachable() throws {
        let redactor = RecordingRedactor()
        let policy = ScreenshotPolicy(capturePermitted: true, retention: 60)
        let raw = Data("the-actual-screen".utf8)
        let region = AutomationRect(x: 4, y: 8, width: 16, height: 32)

        let stored = try policy.capture(
            raw: raw,
            surfaces: [surface(region: region)],
            redactor: redactor,
            at: clock.now
        )

        XCTAssertEqual(stored.bytes, redactor.output)
        XCTAssertNotEqual(stored.bytes, raw)
        XCTAssertEqual(redactor.regionsSeen, [[region]])
        XCTAssertEqual(stored.redactedRegionCount, 1)
    }

    func testAFailedRedactionProducesNoImageAtAll() {
        let redactor = RecordingRedactor(failure: ScreenRedactionError.undecodableImage)
        let policy = ScreenshotPolicy(capturePermitted: true)
        XCTAssertThrowsError(
            try policy.capture(
                raw: Data("raw".utf8),
                surfaces: [],
                redactor: redactor,
                at: clock.now
            )
        )
    }

    func testWhatWasOnScreenRaisesTheClassificationOfTheImage() throws {
        let policy = ScreenshotPolicy(capturePermitted: true)
        let plain = try policy.capture(
            raw: Data(),
            surfaces: [],
            baseSensitivity: .internalContent,
            redactor: RecordingRedactor(),
            at: clock.now
        )
        XCTAssertEqual(plain.sensitivity, .internalContent)

        let withSecret = try policy.capture(
            raw: Data(),
            surfaces: [surface()],
            baseSensitivity: .internalContent,
            redactor: RecordingRedactor(),
            at: clock.now
        )
        XCTAssertEqual(withSecret.sensitivity, .restricted)
    }

    // MARK: - Whether it may leave the Mac

    /// Mirrors `allowsScreenshotRelay` in `src/lib/work/domain.ts`: restricted
    /// content never leaves.
    func testRestrictedContentNeverLeavesTheMac() throws {
        XCTAssertTrue(ScreenshotPolicy.allowsRelay(.publicContent))
        XCTAssertTrue(ScreenshotPolicy.allowsRelay(.internalContent))
        XCTAssertTrue(ScreenshotPolicy.allowsRelay(.confidential))
        XCTAssertFalse(ScreenshotPolicy.allowsRelay(.restricted))

        let policy = ScreenshotPolicy(capturePermitted: true, retention: 60, relayPermitted: true)
        let stored = try policy.capture(
            raw: Data(),
            surfaces: [surface()],
            redactor: RecordingRedactor(),
            at: clock.now
        )
        XCTAssertEqual(
            policy.relayRuling(for: stored, at: clock.now).refusal?.code, .sensitiveSurface
        )
    }

    func testRelayIsRefusedWhenTheSwitchIsOffEvenForHarmlessContent() throws {
        let policy = ScreenshotPolicy(capturePermitted: true, retention: 60, relayPermitted: false)
        let stored = try policy.capture(
            raw: Data(),
            surfaces: [],
            baseSensitivity: .publicContent,
            redactor: RecordingRedactor(),
            at: clock.now
        )
        XCTAssertEqual(
            policy.relayRuling(for: stored, at: clock.now).refusal?.code, .screenshotNotPermitted
        )
    }

    /// Retention belongs to the image rather than to whoever is holding it, so a
    /// copy sitting in a queue still knows it has expired.
    func testAnImageThatOutlivedItsRetentionCannotBeSent() throws {
        let policy = ScreenshotPolicy(capturePermitted: true, retention: 60, relayPermitted: true)
        let stored = try policy.capture(
            raw: Data(),
            surfaces: [],
            baseSensitivity: .internalContent,
            redactor: RecordingRedactor(),
            at: clock.now
        )
        XCTAssertTrue(policy.relayRuling(for: stored, at: clock.now).isAllowed)

        clock.advance(61)
        XCTAssertTrue(stored.isExpired(at: clock.now))
        XCTAssertEqual(
            policy.relayRuling(for: stored, at: clock.now).refusal?.code, .screenshotExpired
        )
    }

    func testRetentionIsClampedToTheCeiling() {
        let policy = ScreenshotPolicy(capturePermitted: true, retention: 24 * 60 * 60)
        XCTAssertEqual(policy.retention, ScreenshotPolicy.maximumRetention)
        XCTAssertEqual(ScreenshotPolicy(capturePermitted: true, retention: -10).retention, 0)
    }

    // MARK: - The real redactor

    /// Exercises ``CoreGraphicsScreenRedactor`` on a real encoded image, because
    /// the coordinate flip between screen points and a `CGContext` is the kind of
    /// mistake that produces a redaction covering the mirror image of the
    /// password field — and looks entirely correct in a test that only counts
    /// rectangles.
    func testTheRealRedactorPaintsTheRegionItWasGivenAndNotItsMirrorImage() throws {
        let size = 64
        let white = try makeWhiteJPEG(size: size)
        let painted = try CoreGraphicsScreenRedactor().blanking(
            white,
            regions: [AutomationRect(x: 0, y: 0, width: Double(size), height: 16)]
        )
        let samples = try luminance(of: painted, at: [(4, 4), (4, Double(size) - 4)])
        XCTAssertLessThan(samples[0], 40, "The top strip should have been painted out.")
        XCTAssertGreaterThan(samples[1], 200, "The bottom strip should have been left alone.")
    }

    func testTheRealRedactorRefusesBytesThatAreNotAnImage() {
        XCTAssertThrowsError(
            try CoreGraphicsScreenRedactor().blanking(Data("not an image".utf8), regions: [])
        )
    }

    // MARK: - Image helpers

    private func makeWhiteJPEG(size: Int) throws -> Data {
        guard let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else {
            throw ScreenRedactionError.couldNotDraw
        }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        guard let image = context.makeImage() else { throw ScreenRedactionError.couldNotDraw }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ScreenRedactionError.couldNotEncode
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ScreenRedactionError.couldNotEncode
        }
        return data as Data
    }

    /// Average brightness at points given in screen coordinates — top-left
    /// origin, the same space ``AutomationRect`` uses.
    private func luminance(of image: Data, at points: [(Double, Double)]) throws -> [Double] {
        guard let source = CGImageSourceCreateWithData(image as CFData, nil),
            let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw ScreenRedactionError.undecodableImage
        }
        let width = decoded.width
        let height = decoded.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress,
                let context = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: width * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                )
            else {
                throw ScreenRedactionError.couldNotDraw
            }
            context.draw(decoded, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return points.map { point in
            // A bitmap context's buffer is stored top-down — byte zero is the
            // top-left pixel — even though its drawing coordinates run from the
            // bottom left. That asymmetry is exactly why the redactor's flip is
            // worth a test: reading and drawing disagree about which end of the
            // image `y` counts from.
            let column = min(max(0, Int(point.0)), width - 1)
            let row = min(max(0, Int(point.1)), height - 1)
            let offset = (row * width + column) * 4
            let red = Double(pixels[offset])
            let green = Double(pixels[offset + 1])
            let blue = Double(pixels[offset + 2])
            return (red + green + blue) / 3
        }
    }
}
