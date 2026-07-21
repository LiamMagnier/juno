import XCTest
@testable import JunoCodeCore

final class CommandClassifierTests: XCTestCase {
    private let classifier = CommandClassifier()

    private func risk(_ command: String) -> ActionRisk? {
        classifier.classify(command).risk
    }

    private func isForbidden(_ command: String) -> Bool {
        if case .forbidden = classifier.classify(command) { return true }
        return false
    }

    func testOrdinaryCommandsAreExecuteRisk() {
        XCTAssertEqual(risk("swift build"), .execute)
        XCTAssertEqual(risk("npm run test"), .execute)
        XCTAssertEqual(risk("ls -la src"), .execute)
        XCTAssertEqual(risk("python3 scripts/check.py --verbose"), .execute)
        XCTAssertEqual(risk("git status --short"), .execute)
        XCTAssertEqual(risk("git diff --stat"), .execute)
    }

    func testForbiddenProgramsAreRejectedEverywhere() {
        XCTAssertTrue(isForbidden("sudo rm -rf cache"))
        XCTAssertTrue(isForbidden("su root"))
        XCTAssertTrue(isForbidden("shutdown -h now"))
        XCTAssertTrue(isForbidden("launchctl unload /Library/LaunchDaemons/x.plist"))
        XCTAssertTrue(isForbidden("/usr/bin/sudo id"))
        XCTAssertTrue(isForbidden("ls && sudo id"))
    }

    func testDestructiveDeletesAreForbiddenOrCritical() {
        XCTAssertTrue(isForbidden("rm -rf /"))
        XCTAssertTrue(isForbidden("rm -rf ~"))
        XCTAssertTrue(isForbidden("rm -rf /etc"))
        XCTAssertTrue(isForbidden("rm -rf ../other-project"))
        XCTAssertTrue(isForbidden("rm -rf ."))
        XCTAssertEqual(risk("rm build/cache.json"), .critical)
        XCTAssertEqual(risk("rm -rf node_modules"), .critical)
    }

    func testGitClassification() {
        XCTAssertEqual(risk("git push --force origin main"), .critical)
        XCTAssertEqual(risk("git push origin main"), .critical)
        XCTAssertEqual(risk("git reset --hard HEAD~3"), .critical)
        XCTAssertEqual(risk("git reset --soft HEAD~1"), .execute)
        XCTAssertEqual(risk("git clean -fd"), .critical)
        XCTAssertEqual(risk("git rebase -i main"), .critical)
        XCTAssertEqual(risk("git checkout -b feature/x"), .execute)
        XCTAssertEqual(risk("git checkout --force main"), .critical)
        XCTAssertEqual(risk("git -C sub status"), .execute)
        XCTAssertEqual(risk("git branch -D old"), .critical)
        XCTAssertEqual(risk("git fetch origin"), .critical)
    }

    func testNetworkAndInstallersAreCritical() {
        XCTAssertEqual(risk("curl https://example.com"), .critical)
        XCTAssertEqual(risk("wget https://example.com/x.sh"), .critical)
        XCTAssertEqual(risk("ssh host ls"), .critical)
        XCTAssertEqual(risk("npm install left-pad"), .critical)
        XCTAssertEqual(risk("pip install requests"), .critical)
        XCTAssertEqual(risk("brew install jq"), .critical)
        XCTAssertEqual(risk("cargo install ripgrep"), .critical)
    }

    func testShellEscapesAreCritical() {
        XCTAssertEqual(risk("echo $(cat /etc/passwd)"), .critical)
        XCTAssertEqual(risk("echo `id`"), .critical)
        XCTAssertEqual(risk("bash -c 'rm -rf x'"), .critical)
        XCTAssertEqual(risk("eval ls"), .critical)
        XCTAssertEqual(risk("chmod +x script.sh"), .critical)
        XCTAssertEqual(risk("kill -9 1234"), .critical)
    }

    func testPipelinesTakeTheWorstSegment() {
        XCTAssertEqual(risk("ls | grep foo"), .execute)
        XCTAssertEqual(risk("ls; curl https://x.dev"), .critical)
        XCTAssertTrue(isForbidden("ls || sudo id"))
    }

    func testRedirectsToAbsolutePathsAreCritical() {
        XCTAssertEqual(risk("echo hi > notes.txt"), .execute)
        XCTAssertEqual(risk("echo hi > /etc/hosts"), .critical)
        XCTAssertEqual(risk("swift build 2>&1"), .execute)
    }

    func testQuotingIsRespected() {
        // The quoted string is data, not a control operator.
        XCTAssertEqual(risk("echo 'a && sudo id'"), .execute)
        XCTAssertEqual(risk("grep \"rm -rf /\" README.md"), .execute)
        XCTAssertTrue(isForbidden("echo 'unbalanced"))
        XCTAssertTrue(isForbidden("echo trailing\\"))
    }

    func testEnvAssignmentPrefixesAreSkipped() {
        XCTAssertEqual(risk("CI=1 swift test"), .execute)
        XCTAssertEqual(risk("env FOO=bar make build"), .execute)
        XCTAssertTrue(isForbidden("CI=1 sudo make install"))
    }

    func testEmptyAndOversizedCommandsAreForbidden() {
        XCTAssertTrue(isForbidden("   "))
        XCTAssertTrue(isForbidden(String(repeating: "a", count: 20_000)))
    }
}
