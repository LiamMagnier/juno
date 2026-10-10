import Foundation

/// Proposes a first `.juno/launch.json` from what the project is
/// (CODE_AGENT_SPEC §4.2, PV-10, PV-16).
///
/// Node scripts (the existing `package.json` scan, nested packages to depth 3),
/// Django, Flask, FastAPI, Rails, PHP, Hugo, Go, and static sites as
/// `juno:static`. Nothing here starts anything: the proposal is shown to the
/// reader, who saves it as the file, and after that the file is the only
/// source of truth. Until then the registry offers these as discovered
/// configurations, each asked about by its bytes before it runs.
public enum LaunchConfigurationDiscovery {
    static let maximumPackageDepth = 3
    static let maximumPackageCount = 48
    static let ignoredDirectoryNames: Set<String> = [
        ".git", ".hg", ".svn", ".next", ".nuxt", ".turbo", ".cache",
        "node_modules", "vendor", "Pods", "DerivedData", "build", "dist",
        "coverage", ".venv", "venv", "__pycache__", "target",
    ]

    /// The configurations Juno would write for `workspaceRoot`.
    public static func propose(workspaceRoot: URL) -> PreviewLaunchFile {
        let root = workspaceRoot.resolvingSymlinksInPath().standardizedFileURL
        var configurations: [PreviewLaunchConfiguration] = []
        configurations += nodeConfigurations(root: root)
        configurations += pythonConfigurations(root: root)
        configurations += railsConfigurations(root: root)
        configurations += phpConfigurations(root: root)
        configurations += hugoConfigurations(root: root)
        configurations += goConfigurations(root: root)
        if configurations.isEmpty, let site = staticConfiguration(root: root) {
            configurations.append(site)
        }
        var seen: Set<String> = []
        configurations = configurations.filter { seen.insert($0.name).inserted }
        return PreviewLaunchFile(configurations: configurations)
    }

    // MARK: - Node

