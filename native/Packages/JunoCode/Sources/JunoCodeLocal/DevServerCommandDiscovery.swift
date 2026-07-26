import Foundation

/// One command the reader can actually start, taken from the workspace rather
/// than invented.
public struct DevServerCommand: Identifiable, Hashable, Sendable {
    /// The script's name in `package.json` — `dev`, `start`, `storybook`.
    public let name: String
    /// What Juno will run, spelled for this workspace's package manager.
    public let commandLine: String
    /// The script's own body, shown so the reader can see what `dev` means here
    /// before starting it.
    public let script: String
    /// Whether the script looks like it starts a long-lived server. Used only for
    /// ordering and for choosing the default; every script is still offered.
    public let startsAServer: Bool

    public var id: String { commandLine }

    public init(name: String, commandLine: String, script: String, startsAServer: Bool) {
        self.name = name
        self.commandLine = commandLine
        self.script = script
        self.startsAServer = startsAServer
    }
}

/// What Juno found in the workspace — including finding nothing, which is a
/// result the preview states rather than papering over with a default command.
public struct DevServerCommandSet: Hashable, Sendable {
    public let commands: [DevServerCommand]
    /// `npm`, `pnpm`, `yarn` or `bun`, resolved from the lockfile. Nil when there
    /// is no `package.json`.
    public let packageManager: String?
    /// Why there is nothing to offer, in words the reader can act on. Nil when
    /// `commands` is non-empty.
    public let unavailableReason: String?

    public init(
        commands: [DevServerCommand],
        packageManager: String?,
        unavailableReason: String?
    ) {
        self.commands = commands
        self.packageManager = packageManager
        self.unavailableReason = unavailableReason
    }

    /// The command the Start button runs unless the reader picks another: the
    /// first script that looks like a server, otherwise the first script at all.
    public var suggested: DevServerCommand? {
        commands.first { $0.startsAServer } ?? commands.first
    }
}

/// Reads `package.json` to find out how *this* project starts.
///
/// The alternative — hardcoding `npm run dev` — is wrong for every project that
/// calls it `start`, `serve` or `dev:web`, and it is wrong for every workspace
/// that is not a Node project at all. So the scripts are read, ordered by how
/// much they look like a server, and offered; and when there is no
/// `package.json`, the preview says so instead of offering a command that would
/// fail.
public enum DevServerCommandDiscovery {
    /// Scans `workspaceRoot` for startable scripts.
    ///
    /// `nonisolated async` so the file read happens off the main thread: it is
    /// small, but it runs every time a preview window opens.
    public static func scan(workspaceRoot: URL) async -> DevServerCommandSet {
        let manifestURL = workspaceRoot.appendingPathComponent("package.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            return DevServerCommandSet(
                commands: [],
                packageManager: nil,
                unavailableReason:
                    "No package.json in \(workspaceRoot.lastPathComponent), so Juno cannot tell how this project starts. Start your server yourself and type its address above."
            )
        }
        guard let data = try? Data(contentsOf: manifestURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return DevServerCommandSet(
                commands: [],
                packageManager: nil,
                unavailableReason: "package.json could not be read as JSON."
            )
        }
        let manager = packageManager(in: workspaceRoot)
        guard let scripts = json["scripts"] as? [String: Any], !scripts.isEmpty else {
            return DevServerCommandSet(
                commands: [],
                packageManager: manager,
                unavailableReason: "package.json defines no scripts."
            )
        }

        let commands = scripts.compactMap { name, body -> DevServerCommand? in
            guard let script = body as? String else { return nil }
            return DevServerCommand(
                name: name,
                commandLine: invocation(manager: manager, script: name),
                script: script,
                startsAServer: startsAServer(name: name, script: script)
            )
        }
        .sorted { left, right in
            let leftRank = rank(of: left.name)
            let rightRank = rank(of: right.name)
            if leftRank != rightRank { return leftRank < rightRank }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }

        return DevServerCommandSet(
            commands: commands,
            packageManager: manager,
            unavailableReason: commands.isEmpty ? "package.json defines no scripts." : nil
        )
    }

    // MARK: - Package manager

    /// From the lockfile, because that is what the project actually uses. A
    /// `pnpm` workspace run through `npm run` resolves the wrong binaries.
    private static func packageManager(in root: URL) -> String {
        let lockfiles: [(String, String)] = [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("bun.lock", "bun"),
            ("package-lock.json", "npm"),
        ]
        for (file, manager) in lockfiles
        where FileManager.default.fileExists(atPath: root.appendingPathComponent(file).path) {
            return manager
        }
        return "npm"
    }

    private static func invocation(manager: String, script: String) -> String {
        // Yarn classic takes the script name directly; the others all accept
        // `run`, and spelling it out avoids colliding with a built-in subcommand
        // when a project names a script `test` or `publish`.
        manager == "yarn" ? "yarn \(script)" : "\(manager) run \(script)"
    }

    // MARK: - Ranking

    /// Lower sorts first. Names people actually use for the thing they want to
    /// look at, then anything whose body launches a known dev server, then the
    /// rest of the scripts in alphabetical order.
    private static func rank(of name: String) -> Int {
        let preferred = ["dev", "start", "serve", "preview", "develop", "watch"]
        if let index = preferred.firstIndex(of: name.lowercased()) { return index }
        if name.lowercased().hasPrefix("dev:") || name.lowercased().hasPrefix("start:") {
            return preferred.count
        }
        return preferred.count + 1
    }

    private static func startsAServer(name: String, script: String) -> Bool {
        let lowercasedName = name.lowercased()
        if ["dev", "start", "serve", "preview", "develop", "storybook"].contains(lowercasedName) {
            return true
        }
        if lowercasedName.hasPrefix("dev:") || lowercasedName.hasPrefix("start:") { return true }
        let body = script.lowercased()
        return serverBinaries.contains { body.contains($0) }
    }

    /// Bodies that mean "this stays up and serves something". Matched as
    /// substrings of the script because they are almost always wrapped
    /// (`cross-env NODE_ENV=development next dev -p 4000`).
    private static let serverBinaries = [
        "next dev", "next start", "vite", "react-scripts start", "webpack serve",
        "webpack-dev-server", "nodemon", "astro dev", "nuxt dev", "nuxt start",
        "remix dev", "ng serve", "gatsby develop", "http-server", "live-server",
        "serve ", "parcel", "svelte-kit dev", "vue-cli-service serve", "expo start",
        "rails server", "rails s", "manage.py runserver", "uvicorn", "flask run",
        "php artisan serve", "hugo server", "jekyll serve", "docusaurus start",
    ]
}
