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
        XCTAssertEqual(risk("swift test --filter CommandClassifierTests"), .execute)
        XCTAssertEqual(risk("npm ls --depth=0"), .execute)
        XCTAssertEqual(risk("ls -la src"), .execute)
        XCTAssertEqual(risk("rg --files Sources"), .execute)
        XCTAssertEqual(risk("git status --short"), .execute)
        XCTAssertEqual(risk("git diff --stat"), .execute)
    }

    func testUnknownExecutablesAndInterpretersAreCritical() {
        XCTAssertEqual(risk("project-doctor --fix"), .critical)
        XCTAssertEqual(risk("./scripts/check"), .critical)
        XCTAssertEqual(risk("/tmp/project-doctor --fix"), .critical)
        XCTAssertEqual(risk("python3 scripts/check.py --verbose"), .critical)
        XCTAssertEqual(risk("node scripts/check.js"), .critical)
        XCTAssertEqual(risk("ruby -e 'puts 1'"), .critical)
        XCTAssertEqual(risk("java -jar tools/check.jar"), .critical)
        XCTAssertEqual(risk("npx eslint ."), .critical)
        XCTAssertEqual(risk("swift run Tool"), .critical)
        XCTAssertEqual(risk("swift script.swift"), .critical)
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
        XCTAssertEqual(risk("git reset --soft HEAD~1"), .critical)
        XCTAssertEqual(risk("git clean -fd"), .critical)
        XCTAssertEqual(risk("git rebase -i main"), .critical)
        XCTAssertEqual(risk("git checkout -b feature/x"), .critical)
        XCTAssertEqual(risk("git checkout --force main"), .critical)
        XCTAssertEqual(risk("git -C sub status"), .execute)
        XCTAssertEqual(risk("git branch -D old"), .critical)
        XCTAssertEqual(risk("git branch -d old"), .critical)
        XCTAssertEqual(risk("git fetch origin"), .critical)
        XCTAssertEqual(risk("git clone https://example.com/repo.git"), .critical)
        XCTAssertEqual(risk("git -c alias.audit='!sh audit.sh' audit"), .critical)
        XCTAssertEqual(risk("git config --global user.name Juno"), .critical)
        XCTAssertEqual(risk("git made-up-subcommand"), .critical)
    }

    func testNetworkAndInstallersAreCritical() {
        XCTAssertEqual(risk("curl https://example.com"), .critical)
        XCTAssertEqual(risk("wget https://example.com/x.sh"), .critical)
        XCTAssertEqual(risk("ssh host ls"), .critical)
        XCTAssertEqual(risk("npm install left-pad"), .critical)
        XCTAssertEqual(risk("pip install requests"), .critical)
        XCTAssertEqual(risk("brew install jq"), .critical)
        XCTAssertEqual(risk("cargo install ripgrep"), .critical)
        XCTAssertEqual(risk("npm run test"), .critical)
        XCTAssertEqual(risk("pnpm exec eslint ."), .critical)
        XCTAssertEqual(risk("gh pr view"), .critical)
    }

    func testShellEscapesAreCritical() {
        XCTAssertEqual(risk("echo $(cat /etc/passwd)"), .critical)
        XCTAssertEqual(risk("echo `id`"), .critical)
        XCTAssertEqual(risk("bash -c 'rm -rf x'"), .critical)
        XCTAssertEqual(risk("eval ls"), .critical)
        XCTAssertEqual(risk("chmod +x script.sh"), .critical)
        XCTAssertEqual(risk("kill -9 1234"), .critical)
        XCTAssertEqual(risk("cat <(python3 -c 'print(1)')"), .critical)
    }

    func testPipelinesTakeTheWorstSegment() {
        XCTAssertEqual(risk("ls | grep foo"), .execute)
        XCTAssertEqual(risk("ls; curl https://x.dev"), .critical)
        XCTAssertTrue(isForbidden("ls || sudo id"))
    }

    func testExplicitEscapingPathsAreCritical() {
        XCTAssertEqual(risk("echo hi > notes.txt"), .execute)
        XCTAssertEqual(risk("echo hi > /etc/hosts"), .critical)
        XCTAssertEqual(risk("echo hi > ../outside.txt"), .critical)
        XCTAssertEqual(risk(#"echo hi > "../outside.txt""#), .critical)
        XCTAssertEqual(risk("echo hi > '../outside.txt'"), .critical)
        XCTAssertEqual(risk(#"echo hi > "notes with spaces.txt""#), .execute)
        XCTAssertEqual(risk("cat /etc/passwd"), .critical)
        XCTAssertEqual(risk("cat ~/.ssh/config"), .critical)
        XCTAssertEqual(risk("cat $HOME/.ssh/config"), .critical)
        XCTAssertEqual(risk("ls ../another-project"), .critical)
        XCTAssertEqual(risk("git -C ../another-project status"), .critical)
        XCTAssertEqual(risk("clang -I/usr/local/include file.c"), .critical)
        XCTAssertEqual(risk("FOO=/private/tmp/value swift build"), .critical)
        XCTAssertEqual(risk("PATH=bin ls"), .critical)
        XCTAssertEqual(risk("env PYTHONPATH=helpers swift test"), .critical)
        XCTAssertEqual(risk("make CC=./scripts/compiler-wrapper"), .critical)
        XCTAssertEqual(risk("swift build 2>&1"), .execute)
    }

    func testRiskyFlagsAndActiveSearchFormsAreCritical() {
        XCTAssertEqual(risk("swift build --disable-sandbox"), .critical)
        XCTAssertEqual(risk("find Sources -exec sh -c 'echo x' \\;"), .critical)
        XCTAssertEqual(risk("find Sources -delete"), .critical)
        XCTAssertEqual(risk("rg --follow password Sources"), .critical)
        XCTAssertEqual(risk("grep -R password Sources"), .critical)
    }

    func testFullAccessStillGatesCommandsThatCanEscape() throws {
        let commands = [
            "project-doctor --fix",
            "python3 scripts/check.py",
            "curl https://example.com",
            "cat /etc/passwd",
            "echo secret > ../outside.txt",
        ]
        for command in commands {
            let classifiedRisk = try XCTUnwrap(
                risk(command),
                "expected a permitted risk for \(command)"
            )
            XCTAssertEqual(classifiedRisk, .critical, command)
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: .fullAccess, risk: classifiedRisk),
                .requireApproval,
                "full access must still ask before \(command)"
            )
        }
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