    static func nodeConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        let packages = packageRoots(in: root)
        guard !packages.isEmpty else { return [] }
        let rootManager = lockfileManager(in: root)
        var result: [PreviewLaunchConfiguration] = []
        for package in packages {
            guard let scripts = scripts(in: package) else { continue }
            let manager = package == root ? (lockfileManager(in: package) ?? "npm") : (rootManager ?? lockfileManager(in: package) ?? "npm")
            let relative = relativePath(of: package, under: root)
            let servers = scripts
                .filter { DevServerCommandDiscovery.looksLikeServer(name: $0.key, script: $0.value) && !isOneShot(name: $0.key, script: $0.value) }
                .sorted { DevServerCommandDiscovery.rank(of: $0.key) < DevServerCommandDiscovery.rank(of: $1.key)
                    || (DevServerCommandDiscovery.rank(of: $0.key) == DevServerCommandDiscovery.rank(of: $1.key) && $0.key < $1.key) }
            for (script, body) in servers {
                let name = relative == "." ? script : "\(relative) \(script)"
                let hint = NodeServerHint.read(script: body, package: package)
                var arguments = manager == "yarn" ? [script] : ["run", script]
                if hint.appendsPortFlag {
                    // npm needs `--` to pass flags to the script; pnpm, yarn
                    // and bun pass them as they are (pnpm would hand a `--`
                    // on to the script, where it ends the options).
                    arguments += (manager == "npm" ? ["--"] : []) + ["--port", "${port}"]
                }
                result.append(PreviewLaunchConfiguration(
                    name: name,
                    runtimeExecutable: manager,
                    runtimeArgs: arguments,
                    cwd: relative == "." ? nil : relative,
                    port: hint.port,
                    // A port the script or config pins is the server's own:
                    // when it is taken, the pane asks rather than guessing.
                    autoPort: hint.isPinned ? nil : true
                ))
            }
        }
        return result
    }

    /// A build, test or lint script that mentions a server's binary
    /// (`vite build`, `next lint`) but finishes rather than serves.
    static func isOneShot(name: String, script: String) -> Bool {
        let lowered = name.lowercased()
        let prefixes = ["build", "test", "lint", "typecheck", "type-check", "format", "check", "clean", "deploy", "export"]
        if prefixes.contains(where: { lowered == $0 || lowered.hasPrefix($0 + ":") }) { return true }
        let body = script.lowercased()
        return [" build", " lint", " export", " test"].contains { body.hasPrefix(String($0.dropFirst())) || body.contains($0) }
            && !["dev", "serve", "start", "preview", "watch"].contains(where: { body.contains($0) })
    }

    static func scripts(in package: URL) -> [String: String]? {
        guard let data = try? Data(contentsOf: package.appendingPathComponent("package.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scripts = json["scripts"] as? [String: Any]
        else { return nil }
        return scripts.compactMapValues { $0 as? String }
    }

    static func lockfileManager(in root: URL) -> String? {
        let lockfiles: [(String, String)] = [
            ("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"),
            ("bun.lock", "bun"), ("package-lock.json", "npm"),
        ]
        return lockfiles.first { exists(root, $0.0) }?.1
    }

    /// Folders holding a `package.json`, the root first, to depth 3.
    static func packageRoots(in root: URL) -> [URL] {
        var roots: [URL] = []
        if exists(root, "package.json") { roots.append(root) }
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return roots }
        while let candidate = enumerator.nextObject() as? URL {
            let name = candidate.lastPathComponent
            if ignoredDirectoryNames.contains(name) {
                enumerator.skipDescendants()
                continue
            }
            let depth = candidate.pathComponents.count - root.pathComponents.count
            if depth > maximumPackageDepth + 1 {
                enumerator.skipDescendants()
                continue
            }
            guard name == "package.json" else { continue }
            let folder = candidate.deletingLastPathComponent().standardizedFileURL
            guard folder.path != root.path else { continue }
            roots.append(folder)
            if roots.count >= maximumPackageCount { break }
        }
        return roots.sorted { left, right in
            if left.path == root.path { return true }
            if right.path == root.path { return false }
            return left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }

    // MARK: - Python

    static func pythonConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        let runner = pythonRunner(root: root)
        let dependencies = pythonDependencies(root: root)
        if exists(root, "manage.py") {
            return [PreviewLaunchConfiguration(
                name: "django",
                runtimeExecutable: runner.executable,
                runtimeArgs: runner.prefix + ["manage.py", "runserver", "127.0.0.1:${port}"],
                port: 8000,
                autoPort: true
            )]
        }
        if dependencies.contains("fastapi") {
            let module = exists(root, "main.py") ? "main:app" : (exists(root, "app/main.py") ? "app.main:app" : nil)
            if let module {
                return [PreviewLaunchConfiguration(
                    name: "fastapi",
                    runtimeExecutable: runner.executable,
                    runtimeArgs: runner.prefix + ["-m", "uvicorn", module, "--host", "127.0.0.1", "--port", "${port}", "--reload"],
                    port: 8000,
                    autoPort: true
                )]
            }
        }
        let importsFlask = (try? String(contentsOf: root.appendingPathComponent("app.py"), encoding: .utf8))
            .map { $0.contains("from flask") || $0.contains("import flask") } ?? false
        if dependencies.contains("flask") || importsFlask, exists(root, "app.py") || exists(root, "wsgi.py") {
            return [PreviewLaunchConfiguration(
                name: "flask",
                runtimeExecutable: runner.executable,
                runtimeArgs: runner.prefix + ["-m", "flask", "run", "--host", "127.0.0.1", "--port", "${port}", "--debug"],
                port: 5000,
                autoPort: true
            )]
        }
        return []
    }

    /// `uv run python`, `poetry run python` or `python3`, from the lockfile.
    static func pythonRunner(root: URL) -> (executable: String, prefix: [String]) {
        if exists(root, "uv.lock") { return ("uv", ["run", "python"]) }
        if exists(root, "poetry.lock") { return ("poetry", ["run", "python"]) }
        return ("python3", [])
    }

    static func pythonDependencies(root: URL) -> Set<String> {
        var text = ""
        for file in ["requirements.txt", "pyproject.toml", "Pipfile", "requirements-dev.txt"] {
            if let contents = try? String(contentsOf: root.appendingPathComponent(file), encoding: .utf8) {
                text += contents.lowercased() + "\n"
            }
        }
        var found: Set<String> = []
        for name in ["django", "flask", "fastapi", "uvicorn"] where text.range(
            of: "(^|[^a-z0-9_-])\(name)([^a-z0-9_-]|$)", options: .regularExpression
        ) != nil {
            found.insert(name)
        }
        return found
    }

    // MARK: - Rails, PHP, Hugo, Go

    static func railsConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        guard let gemfile = try? String(contentsOf: root.appendingPathComponent("Gemfile"), encoding: .utf8),
              gemfile.range(of: #"gem\s+["']rails["']"#, options: .regularExpression) != nil
        else { return [] }
        let executable = exists(root, "bin/rails") ? "bin/rails" : "rails"
        return [PreviewLaunchConfiguration(
            name: "rails",
            runtimeExecutable: executable,
            runtimeArgs: ["server", "-b", "127.0.0.1", "-p", "${port}"],
            port: 3000,
            autoPort: true
        )]
    }

    static func phpConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        if exists(root, "artisan") {
            return [PreviewLaunchConfiguration(
                name: "laravel",
                runtimeExecutable: "php",
                runtimeArgs: ["artisan", "serve", "--host=127.0.0.1", "--port=${port}"],
                port: 8000,
                autoPort: true
            )]
        }
        for folder in [".", "public"] where exists(root, folder == "." ? "index.php" : "public/index.php") {
            return [PreviewLaunchConfiguration(
                name: "php",
                runtimeExecutable: "php",
                runtimeArgs: ["-S", "127.0.0.1:${port}"] + (folder == "." ? [] : ["-t", "public"]),
                port: 8000,
                autoPort: true
            )]
        }
        return []
    }

    static func hugoConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        let configs = ["hugo.toml", "hugo.yaml", "hugo.json"]
        let isHugo = configs.contains { exists(root, $0) }
            || (exists(root, "config.toml") && exists(root, "content") && (exists(root, "themes") || exists(root, "layouts")))
        guard isHugo else { return [] }
        return [PreviewLaunchConfiguration(
            name: "hugo",
            runtimeExecutable: "hugo",
            runtimeArgs: ["server", "--bind", "127.0.0.1", "--port", "${port}"],
            port: 1313,
            autoPort: true
        )]
    }

    static func goConfigurations(root: URL) -> [PreviewLaunchConfiguration] {
        guard exists(root, "go.mod"), exists(root, "main.go"),
              let main = try? String(contentsOf: root.appendingPathComponent("main.go"), encoding: .utf8),
              main.contains("net/http") || main.contains("ListenAndServe") || main.contains("gin") || main.contains("echo")
        else { return [] }
        return [PreviewLaunchConfiguration(
            name: "go",
            runtimeExecutable: "go",
            runtimeArgs: ["run", "."],
            port: 8080,
            autoPort: true
        )]
    }

    // MARK: - Static

    /// A static site served by Juno itself, from the folder that holds its
    /// `index.html` (PV-16: never the repository root when the page is in
    /// `public/`).
    static func staticConfiguration(root: URL) -> PreviewLaunchConfiguration? {
        for folder in [".", "public", "site", "docs"] {
            let index = folder == "." ? "index.html" : "\(folder)/index.html"
            if exists(root, index) {
                return PreviewLaunchConfiguration(
                    name: "static",
                    runtimeExecutable: ResolvedPreviewConfiguration.staticExecutable,
                    cwd: folder == "." ? nil : folder
                )
            }
        }
        return nil
    }

    // MARK: - Xcode

    /// An Xcode project or workspace at the top or one level down: an app
    /// for the Simulator, which the Preview offers to open instead.
    public static func hasXcodeProject(root: URL) -> Bool {
        let manager = FileManager.default
        func hasProject(_ url: URL) -> Bool {
            let names = (try? manager.contentsOfDirectory(atPath: url.path)) ?? []
            return names.contains { $0.hasSuffix(".xcodeproj") || $0.hasSuffix(".xcworkspace") }
        }
        if hasProject(root) { return true }
        let children = (try? manager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        )) ?? []
        return children.prefix(40).contains { child in
            !ignoredDirectoryNames.contains(child.lastPathComponent)
                && (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
                && hasProject(child)
        }
    }

    // MARK: - Helpers

    static func exists(_ root: URL, _ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
    }

    static func relativePath(of folder: URL, under root: URL) -> String {
        let path = folder.resolvingSymlinksInPath().standardizedFileURL.path
        guard path != root.path else { return "." }
        if path.hasPrefix(root.path + "/") { return String(path.dropFirst(root.path.count + 1)) }
        return folder.lastPathComponent
    }
}

