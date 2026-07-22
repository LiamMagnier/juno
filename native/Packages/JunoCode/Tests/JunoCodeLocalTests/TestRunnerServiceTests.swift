import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class TestRunnerServiceTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-tr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func makeRunner() throws -> TestRunnerService {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        return TestRunnerService(
            access: access,
            executor: CommandExecutionService(workspaceRootURL: workspaceURL)
        )
    }

    func testDetectsSwiftAndNodeAndRust() async throws {
        try "// swift-tools-version: 6.0".write(
            to: workspaceURL.appendingPathComponent("Package.swift"),
            atomically: true,
            encoding: .utf8
        )
        try #"{"scripts": {"test": "vitest", "typecheck": "tsc"}}"#.write(
            to: workspaceURL.appendingPathComponent("package.json"),
            atomically: true,
            encoding: .utf8
        )
        try "[package]".write(
            to: workspaceURL.appendingPathComponent("Cargo.toml"),
            atomically: true,
            encoding: .utf8
        )
        let runner = try makeRunner()
        let suggestions = await runner.detectSuggestions()
        let commands = suggestions.map(\.command)
        XCTAssertTrue(commands.contains("swift test"))
        XCTAssertTrue(commands.contains("npm test"))
        XCTAssertTrue(commands.contains("npm run typecheck"))
        XCTAssertTrue(commands.contains("cargo test"))
    }

    func testNoMarkersMeansNoSuggestions() async throws {
        let runner = try makeRunner()
        let suggestions = await runner.detectSuggestions()
        XCTAssertTrue(suggestions.isEmpty)
    }

    func testStreamedRunParsesOutcome() async throws {
        let runner = try makeRunner()
        var output = ""
        var result: CommandResult?
        for try await event in runner.stream(
            command: "echo '===== 4 passed in 0.2s ====='",
            timeoutSeconds: 10
        ) {
            switch event {
            case let .stdout(text): output += text
            case let .stderr(text): output += text
            case let .completed(final): result = final
            }
        }
        let outcome = TestOutputParser.parse(
            command: "pytest",
            output: output,
            exitCode: result?.exitCode ?? -1,
            durationSeconds: result?.durationSeconds ?? 0
        )
        XCTAssertTrue(outcome.passed)
        XCTAssertEqual(outcome.testsRun, 4)
        XCTAssertEqual(outcome.failures, 0)
    }
}
