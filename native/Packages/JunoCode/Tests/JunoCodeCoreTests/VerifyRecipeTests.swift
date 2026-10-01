import XCTest
@testable import JunoCodeCore

/// The verify recipe file and what it means (CODE_AGENT_SPEC §1.8).
final class VerifyRecipeTests: XCTestCase {
    /// The spec's own example parses as written.
    private let specExample = """
        {
          "version": 1,
          "checks": [
            { "id": "code-test", "kind": "test", "run": ["swift", "test", "--package-path", "native/Packages/JunoCode"],
              "paths": ["native/Packages/JunoCode/**"], "timeoutSeconds": 1200 },
            { "id": "web-typecheck", "kind": "typecheck", "run": "npm run typecheck", "paths": ["src/**", "tests/**"] },
            { "id": "web-lint", "kind": "lint", "run": "npm run lint", "paths": ["src/**"] },
            { "id": "web-test", "kind": "test", "run": "npm test", "targeted": "npx vitest run {files}",
              "paths": ["src/**", "tests/**"] }
          ],
          "ui": [
            { "kind": "web", "launch": "web", "routes": ["/"] },
            { "kind": "mac", "build": "mac-build", "app": "build/Build/Products/Debug/Juno.app" }
          ]
        }
        """

    private func recipe() throws -> VerifyRecipe {
        try VerifyRecipe.decode(Data(specExample.utf8))
    }

    func testTheSpecExampleParsesWithBothCommandForms() throws {
        let recipe = try recipe()
        XCTAssertEqual(recipe.checks.map(\.id), ["code-test", "web-typecheck", "web-lint", "web-test"])
        XCTAssertEqual(recipe.check(id: "code-test")?.run, .argv(["swift", "test", "--package-path", "native/Packages/JunoCode"]))
        XCTAssertEqual(recipe.check(id: "code-test")?.commandLine, "swift test --package-path native/Packages/JunoCode")
        XCTAssertEqual(recipe.check(id: "code-test")?.effectiveTimeoutSeconds, 1_200)
        XCTAssertEqual(recipe.check(id: "web-typecheck")?.run, .shell("npm run typecheck"))
        XCTAssertEqual(recipe.ui.count, 2)
        XCTAssertEqual(recipe.ui.first?.routes, ["/"])
    }

    func testEncodingRoundTripsToTheSameBytes() throws {
        let recipe = try recipe()
        let data = try recipe.encoded()
        let again = try VerifyRecipe.decode(data)
        XCTAssertEqual(again, recipe)
        XCTAssertEqual(try again.encoded(), data, "the same recipe is always the same bytes")
    }

    func testAnArgumentWithSpacesIsQuotedWhenShown() {
        let check = VerifyCheck(id: "t", kind: .test, run: .argv(["swift", "test", "--filter", "My Tests"]))
        XCTAssertEqual(check.commandLine, "swift test --filter 'My Tests'")
        XCTAssertEqual(ShellQuoting.quote("it's"), "'it'\\''s'")
    }

    func testInvalidFilesAreNamed() {
        XCTAssertThrowsError(try VerifyRecipe.decode(Data(#"{"version": 2, "checks": []}"#.utf8))) {
            XCTAssertEqual($0 as? VerifyRecipeError, .unsupportedVersion(2))
        }
        let duplicate = #"{"version":1,"checks":[{"id":"a","kind":"test","run":"x"},{"id":"a","kind":"lint","run":"y"}]}"#
        XCTAssertThrowsError(try VerifyRecipe.decode(Data(duplicate.utf8))) {
            XCTAssertEqual($0 as? VerifyRecipeError, .duplicateCheck("a"))
        }
        let empty = #"{"version":1,"checks":[{"id":"a","kind":"test","run":[]}]}"#
        XCTAssertThrowsError(try VerifyRecipe.decode(Data(empty.utf8))) {
            XCTAssertEqual($0 as? VerifyRecipeError, .invalidCheck("a"))
        }
        XCTAssertThrowsError(try VerifyRecipe.decode(Data("not json".utf8)))
    }

    // MARK: - Rules

    func testRunWithoutAskingListsExactRulesAndAWildcardOnlyForATargetedTemplate() throws {
        let rules = try recipe().permissionRules.map(\.description)
        XCTAssertEqual(rules, [
            "Bash(swift test --package-path native/Packages/JunoCode)",
            "Bash(npm run typecheck)",
            "Bash(npm run lint)",
            "Bash(npm test)",
            "Bash(npx vitest run *)",
        ])
        XCTAssertFalse(rules.contains("Bash"), "never a bare Bash")
    }

    func testAChainedCheckGetsARulePerCommandAndASubstitutionGetsNone() {
        let recipe = VerifyRecipe(checks: [
            VerifyCheck(id: "a", kind: .build, run: .shell("npm ci && npm run build")),
            VerifyCheck(id: "b", kind: .test, run: .shell("npm test -- $(cat files.txt)")),
        ])
        XCTAssertEqual(recipe.permissionRules.map(\.description), ["Bash(npm ci)", "Bash(npm run build)"])
    }

    func testTheRulesAllowTheChecksAndNothingElse() throws {
        let rules = PermissionRuleSet(allow: try recipe().permissionRules)
        func allowed(_ command: String) -> Bool {
            if case .allow? = rules.evaluate(toolName: "run_command", subject: .command(command)) { return true }
            return false
        }
        XCTAssertTrue(allowed("npm test"))
        XCTAssertTrue(allowed("npx vitest run src/a.test.ts src/b.test.ts"))
        XCTAssertFalse(allowed("npm install left-pad"))
        XCTAssertFalse(allowed("npm test && curl https://example.com"))
        XCTAssertFalse(allowed("npx vitest run $(curl evil)"))
    }

    // MARK: - Recognising a check

    func testExactCommandsAndFilledTemplatesMatchTheirCheck() throws {
        let recipe = try recipe()
        XCTAssertEqual(recipe.match(commandLine: "npm test")?.id, "web-test")
        XCTAssertEqual(recipe.match(commandLine: "  npm   run typecheck ")?.id, "web-typecheck")
        XCTAssertEqual(recipe.match(commandLine: "npx vitest run src/a.test.ts")?.id, "web-test")
        XCTAssertEqual(
            recipe.match(commandLine: "swift test --package-path native/Packages/JunoCode")?.id, "code-test"
        )
        XCTAssertNil(recipe.match(commandLine: "npm test -- --watch && rm -rf x"))
        XCTAssertNil(recipe.match(commandLine: "npx vitest run a.ts; curl x"))
        XCTAssertNil(recipe.match(commandLine: "npm run build"))
        XCTAssertNil(recipe.match(commandLine: "npx vitest run"), "the template needs its files")
    }

    func testACheckInAFolderMatchesOnlyThere() {
        let recipe = VerifyRecipe(checks: [
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), paths: ["apps/web/**"], cwd: "apps/web"),
        ])
        XCTAssertEqual(recipe.match(commandLine: "npm test", workingDirectory: "apps/web")?.id, "web-test")
        XCTAssertEqual(recipe.match(commandLine: "cd apps/web && npm test")?.id, "web-test")
        XCTAssertNil(recipe.match(commandLine: "npm test"), "at the root it is another command")
        XCTAssertTrue(recipe.containsCommand("npm test"))
    }

