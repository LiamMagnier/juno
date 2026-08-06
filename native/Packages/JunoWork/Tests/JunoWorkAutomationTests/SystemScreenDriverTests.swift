import Foundation
import JunoWorkCore
import JunoWorkRuntime
import XCTest

@testable import JunoWorkAutomation

#if os(macOS)
/// ``SystemScreenDriver``'s refusals.
///
/// Every test here runs with at least one macOS permission withheld, and that is
/// the whole suite on purpose: the paths where the permission *is* held capture
/// whatever is on the machine's screen and post real clicks and keystrokes into
/// whatever is in front of it. Those are not things a test may do.
///
/// The refusals are the part worth pinning anyway, because the failure this tier
/// is worst at producing is silence. `CGEvent.post` without Accessibility does
/// not error — it returns normally and nothing moves — so a driver that did not
/// preflight would report a run of successful clicks that never landed.
final class SystemScreenDriverTests: XCTestCase {
    private func driver(
        screenRecording: Bool,
        accessibility: Bool,
        frontmost: (name: String, pid: pid_t)? = ("com.example.notes", 1)
    ) -> SystemScreenDriver {
        SystemScreenDriver(
            screenRecordingAuthorized: { screenRecording },
            accessibilityAuthorized: { accessibility },
            frontmostApplication: { frontmost }
        )
    }

    // MARK: - Availability

    /// Both permissions or nothing. One of them can see the screen and the other
    /// can touch it, and half of that is a task this Mac would win and then fail.
    func testTheTierIsUnavailableUnlessBothPermissionsAreHeld() async {
        var available = await driver(screenRecording: false, accessibility: false).isAvailable()
        XCTAssertFalse(available)
        available = await driver(screenRecording: true, accessibility: false).isAvailable()
        XCTAssertFalse(available)
        available = await driver(screenRecording: false, accessibility: true).isAvailable()
        XCTAssertFalse(available)
        available = await driver(screenRecording: true, accessibility: true).isAvailable()
        XCTAssertTrue(available)
    }

    // MARK: - Refusals

    func testCaptureRefusesByNameWithoutScreenRecording() async {
        await assertRefusal(
            code: .screenshotNotPermitted,
            mentioning: "Screen Recording"
        ) { _ = try await self.driver(screenRecording: false, accessibility: true).capture() }
    }

    func testClickingRefusesByNameWithoutAccessibility() async {
        await assertRefusal(code: .driverUnavailable, mentioning: "Accessibility") {
            try await self.driver(screenRecording: true, accessibility: false)
                .click(at: AutomationPoint(x: 10, y: 10))
        }
    }

    func testTypingRefusesByNameWithoutAccessibility() async {
        await assertRefusal(code: .driverUnavailable, mentioning: "Accessibility") {
            try await self.driver(screenRecording: true, accessibility: false).type("hello")
        }
    }

    /// Refusing rather than answering "nothing sensitive is on screen".
    ///
    /// An empty list is the answer that lets the capture proceed, and the image
    /// it proceeds to store is the one with the password still in it.
    func testAnUnreadableScreenIsARefusalRatherThanAnEmptyRedactionPlan() async {
        await assertRefusal(code: .driverUnavailable, mentioning: "Accessibility") {
            _ = try await self.driver(screenRecording: true, accessibility: false).sensitiveSurfaces()
        }
    }

    // MARK: - Geometry

    /// Capture, bounds and clicks all mean the main display, which is what lets
    /// ``VisualControl`` refuse a coordinate the model has never been shown.
    func testDisplayBoundsAreTheMainDisplayInPoints() async throws {
        let bounds = try await driver(screenRecording: true, accessibility: true).displayBounds()
        XCTAssertEqual(bounds.x, 0)
        XCTAssertEqual(bounds.y, 0)
        XCTAssertGreaterThan(bounds.width, 0)
        XCTAssertGreaterThan(bounds.height, 0)
        XCTAssertTrue(bounds.contains(AutomationPoint(x: 1, y: 1)))
    }

    /// The app in front is what the permission gate is given, so an application
    /// with no bundle identifier has to read as "could not tell" rather than as
    /// the empty string — which would be compared against the allow list and
    /// refused with a message about the wrong thing.
    func testAnUnidentifiableFrontApplicationIsNil() async throws {
        let anonymous = driver(
            screenRecording: true, accessibility: true, frontmost: (name: "", pid: 9)
        )
        let identifier = try await anonymous.frontmostBundleIdentifier()
        XCTAssertNil(identifier)

        let absent = driver(screenRecording: true, accessibility: true, frontmost: nil)
        let none = try await absent.frontmostBundleIdentifier()
        XCTAssertNil(none)
    }

    // MARK: - Encoding

    /// The stored bytes are JPEG at the quality ``CoreGraphicsScreenRedactor``
    /// re-encodes with, so a redacted image and an unredacted one are not
    /// distinguishable by file size alone.
    func testCapturesAreEncodedAtTheSameQualityRedactionReEncodesWith() throws {
        let context = try XCTUnwrap(
            CGContext(
                data: nil,
                width: 64,
                height: 48,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            )
        )
        context.setFillColor(gray: 0.5, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        let image = try XCTUnwrap(context.makeImage())

        let encoded = try SystemScreenDriver.encode(image)
        XCTAssertFalse(encoded.isEmpty)
        // The redactor has to be able to read back what the driver wrote, or
        // every capture refuses at the redaction step.
        let redacted = try CoreGraphicsScreenRedactor().blanking(
            encoded,
            regions: [AutomationRect(x: 0, y: 0, width: 10, height: 10)]
        )
        XCTAssertFalse(redacted.isEmpty)
    }

    // MARK: - Harness

    private func assertRefusal(
        code: AutomationRefusal.Code,
        mentioning fragment: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected a refusal", file: file, line: line)
        } catch let refusal as AutomationRefusal {
            XCTAssertEqual(refusal.code, code, file: file, line: line)
            XCTAssertTrue(
                refusal.message.localizedCaseInsensitiveContains(fragment),
                "\(refusal.message) does not mention \(fragment)",
                file: file,
                line: line
            )
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }
}
#endif
