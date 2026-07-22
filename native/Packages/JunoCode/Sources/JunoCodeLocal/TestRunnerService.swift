import Foundation
import JunoCodeCore

/// Detects common test toolchains from workspace markers and streams test
/// runs through the command execution service.
public final class TestRunnerService: TestRunning, Sendable {
    private let access: any WorkspaceAccessing
    private let executor: any CommandExecuting

    public init(access: any WorkspaceAccessing, executor: any CommandExecuting) {
        self.access = access
        self.executor = executor
    }

    public func detectSuggestions() async -> [TestSuggestion] {
        var suggestions: [TestSuggestion] = []
        let root = access.rootURL

        func exists(_ name: String) -> Bool {
            FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path)
        }

        if exists("Package.swift") {
            suggestions.append(TestSuggestion(command: "swift test", toolchain: "Swift Package"))
        }
        if exists("package.json") {
            let packageURL = root.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: packageURL),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let scripts = json["scripts"] as? [String: Any]
            {
                if scripts["test"] != nil {
                    suggestions.append(
                        TestSuggestion(command: "npm test", toolchain: "npm scripts")
                    )
                }
                if scripts["typecheck"] != nil {
                    suggestions.append(
                        TestSuggestion(command: "npm run typecheck", toolchain: "npm scripts")
                    )
                }
            }
        }
        if exists("pytest.ini") || exists("setup.cfg") || exists("pyproject.toml") {
            suggestions.append(TestSuggestion(command: "pytest", toolchain: "pytest"))
        }
        if exists("Cargo.toml") {
            suggestions.append(TestSuggestion(command: "cargo test", toolchain: "Cargo"))
        }
        if exists("go.mod") {
            suggestions.append(TestSuggestion(command: "go test ./...", toolchain: "Go"))
        }
        if exists("pom.xml") {
            suggestions.append(TestSuggestion(command: "mvn test", toolchain: "Maven"))
        }
        if exists("build.gradle") || exists("build.gradle.kts") {
            suggestions.append(TestSuggestion(command: "./gradlew test", toolchain: "Gradle"))
        }
        return suggestions
    }

    public func stream(
        command: String,
        timeoutSeconds: Double
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        executor.stream(command, timeoutSeconds: timeoutSeconds, outputLimit: .commandOutput)
    }
}
