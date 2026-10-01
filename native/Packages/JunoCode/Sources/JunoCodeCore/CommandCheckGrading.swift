import Foundation

// Check grading: whether a command line is a build, test, lint or typecheck
// whose exit code says pass or fail (CODE_AGENT_SPEC §1.8).
//
// A grade only decides whether a command's result counts as evidence that a
// change works. It never changes the risk tier the classifier gives the same
// command, and it never makes a command run without asking.
//
// Kept apart from the risk rules in CommandClassifier.swift on purpose: they
// answer "how dangerous is this", this answers "what does it prove".

public extension CommandClassifier {
    /// The kind of check `commandLine` is, or nil when its exit code would
    /// not mean pass or fail for a check.
    ///
    /// Only a chain joined by `&&` counts, optionally after `cd <folder>`:
    /// a pipe reports its last command's status (`npm test | tail` passes
    /// when the tests fail), `;` and `||` throw the status away, and `&`
    /// never waits for it. A line that runs a command from inside itself is
    /// not graded either. In a chain of checks the last one names the kind.
    func checkKind(of commandLine: String) -> CheckKind? {
        let trimmed = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 4_096,
              let tokens = ShellTokenizer.tokenize(trimmed),
              !tokens.contains(where: { $0.containsSubstitution })
        else { return nil }
        var segments: [[String]] = [[]]
        for token in tokens {
            switch token.kind {
            case .controlOperator:
                guard token.text == "&&" else { return nil }
                segments.append([])
            case .word:
                segments[segments.count - 1].append(token.text)
            case .redirect:
                continue
            }
        }
        var kind: CheckKind?
        for words in segments {
            guard !words.isEmpty else { return nil }
            if words.first == "cd" {
                // Into a folder of the workspace only: a pass from
                // `cd /some/other/project && npm test` says nothing about this
                // change, and a bare `cd` goes home.
                guard words.count == 2, Self.isWorkspaceRelativeFolder(words[1]) else { return nil }
                continue
            }
            guard let graded = Self.gradeSegment(words) else { return nil }
            kind = graded
        }
        return kind
    }

    /// A relative folder that stays below where the command starts.
    internal static func isWorkspaceRelativeFolder(_ folder: String) -> Bool {
        guard !folder.isEmpty, !folder.hasPrefix("/"), !folder.hasPrefix("~"), !folder.hasPrefix("-"),
              !folder.contains("$")
        else { return false }
        return !folder.split(separator: "/").contains("..")
    }

