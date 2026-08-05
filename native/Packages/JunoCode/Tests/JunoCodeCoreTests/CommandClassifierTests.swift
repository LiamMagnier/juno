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
        // Outside the workspace, so it is judged by the path rather than by
        // being unrecognised — see `testAPathQualifiedProgramIsJudgedByWhereItPoints`.
        XCTAssertEqual(risk("/tmp/project-doctor --fix"), .destructive)
        XCTAssertEqual(risk("python3 scripts/check.py --verbose"), .critical)
        XCTAssertEqual(risk("node scripts/check.js"), .critical)
        // `ruby -e` moved to .destructive — see testInlineInterpreterProgramsEscapeTheClassifier.
        XCTAssertEqual(risk("java -jar tools/check.jar"), .critical)
        XCTAssertEqual(risk("npx eslint ."), .critical)
        XCTAssertEqual(risk("swift run Tool"), .critical)
        XCTAssertEqual(risk("swift script.swift"), .critical)
    }

    func testInlineInterpreterProgramsEscapeTheClassifier() {
        // Running a file from the workspace is ordinary development: the code is
        // from the folder the session was granted, which is what `critical`
        // means and why full access proceeds without asking.
        XCTAssertEqual(risk("python3 scripts/check.py"), .critical)
        XCTAssertEqual(risk("node build.js --watch"), .critical)
        XCTAssertEqual(risk("bash scripts/deploy.sh"), .critical)

        // An INLINE program is different in kind. The string is written by the
        // model, not read from the workspace, and every rule in the classifier
        // is blind to its contents — an rm -rf, a chmod, a curl | sh inside it
        // is never seen. That escapes the workspace boundary, so it is
        // `destructive` and asks in every mode, full access included.
        XCTAssertEqual(risk("python3 -c 'import os; os.system(\"rm -rf /\")'"), .destructive)
        XCTAssertEqual(risk("node -e 'require(\"child_process\").exec(\"whoami\")'"), .destructive)
        XCTAssertEqual(risk("bash -c 'rm -rf ~'"), .destructive)
        XCTAssertEqual(risk("ruby -e 'puts 1'"), .destructive)
        XCTAssertEqual(risk("perl -e 'print 1'"), .destructive)
        XCTAssertEqual(risk("sh -lc 'echo hi'"), .destructive)
        XCTAssertEqual(risk("deno --eval 'console.log(1)'"), .destructive)
        XCTAssertEqual(risk("node --eval=\'console.log(1)\'"), .destructive)
    }

    /// The same letters mean unrelated things to different interpreters, and
    /// `.destructive` asks for approval in EVERY mode — full access included. So
    /// a shared flag set does not just mis-label these, it stops an agent dead on
    /// the commands a TypeScript or Java repo runs on nearly every turn.
    func testFlagsThatOnlyLookLikeInlinePrograms() {
        // -cp is the classpath; -c/-p are config and project files.
        XCTAssertEqual(risk("java -cp build/classes Main"), .critical)
        XCTAssertEqual(risk("npx tsc -p tsconfig.json"), .critical)
        XCTAssertEqual(risk("npx eslint . -c .eslintrc.json"), .critical)
        XCTAssertEqual(risk("npx jest -c jest.config.js"), .critical)
        XCTAssertEqual(risk("deno -c deno.json run main.ts"), .critical)
        // -p here selects a pytest plugin, -E ignores PYTHONPATH; neither is code.
        XCTAssertEqual(risk("python3 -m pytest -p no:cacheprovider"), .critical)
        XCTAssertEqual(risk("python3 -E scripts/check.py"), .critical)
        // perl/ruby -c is `--check`: it parses the file and runs nothing at all.
        XCTAssertEqual(risk("perl -c script.pl"), .critical)
        XCTAssertEqual(risk("ruby -c app.rb"), .critical)

        // Still caught when a value-taking flag comes first, which a scan that
        // stopped at the leading flag run would walk straight past.
        XCTAssertEqual(risk("python3 -W ignore -c 'import os'"), .destructive)
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

    /// Git splits across both top tiers, and the split is the interesting part:
    /// pushing, fetching and resetting are ordinary work a full-access session
    /// carries out, while forcing, widening config scope to `--global`, invoking
    /// an external helper through `-c`, or rewriting all of history are not.
    func testGitClassification() {
        // Ordinary repository work — gated below full access, carried out by it.
        XCTAssertEqual(risk("git push origin main"), .critical)
        XCTAssertEqual(risk("git reset --hard HEAD~3"), .critical)
        XCTAssertEqual(risk("git reset --soft HEAD~1"), .critical)
        XCTAssertEqual(risk("git clean -fd"), .critical)
        XCTAssertEqual(risk("git rebase -i main"), .critical)
        XCTAssertEqual(risk("git checkout -b feature/x"), .critical)
        XCTAssertEqual(risk("git branch -D old"), .critical)
        XCTAssertEqual(risk("git branch -d old"), .critical)
        XCTAssertEqual(risk("git fetch origin"), .critical)
        XCTAssertEqual(risk("git clone https://example.com/repo.git"), .critical)
        XCTAssertEqual(risk("git made-up-subcommand"), .critical)
        XCTAssertEqual(risk("git -C sub status"), .execute)

        // Never silent, in any mode.
        XCTAssertEqual(risk("git push --force origin main"), .destructive)
        XCTAssertEqual(risk("git checkout --force main"), .destructive)
        XCTAssertEqual(risk("git -c alias.audit='!sh audit.sh' audit"), .destructive)
        XCTAssertEqual(risk("git config --global user.name Juno"), .destructive)
        XCTAssertEqual(risk("git filter-branch --all"), .destructive)
    }

    /// Fetching and installing land in the workspace; reaching another machine or
    /// changing the whole Mac's software does not.
    func testNetworkAndInstallers() {
        XCTAssertEqual(risk("curl https://example.com"), .critical)
        XCTAssertEqual(risk("wget https://example.com/x.sh"), .critical)
        XCTAssertEqual(risk("npm install left-pad"), .critical)
        XCTAssertEqual(risk("npm ci"), .critical)
        XCTAssertEqual(risk("pip install requests"), .critical)
        XCTAssertEqual(risk("cargo install ripgrep"), .critical)
        XCTAssertEqual(risk("npm run test"), .critical)
        XCTAssertEqual(risk("pnpm exec eslint ."), .critical)

        XCTAssertEqual(risk("ssh host ls"), .destructive)
        XCTAssertEqual(risk("brew install jq"), .destructive)
        XCTAssertEqual(risk("gh pr view"), .destructive)
        XCTAssertEqual(risk("docker compose up"), .destructive)
        XCTAssertEqual(risk("terraform apply"), .destructive)
    }

    /// Substitution hides code but runs it here; an inline interpreter program
    /// hides it from the classifier entirely; changing file permissions or
    /// killing a process acts on the machine.
    func testShellEscapes() {
        XCTAssertEqual(risk("echo $(cat /etc/passwd)"), .critical)
        XCTAssertEqual(risk("echo `id`"), .critical)
        // Was .critical. The `rm -rf` inside the quoted string is invisible to
        // every rule in the classifier, which is the whole reason an inline
        // program is now .destructive — see
        // testInlineInterpreterProgramsEscapeTheClassifier.
        XCTAssertEqual(risk("bash -c 'rm -rf x'"), .destructive)
        XCTAssertEqual(risk("eval ls"), .critical)
        XCTAssertEqual(risk("cat <(python3 -c 'print(1)')"), .critical)

        XCTAssertEqual(risk("chmod +x script.sh"), .destructive)
        XCTAssertEqual(risk("kill -9 1234"), .destructive)
        XCTAssertEqual(risk("osascript -e 'tell app \"Finder\"'"), .destructive)
    }

    func testPipelinesTakeTheWorstSegment() {
        XCTAssertEqual(risk("ls | grep foo"), .execute)
        XCTAssertEqual(risk("ls; curl https://x.dev"), .critical)
        XCTAssertTrue(isForbidden("ls || sudo id"))
    }

    /// Naming anything outside the granted folder is `destructive`, whatever the
    /// program is and whether it arrives as an argument, a redirect target or an
    /// environment override.
    func testEscapingThePathIsDestructive() {
        XCTAssertEqual(risk("echo hi > notes.txt"), .execute)
        XCTAssertEqual(risk(#"echo hi > "notes with spaces.txt""#), .execute)
        XCTAssertEqual(risk("swift build 2>&1"), .execute)

        XCTAssertEqual(risk("echo hi > /etc/hosts"), .destructive)
        XCTAssertEqual(risk("echo hi > ../outside.txt"), .destructive)
        XCTAssertEqual(risk(#"echo hi > "../outside.txt""#), .destructive)
        XCTAssertEqual(risk("echo hi > '../outside.txt'"), .destructive)
        XCTAssertEqual(risk("cat /etc/passwd"), .destructive)
        XCTAssertEqual(risk("cat ~/.ssh/config"), .destructive)
        XCTAssertEqual(risk("cat $HOME/.ssh/config"), .destructive)
        XCTAssertEqual(risk("ls ../another-project"), .destructive)
        XCTAssertEqual(risk("git -C ../another-project status"), .destructive)
        XCTAssertEqual(risk("clang -I/usr/local/include file.c"), .destructive)
        XCTAssertEqual(risk("FOO=/private/tmp/value swift build"), .destructive)
        XCTAssertEqual(risk("PATH=bin ls"), .destructive)
        XCTAssertEqual(risk("env PYTHONPATH=helpers swift test"), .destructive)
        XCTAssertEqual(risk("make CC=./scripts/compiler-wrapper"), .destructive)
    }

    /// A program named by path is judged by *where the path goes*, not merely by
    /// being path-qualified.
    ///
    /// This ordering is load-bearing. The escaping-path test runs before the
    /// path-qualified rule, so `/tmp/swift` is caught as leaving the workspace
    /// while `./gradlew` is recognised as a script in the folder Juno may already
    /// write to. With the old ordering both returned the same verdict, which is
    /// why running the project's own build script needed an approval.
    func testAPathQualifiedProgramIsJudgedByWhereItPoints() {
        XCTAssertEqual(risk("./gradlew build"), .critical)
        XCTAssertEqual(risk("./scripts/test.sh"), .critical)
        XCTAssertEqual(risk("bin/tool --help"), .critical)

        XCTAssertEqual(risk("/tmp/swift build"), .destructive)
    }

    func testRiskyFlagsAndActiveSearchForms() {
        XCTAssertEqual(risk("find Sources -exec sh -c 'echo x' \\;"), .critical)
        XCTAssertEqual(risk("find Sources -delete"), .critical)
        XCTAssertEqual(risk("rg --follow password Sources"), .critical)
        XCTAssertEqual(risk("grep -R password Sources"), .critical)

        XCTAssertEqual(risk("swift build --disable-sandbox"), .destructive)
    }

    /// The complaint that motivated the tier split: full access asked before most
    /// of what a coding agent does.
    ///
    /// Each of these was `critical` *and* gated in every mode, so a session set to
    /// full access stopped and waited before running the project's tests,
    /// installing its dependencies, or executing its own build script.
    func testFullAccessCarriesOutOrdinaryDevelopmentWithoutAsking() throws {
        let commands = [
            "project-doctor --fix",
            "python3 scripts/check.py",
            "curl https://example.com",
            "npm install",
            "git push origin main",
            "rm build/cache.json",
            "./scripts/test.sh",
            "just build",
            "pytest -q",
        ]
        for command in commands {
            let classifiedRisk = try XCTUnwrap(
                risk(command),
                "expected a permitted risk for \(command)"
            )
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: .fullAccess, risk: classifiedRisk),
                .allow,
                "full access must not ask before \(command)"
            )
            // Still gated one rung down, so the lower modes keep their meaning.
            XCTAssertEqual(
                PermissionPolicy.ruling(mode: .workspaceWrite, risk: classifiedRisk),
                .requireApproval,
                "workspace write must still ask before \(command)"
            )
        }
    }

    /// …and the boundary that no mode waives.
    func testFullAccessStillAsksBeforeLeavingTheWorkspace() throws {
        let commands = [
            "cat /etc/passwd",
            "echo secret > ../outside.txt",
            "ssh host ls",
            "chmod 777 script.sh",
            "kill -9 1234",
            "git push --force origin main",
            "terraform apply",
            "PATH=bin ls",
        ]
        for command in commands {
            let classifiedRisk = try XCTUnwrap(
                risk(command),
                "expected a permitted risk for \(command)"
            )
            XCTAssertEqual(classifiedRisk, .destructive, command)
            for mode in PermissionMode.allCases where mode != .readOnly {
                XCTAssertEqual(
                    PermissionPolicy.ruling(mode: mode, risk: classifiedRisk),
                    .requireApproval,
                    "\(mode) must still ask before \(command)"
                )
            }
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