/// What a `package.json` script says about its server's port: a port the
/// script or the framework's config pins, else the framework's default, and
/// whether `--port ${port}` can be appended so Alevr chooses a free one.
struct NodeServerHint: Equatable {
    var port: Int?
    /// The script or a config file names the port.
    var isPinned: Bool
    var appendsPortFlag: Bool

    struct Framework {
        let tokens: [String]
        let defaultPort: Int
        /// Takes `--port N`. False for servers that read `PORT` instead,
        /// which Alevr sets.
        let takesPortFlag: Bool
        let configFiles: [String]
    }

    /// Most specific first: `vite preview` before `vite`.
    static let frameworks: [Framework] = [
        Framework(tokens: ["vite preview"], defaultPort: 4173, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["astro dev", "astro preview", "astro"], defaultPort: 4321, takesPortFlag: true,
                  configFiles: ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.mts"]),
        Framework(tokens: ["vite", "svelte-kit dev", "remix vite:dev", "react-router dev"], defaultPort: 5173, takesPortFlag: true,
                  configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs"]),
        Framework(tokens: ["next dev", "next start", "next"], defaultPort: 3000, takesPortFlag: false, configFiles: []),
        Framework(tokens: ["nuxi dev", "nuxt dev", "nuxt start", "nuxi preview"], defaultPort: 3000, takesPortFlag: false, configFiles: []),
        Framework(tokens: ["react-scripts start"], defaultPort: 3000, takesPortFlag: false, configFiles: []),
        Framework(tokens: ["remix dev", "remix-serve"], defaultPort: 3000, takesPortFlag: false, configFiles: []),
        Framework(tokens: ["ng serve"], defaultPort: 4200, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["gatsby develop"], defaultPort: 8000, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["docusaurus start"], defaultPort: 3000, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["storybook dev", "start-storybook"], defaultPort: 6006, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["vue-cli-service serve"], defaultPort: 8080, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["webpack serve", "webpack-dev-server"], defaultPort: 8080, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["eleventy --serve", "@11ty/eleventy --serve"], defaultPort: 8080, takesPortFlag: true, configFiles: []),
        Framework(tokens: ["parcel"], defaultPort: 1234, takesPortFlag: true, configFiles: []),
    ]

    static func read(script: String, package: URL) -> NodeServerHint {
        let body = script.trimmingCharacters(in: .whitespaces)
        if let port = explicitPort(in: body) {
            return NodeServerHint(port: port, isPinned: true, appendsPortFlag: false)
        }
        guard let framework = framework(of: body) else {
            return NodeServerHint(port: nil, isPinned: false, appendsPortFlag: false)
        }
        for file in framework.configFiles {
            if let text = try? String(contentsOf: package.appendingPathComponent(file), encoding: .utf8),
               let port = configuredPort(in: text)
            {
                return NodeServerHint(port: port, isPinned: true, appendsPortFlag: false)
            }
        }
        return NodeServerHint(
            port: framework.defaultPort,
            isPinned: false,
            appendsPortFlag: framework.takesPortFlag && isSingleCommand(body)
        )
    }

    static func framework(of body: String) -> Framework? {
        let lowered = " " + body.lowercased() + " "
        return frameworks.first { framework in
            framework.tokens.contains { token in
                lowered.range(of: "(^|[\\s/])\(NSRegularExpression.escapedPattern(for: token))(\\s|$)", options: .regularExpression) != nil
            }
        }
    }

    /// `--port 4000`, `--port=4000`, `-p 4000`, or `PORT=4000 next dev`.
    static func explicitPort(in body: String) -> Int? {
        let patterns = [#"(?:^|\s)--port[= ](\d{2,5})\b"#, #"(?:^|\s)-p[= ]?(\d{2,5})\b"#, #"(?:^|\s)PORT=(\d{2,5})\b"#]
        for pattern in patterns {
            guard let expression = try? NSRegularExpression(pattern: pattern),
                  let match = expression.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)),
                  let range = Range(match.range(at: 1), in: body),
                  let port = Int(body[range]), (1...65_535).contains(port)
            else { continue }
            return port
        }
        return nil
    }

    /// `server: { port: 3001 }` in a Vite or Astro config.
    static func configuredPort(in text: String) -> Int? {
        guard let expression = try? NSRegularExpression(pattern: #"server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})"#),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text)
        else { return nil }
        return Int(text[range])
    }

    /// One command, so a flag appended after it reaches the server.
    static func isSingleCommand(_ body: String) -> Bool {
        let lowered = body.lowercased()
        if ["&&", "||", "|", ";", "&"].contains(where: { lowered.contains($0) }) { return false }
        return !["concurrently", "run-p", "run-s", "npm-run-all", "turbo", "nx ", "lerna"].contains { lowered.contains($0) }
    }
}