    /// One simple command's grade.
    internal static func gradeSegment(_ segmentWords: [String]) -> CheckKind? {
        var words = segmentWords
        // `CI=1 npm test`, `env CI=1 npm test`
        while let first = words.first, first.contains("="), !first.hasPrefix("="), !first.hasPrefix("-") {
            words.removeFirst()
        }
        if words.first == "env" {
            words.removeFirst()
            while let first = words.first, first.contains("=") || first.hasPrefix("-") { words.removeFirst() }
        }
        guard let raw = words.first else { return nil }
        let program = raw.split(separator: "/").last.map(String.init) ?? raw
        let arguments = Array(words.dropFirst())
        let positional = arguments.filter { !$0.hasPrefix("-") }

        switch program {
        // Runners that run another program: grade what they run.
        case "npx", "bunx", "pnpx":
            return gradeSegment(Array(arguments.drop { $0.hasPrefix("-") }))
        case "uv", "poetry", "pipenv", "bundle", "pdm", "hatch", "rye":
            // `uv run pytest`, `bundle exec rspec`
            guard let sub = positional.first, ["run", "exec"].contains(sub),
                  let index = arguments.firstIndex(of: sub)
            else { return nil }
            return gradeSegment(Array(arguments[(index + 1)...]))
        case "npm", "pnpm", "yarn", "bun":
            return gradePackageScript(program: program, arguments: arguments, positional: positional)
        case "vitest":
            // A watcher otherwise; under run_command there is no terminal and
            // vitest runs once, but say so explicitly where it is written.
            if positional.first == "run" || arguments.contains("--run") || positional.isEmpty { return .test }
            if positional.first == "related" && arguments.contains("--run") { return .test }
            return nil
        case "jest", "mocha", "ava", "tap", "karma":
            return arguments.contains("--watch") || arguments.contains("--watchAll") ? nil : .test
        case "playwright", "cypress":
            return positional.first == "test" || positional.first == "run" ? .test : nil
        case "tsc", "vue-tsc":
            return arguments.contains("--noEmit") ? .typecheck : (arguments.contains("--watch") || arguments.contains("-w") ? nil : .build)
        case "eslint", "stylelint", "oxlint", "swiftlint", "rubocop", "flake8", "pylint", "staticcheck",
             "shellcheck", "ktlint", "detekt", "hadolint":
            // With `--fix` too: what it could not fix still fails the run.
            return .lint
        case "biome":
            return ["check", "lint", "ci"].contains(positional.first ?? "") ? .lint : nil
        case "prettier":
            return arguments.contains("--check") ? .lint : nil
        case "black":
            return arguments.contains("--check") ? .lint : nil
        case "ruff":
            return positional.first == "check" ? .lint : (positional.first == "format" && arguments.contains("--check") ? .lint : nil)
        case "mypy", "pyright", "basedpyright", "pyre":
            return .typecheck
        case "pytest", "py.test", "tox", "nox", "nosetests", "rspec":
            return .test
        case "python", "python3":
            guard arguments.first == "-m", arguments.count >= 2 else { return nil }
            return ["pytest", "unittest", "tox", "nose"].contains(arguments[1]) ? .test
                : (["mypy", "pyright"].contains(arguments[1]) ? .typecheck : (["ruff", "flake8", "pylint"].contains(arguments[1]) ? .lint : nil))
        case "xcodebuild":
            if arguments.contains("test") || arguments.contains("test-without-building") { return .test }
            if arguments.contains("build") || arguments.contains("build-for-testing") { return .build }
            if arguments.contains("analyze") { return .lint }
            return nil
        case "swift":
            switch positional.first {
            case "test": return .test
            case "build": return .build
            default: return nil
            }
        case "go":
            switch positional.first {
            case "test": return .test
            case "vet": return .lint
            case "build": return .build
            default: return nil
            }
        case "golangci-lint":
            return positional.first == "run" ? .lint : nil
        case "cargo":
            switch positional.first {
            case "test", "nextest": return .test
            case "clippy": return .lint
            case "check": return .typecheck
            case "build": return .build
            default: return nil
            }
        case "make", "gmake", "just", "task":
            // Every target named must be a check: `make test deploy` runs the
            // deploy too.
            let valueOptions: Set<String> = [
                "-C", "-f", "-j", "-l", "-I", "-o", "-W", "--directory", "--file", "--makefile",
                "-d", "--working-directory", "--justfile", "-t", "--taskfile", "--dir",
            ]
            return gradeTargets(targets(arguments, valueOptions: valueOptions).filter { !$0.contains("=") })
        case "gradle", "gradlew":
            let valueOptions: Set<String> = [
                "--tests", "-x", "--exclude-task", "-p", "--project-dir", "--console", "-b", "--build-file",
                "-c", "--settings-file", "--warning-mode", "--max-workers", "-g", "--gradle-user-home",
                "-I", "--init-script", "--include-build",
            ]
            return gradeTargets(targets(arguments, valueOptions: valueOptions).map {
                $0.split(separator: ":").last.map(String.init) ?? $0
            })
        case "mvn", "mvnw":
            // `deploy`, `release:perform` and `site-deploy` publish, whatever
            // else the line builds.
            if positional.contains(where: { $0.contains("deploy") || $0.hasPrefix("release") }) { return nil }
            if positional.contains("test") || positional.contains("verify") { return .test }
            if positional.contains("package") || positional.contains("compile") || positional.contains("install") {
                return .build
            }
            return nil
        case "dotnet":
            switch positional.first {
            case "test": return .test
            case "build": return .build
            default: return nil
            }
        case "mix":
            switch positional.first {
            case "test": return .test
            case "compile": return .build
            case "credo": return .lint
            case "dialyzer": return .typecheck
            default: return nil
            }
        case "rake":
            return positional.first == "test" || positional.first == "spec" ? .test : nil
        case "deno":
            switch positional.first {
            case "test": return .test
            case "check": return .typecheck
            case "lint": return .lint
            default: return nil
            }
        case "next":
            return positional.first == "lint" ? .lint : (positional.first == "build" ? .build : nil)
        case "vite":
            return positional.first == "build" ? .build : nil
        default:
            return nil
        }
    }