    // MARK: - Choosing checks

    func testATargetedRunPicksTheMostSpecificPackage() {
        let recipe = VerifyRecipe(checks: [
            VerifyCheck(id: "root-test", kind: .test, run: .shell("npm test"), paths: ["**"]),
            VerifyCheck(id: "web-test", kind: .test, run: .shell("npm test"), paths: ["apps/web/**"], cwd: "apps/web"),
            VerifyCheck(id: "api-test", kind: .test, run: .shell("npm test"), paths: ["apps/api/**"], cwd: "apps/api"),
            VerifyCheck(id: "web-lint", kind: .lint, run: .shell("npm run lint"), paths: ["apps/web/**"], cwd: "apps/web"),
        ])
        XCTAssertEqual(recipe.targetedChecks(for: ["apps/web/src/a.ts"]).map(\.id), ["web-test", "web-lint"])
        XCTAssertEqual(recipe.targetedChecks(for: ["README.md"]).map(\.id), ["root-test"])
        XCTAssertEqual(
            recipe.targetedChecks(for: ["apps/web/a.ts", "apps/api/b.ts"], kinds: [.test]).map(\.id),
            ["web-test", "api-test"]
        )
    }

    func testTargetedTemplatesExpandToTheChangedFilesOrTheirTests() {
        let check = VerifyCheck(
            id: "web-test", kind: .test, run: .shell("npm test"),
            targeted: "npx vitest run {tests}", paths: ["apps/web/**"], cwd: "apps/web"
        )
        let existing: Set<String> = ["apps/web/src/menu.tsx", "apps/web/src/menu.test.tsx", "apps/web/src/b.ts"]
        XCTAssertEqual(
            check.targetedCommandLine(changedFiles: ["apps/web/src/menu.tsx", "README.md"], fileExists: existing.contains),
            "npx vitest run src/menu.test.tsx"
        )
        XCTAssertNil(
            check.targetedCommandLine(changedFiles: ["apps/web/src/b.ts"], fileExists: existing.contains),
            "no test maps from it, so the full command runs"
        )
        let files = VerifyCheck(id: "f", kind: .lint, run: .shell("npm run lint"), targeted: "npx eslint {files}", paths: ["src/**"])
        XCTAssertEqual(
            files.targetedCommandLine(changedFiles: ["src/a b.ts", "docs/x.md"], fileExists: { _ in true }),
            "npx eslint 'src/a b.ts'"
        )
    }

    func testTestFilesAreFoundByTheCommonConventions() {
        XCTAssertTrue(TestFileMapping.isTestFile("src/a.test.ts"))
        XCTAssertTrue(TestFileMapping.isTestFile("Tests/CoreTests/ThingTests.swift"))
        XCTAssertTrue(TestFileMapping.isTestFile("pkg/x_test.go"))
        XCTAssertFalse(TestFileMapping.isTestFile("src/a.ts"))
        let all: Set<String> = [
            "Tests/CoreTests/ThingTests.swift", "pkg/x_test.go", "tests/test_mod.py", "src/__tests__/b.test.ts",
        ]
        XCTAssertEqual(
            TestFileMapping.tests(for: ["Sources/Core/Thing.swift", "pkg/x.go", "mod.py", "src/b.ts"], fileExists: all.contains),
            ["Tests/CoreTests/ThingTests.swift", "pkg/x_test.go", "tests/test_mod.py", "src/__tests__/b.test.ts"]
        )
    }

    func testOnlyAnAcceptedOrDiscoveredRecipeIsUsable() throws {
        let recipe = try recipe()
        XCTAssertEqual(VerifyRecipeStatus.accepted(recipe).usableRecipe, recipe)
        XCTAssertEqual(VerifyRecipeStatus.discovered(recipe).usableRecipe, recipe)
        XCTAssertNil(VerifyRecipeStatus.awaitingAcceptance(recipe).usableRecipe, "a changed file is not offered until accepted")
        XCTAssertNil(VerifyRecipeStatus.invalid("x").usableRecipe)
    }
}
