import XCTest
@testable import JunoCodeCore

final class SecretRedactorTests: XCTestCase {
    private let redactor = SecretRedactor()

    func testRedactsWellKnownTokenShapes() {
        // Fixtures are assembled at runtime so this source file contains no
        // scannable secret literal, while the redactor still sees a complete
        // token per line.
        let github = "ghp_" + String(repeating: "A", count: 30)
        let slack = "xoxb-" + "123456789012" + "-" + String(repeating: "a", count: 14)
        let stripe = "sk_" + "live_" + String(repeating: "A", count: 16)
        let aws = "AKIA" + String(repeating: "Q", count: 16)
        let model = "sk-" + String(repeating: "z", count: 24)
        let input = "github: \(github)\nslack: \(slack)\nstripe: \(stripe)\naws: \(aws)\nmodel: \(model)"
        let output = redactor.redact(input)
        XCTAssertFalse(output.contains(github))
        XCTAssertFalse(output.contains(slack))
        XCTAssertFalse(output.contains(stripe))
        XCTAssertFalse(output.contains(aws))
        XCTAssertFalse(output.contains(model))
        XCTAssertTrue(output.contains(SecretRedactor.placeholder))
    }

    func testRedactsKeyValueAssignmentsButKeepsNames() {
        let output = redactor.redact("export API_KEY=super-secret-value OTHER=ok")
        XCTAssertTrue(output.contains("API_KEY="))
        XCTAssertFalse(output.contains("super-secret-value"))
        XCTAssertTrue(output.contains("OTHER=ok"))
    }

    func testRedactsAuthorizationHeadersAndURLCredentials() {
        let header = redactor.redact("Authorization: Bearer abc123def456ghi789")
        XCTAssertFalse(header.contains("abc123def456ghi789"))
        let url = redactor.redact("https://user:hunter2@example.com/repo.git")
        XCTAssertFalse(url.contains("hunter2"))
        XCTAssertTrue(url.contains("https://user:"))
        XCTAssertTrue(url.contains("@example.com"))
    }

    func testRedactsPEMBlocks() {
        let pem = """
        -----BEGIN RSA PRIVATE KEY-----
        MIIEpAIBAAKCAQEA1234567890
        -----END RSA PRIVATE KEY-----
        """
        let output = redactor.redact(pem)
        XCTAssertFalse(output.contains("MIIEpAIBAAKCAQEA"))
        XCTAssertEqual(output, SecretRedactor.placeholder)
    }

    func testLeavesOrdinaryTextAlone() {
        let input = "Ran 12 tests, 0 failures. See src/main.swift line 4."
        XCTAssertEqual(redactor.redact(input), input)
    }

    func testSensitiveEnvironmentNameDetection() {
        XCTAssertTrue(SecretRedactor.isSensitiveEnvironmentName("GITHUB_TOKEN"))
        XCTAssertTrue(SecretRedactor.isSensitiveEnvironmentName("npm_config_password"))
        XCTAssertTrue(SecretRedactor.isSensitiveEnvironmentName("AWS_SECRET_ACCESS_KEY"))
        XCTAssertFalse(SecretRedactor.isSensitiveEnvironmentName("PATH"))
        XCTAssertFalse(SecretRedactor.isSensitiveEnvironmentName("HOME"))
    }
}
