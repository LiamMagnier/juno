import Foundation
import XCTest
@testable import JunoCodeLocal

final class DevServerURLDetectorTests: XCTestCase {
    func testLoopbackAddressWinsOverALANAdvertisement() {
        let line = "Network: http://192.168.1.20:3000  Local: http://localhost:3000/"

        XCTAssertEqual(
            DevServerURLDetector.detect(in: line),
            URL(string: "http://localhost:3000/")
        )
    }

    func testWildcardBindAddressIsNormalizedToLoopback() {
        let line = "ready at http://0.0.0.0:4173/."

        XCTAssertEqual(
            DevServerURLDetector.detect(in: line),
            URL(string: "http://localhost:4173/")
        )
    }

    func testPrivateNetworkAddressIsKeptAsPrinted() {
        let line = "Preview available at https://172.20.4.8:8443/dashboard"

        XCTAssertEqual(
            DevServerURLDetector.detect(in: line),
            URL(string: "https://172.20.4.8:8443/dashboard")
        )
    }

    func testBareLocalhostAndSpokenPortFormsAreSupported() {
        XCTAssertEqual(
            DevServerURLDetector.detect(in: "Server running at localhost:3000"),
            URL(string: "http://localhost:3000")
        )
        XCTAssertEqual(
            DevServerURLDetector.detect(in: "The service is listening on port: 8080"),
            URL(string: "http://localhost:8080")
        )
    }

    func testExternalURLsAndInvalidPortsAreRejected() {
        XCTAssertNil(DevServerURLDetector.detect(in: "Docs: https://example.com:443/preview"))
        XCTAssertNil(DevServerURLDetector.detect(in: "ready at http://localhost:70000"))
        XCTAssertNil(DevServerURLDetector.detect(in: "worker 1234 started"))
    }

    func testOutputSanitizerRemovesTerminalControlsAndKeepsTheSettledProgressLine() {
        let raw = "\u{1B}[36mold\u{1B}[0m\r\u{1B}[32mready\t\u{1B}[0m\u{07}"

        XCTAssertEqual(DevServerOutputSanitizer.sanitize(raw), "ready\t")
    }

    func testOutputSanitizerPreservesCRLFLines() {
        let raw = "Local: http://localhost:4568/\r"

        XCTAssertEqual(
            DevServerOutputSanitizer.sanitize(raw),
            "Local: http://localhost:4568/"
        )
        XCTAssertEqual(
            DevServerURLDetector.detect(in: DevServerOutputSanitizer.sanitize(raw)),
            URL(string: "http://localhost:4568/")
        )
    }
}