    /// `npm test`, `pnpm run lint`, `yarn typecheck`, `bun test`.
    private static func gradePackageScript(program: String, arguments: [String], positional: [String]) -> CheckKind? {
        guard let first = positional.first else { return nil }
        var script: String?
        switch first {
        case "test", "t", "tst":
            return .test
        case "run", "run-script":
            script = positional.dropFirst().first
        case "exec", "dlx", "x":
            guard let index = arguments.firstIndex(of: first) else { return nil }
            return gradeSegment(Array(arguments[(index + 1)...].drop { $0.hasPrefix("-") }))
        default:
            // `yarn lint` and `pnpm lint` run the script; `bun vitest` runs
            // the binary.
            guard program == "yarn" || program == "pnpm" || program == "bun" else { return nil }
            if let kind = gradeScriptName(first) { return kind }
            return gradeSegment(Array(positional))
        }
        return script.flatMap(gradeScriptName)
    }

    /// A package script's grade, from its name.
    internal static func gradeScriptName(_ name: String) -> CheckKind? {
        let lower = name.lowercased()
        if lower.contains("watch") || lower.contains("dev") || lower.hasSuffix(":fix") || lower == "start" || lower == "serve" {
            return nil
        }
        let base = lower.split(separator: ":").first.map(String.init) ?? lower
        switch base {
        case "test", "tests", "unit", "e2e", "spec", "vitest", "jest":
            return .test
        case "typecheck", "type-check", "tsc", "types", "check-types", "typecheck-all":
            return .typecheck
        case "lint", "eslint", "stylelint", "format-check":
            return .lint
        case "build", "compile":
            return .build
        case "check":
            return .test
        default:
            return nil
        }
    }

    /// A make, just or Gradle target's grade.
    private static func gradeTarget(_ target: String?) -> CheckKind? {
        guard let target else { return nil }
        switch target {
        case "test", "tests", "check", "unit", "unittest", "spec": return .test
        case "lint": return .lint
        case "typecheck", "type-check", "types": return .typecheck
        case "build", "all", "compile", "assemble": return .build
        default: return nil
        }
    }

    /// The targets or tasks a build tool is asked to run: its positional
    /// words, without the values of options that take one (`make -C web
    /// test`, `./gradlew test --tests FooTest`).
    private static func targets(_ arguments: [String], valueOptions: Set<String>) -> [String] {
        var result: [String] = []
        var skipNext = false
        for argument in arguments {
            if skipNext {
                skipNext = false
                continue
            }
            if argument.hasPrefix("-") {
                skipNext = valueOptions.contains(argument)
                continue
            }
            result.append(argument)
        }
        return result
    }

    /// The grade of a list of targets: each a check (a leading `clean` is
    /// housekeeping), the last naming the kind.
    private static func gradeTargets(_ targets: [String]) -> CheckKind? {
        let named = targets.filter { $0 != "clean" }
        guard !named.isEmpty else { return nil }
        var kind: CheckKind?
        for target in named {
            guard let graded = gradeTarget(target) else { return nil }
            kind = graded
        }
        return kind
    }
}
