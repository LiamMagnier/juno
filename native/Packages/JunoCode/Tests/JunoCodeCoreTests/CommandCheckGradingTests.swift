import XCTest
@testable import JunoCodeCore

/// Which commands count as checks (CODE_AGENT_SPEC §1.8): the grade decides
/// whether a result is evidence, never how risky the command is.
final class CommandCheckGradingTests: XCTestCase {
    private let classifier = CommandClassifier()

    func testWorkspaceChecksAreGraded() {
        let expected: [(String, CheckKind)] = [
            ("npm test", .test), ("pnpm test", .test), ("yarn test", .test), ("bun test", .test),
            ("npm run test:unit", .test), ("npm run lint", .lint), ("pnpm run typecheck", .typecheck),
            ("yarn build", .build), ("npx vitest run src/a.test.ts", .test), ("vitest run", .test),
            ("pnpm exec vitest run", .test), ("jest --ci", .test), ("npx tsc --noEmit -p .", .typecheck),
            ("tsc -b", .build), ("xcodebuild test -scheme App", .test), ("xcodebuild -scheme App build", .build),
            ("pytest -q", .test), ("python3 -m pytest tests", .test), ("uv run pytest", .test),
            ("poetry run mypy .", .typecheck), ("ruff check .", .lint), ("go test ./...", .test),
            ("go vet ./...", .lint), ("golangci-lint run", .lint), ("cargo clippy -- -D warnings", .lint),
            ("cargo check", .typecheck), ("cargo test", .test), ("swift build", .build),
            ("swift test --package-path native/Packages/JunoCode", .test), ("make test", .test),
            ("make lint", .lint), ("./gradlew test", .test), ("mvn -q test", .test), ("dotnet test", .test),
            ("mix test", .test), ("bundle exec rspec", .test), ("deno check .", .typecheck), ("swiftlint lint", .lint),
            ("npx eslint src --fix", .lint), ("vite build", .build),
        ]
        for (command, kind) in expected {
            XCTAssertEqual(classifier.checkKind(of: command), kind, command)
        }
    }

    func testAChainOfFolderChangesAndChecksIsGradedByItsLastCheck() {
        XCTAssertEqual(classifier.checkKind(of: "cd web && npm test"), .test)
        XCTAssertEqual(classifier.checkKind(of: "npm run typecheck && npm test"), .test)
        XCTAssertEqual(classifier.checkKind(of: "CI=1 npm test"), .test)
        XCTAssertEqual(classifier.checkKind(of: "env CI=1 FORCE_COLOR=0 npm test"), .test)
        XCTAssertEqual(classifier.checkKind(of: "npm test > out.log 2>&1"), .test, "a redirection keeps the status")
    }

    func testCommandsWhoseStatusDoesNotMeanPassOrFailAreNot() {
        for command in [
            "npm test | tail -20",       // a pipe reports tail's status
            "npm test || true",          // the failure is thrown away
            "npm test; echo done",       // so is this one
            "npm test &",                // never waited for
            "npm ci && npm install x",   // not every part is a check
            "echo $(npm test)",          // runs a command from inside itself
            "npm run dev",
            "npm install",
            "vitest --watch src",
            "tsc --watch",
            "jest --watch",
            "ls -la",
            "",
        ] {
            XCTAssertNil(classifier.checkKind(of: command), command)
        }
    }

    func testTheGradeNeverChangesTheRisk() {
        // Graded or not, a command keeps the tier the classifier gives it:
        // `npm test` runs package scripts and stays critical.
        XCTAssertEqual(classifier.classify("npm test").risk, .critical)
        XCTAssertEqual(classifier.classify("swift test").risk, .execute)
        XCTAssertEqual(classifier.classify("cd web && npm test").risk, .critical)
    }

    func testScriptNamesAreReadForWhatTheyCheck() {
        XCTAssertEqual(CommandClassifier.gradeScriptName("type-check"), .typecheck)
        XCTAssertEqual(CommandClassifier.gradeScriptName("test:e2e"), .test)
        XCTAssertNil(CommandClassifier.gradeScriptName("test:watch"))
        XCTAssertNil(CommandClassifier.gradeScriptName("lint:fix"))
        XCTAssertNil(CommandClassifier.gradeScriptName("dev"))
    }
}
