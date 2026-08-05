import Foundation

/// The exact command lines Juno Simulator runs, built as data.
///
/// Command *formation* is separated from command *execution* because forming a
/// build invocation is the part that is easy to get subtly wrong (a missing
/// `-destination`, derived data pointed at the user's global cache, a scheme
/// name with a space) and the part that is trivial to test. Nothing here spawns
/// a process; nothing here takes a string from the model or from a task prompt.
///
/// Everything is `xcrun`-based and public: `xcodebuild` and `simctl` are the
/// supported command-line interfaces Apple ships with Xcode. No private
/// framework is linked, and no undocumented protocol is spoken.
public enum SimulatorCommands {
    /// Arguments are always an array — never an interpolated shell string — so a
    /// project path or scheme name containing a space, a quote or a semicolon is
    /// an argument and can never become a second command.
    public struct Invocation: Equatable, Sendable {
        public let executable: String
        public let arguments: [String]
        public let currentDirectory: String?

        public init(executable: String = "/usr/bin/xcrun", arguments: [String], currentDirectory: String? = nil) {
            self.executable = executable
            self.arguments = arguments
            self.currentDirectory = currentDirectory
        }

        /// Display form for the build log. Quoted for readability only — it is
        /// never parsed back or executed.
        public var displayLine: String {
            ([executable] + arguments)
                .map { $0.contains(" ") ? "\"\($0)\"" : $0 }
                .joined(separator: " ")
        }
    }

    // MARK: Discovery

    public static func xcodeSelectPath() -> Invocation {
        Invocation(executable: "/usr/bin/xcode-select", arguments: ["-p"])
    }

    public static func xcodebuildVersion() -> Invocation {
        Invocation(arguments: ["xcodebuild", "-version"])
    }

    /// Schemes and targets for a container, as JSON.
    public static func listSchemes(project: XcodeProject) -> Invocation {
        var arguments = ["xcodebuild", "-list", "-json"]
        arguments.append(contentsOf: project.buildContainerArguments)
        return Invocation(
            arguments: arguments,
            currentDirectory: project.kind == .swiftPackage ? project.path : nil
        )
    }

    /// Build settings for one scheme against the simulator SDK. `-json` gives a
    /// structured answer, which is what lets the built `.app` be *read* rather
    /// than guessed from a conventional derived-data path.
    public static func showBuildSettings(
        project: XcodeProject,
        scheme: String,
        configuration: String,
        derivedDataPath: String
    ) -> Invocation {
        var arguments = ["xcodebuild", "-showBuildSettings", "-json"]
        arguments.append(contentsOf: project.buildContainerArguments)
        arguments.append(contentsOf: [
            "-scheme", scheme,
            "-configuration", configuration,
            "-sdk", "iphonesimulator",
            "-derivedDataPath", derivedDataPath,
        ])
        return Invocation(
            arguments: arguments,
            currentDirectory: project.kind == .swiftPackage ? project.path : nil
        )
    }

    // MARK: simctl

    public static func listRuntimes() -> Invocation {
        Invocation(arguments: ["simctl", "list", "runtimes", "--json"])
    }

    public static func listDevices() -> Invocation {
        Invocation(arguments: ["simctl", "list", "devices", "--json"])
    }

    public static func boot(udid: String) -> Invocation {
        Invocation(arguments: ["simctl", "boot", udid])
    }

    /// Blocks until the device finishes booting. Far better than polling
    /// `simctl list` — the device reports `Booted` before its services are up,
    /// and installing into that window fails intermittently.
    public static func waitForBoot(udid: String) -> Invocation {
        Invocation(arguments: ["simctl", "bootstatus", udid, "-b"])
    }

    public static func shutdown(udid: String) -> Invocation {
        Invocation(arguments: ["simctl", "shutdown", udid])
    }

    public static func install(udid: String, appPath: String) -> Invocation {
        Invocation(arguments: ["simctl", "install", udid, appPath])
    }

    public static func launch(udid: String, bundleID: String) -> Invocation {
        // `--console-pty` is deliberately NOT used: it makes launch block for the
        // life of the app, and the log stream is a separate, cancellable process.
        Invocation(arguments: ["simctl", "launch", "--terminate-running-process", udid, bundleID])
    }

    public static func terminate(udid: String, bundleID: String) -> Invocation {
        Invocation(arguments: ["simctl", "terminate", udid, bundleID])
    }

    /// A single PNG of the device screen. The supported way to see a simulator,
    /// and the only frame source this build claims.
    public static func screenshot(udid: String, outputPath: String) -> Invocation {
        Invocation(arguments: ["simctl", "io", udid, "screenshot", "--type=png", outputPath])
    }

    public static func recordVideo(udid: String, outputPath: String) -> Invocation {
        Invocation(arguments: ["simctl", "io", udid, "recordVideo", "--codec=h264", outputPath])
    }

    /// Runtime logs for one app, streamed. Predicate-scoped to the app's own
    /// subsystem so the session shows the app's output, not the whole device's.
    public static func logStream(udid: String, bundleID: String) -> Invocation {
        Invocation(arguments: [
            "simctl", "spawn", udid, "log", "stream",
            "--style", "compact",
            "--level", "info",
            "--predicate", "subsystem CONTAINS \"\(bundleID)\" OR processImagePath CONTAINS \"\(bundleID)\"",
        ])
    }

    public static func openURL(udid: String, url: String) -> Invocation {
        Invocation(arguments: ["simctl", "openurl", udid, url])
    }

    /// Open the real Simulator app focused on one device — the disclosed
    /// fallback for interaction, since no supported injection API exists.
    public static func openSimulatorApp(udid: String) -> Invocation {
        Invocation(executable: "/usr/bin/open", arguments: ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid])
    }

    // MARK: Build

    /// The build invocation for one scheme against one simulator device.
    ///
    /// Three properties matter and all three are asserted by tests:
    ///  - the destination names the exact device by udid, so a build cannot land
    ///    on some other simulator that happens to be booted;
    ///  - derived data is workspace-scoped and Juno-owned, so nothing here can
    ///    disturb (or be disturbed by) Xcode's own cache;
    ///  - code signing is disabled, which is correct for the simulator and
    ///    avoids prompting for a keychain identity the user never chose to use.
    public static func build(
        project: XcodeProject,
        scheme: String,
        configuration: String,
        deviceUDID: String,
        derivedDataPath: String,
        clean: Bool
    ) -> Invocation {
        var arguments = ["xcodebuild"]
        if clean { arguments.append("clean") }
        arguments.append("build")
        arguments.append(contentsOf: project.buildContainerArguments)
        arguments.append(contentsOf: [
            "-scheme", scheme,
            "-configuration", configuration,
            "-destination", "platform=iOS Simulator,id=\(deviceUDID)",
            "-derivedDataPath", derivedDataPath,
            "CODE_SIGNING_ALLOWED=NO",
            "CODE_SIGNING_REQUIRED=NO",
        ])
        return Invocation(
            arguments: arguments,
            currentDirectory: project.kind == .swiftPackage ? project.path : nil
        )
    }

    /// Where Juno keeps build products for one workspace.
    ///
    /// Under Application Support, keyed by the workspace's stable key — never
    /// `~/Library/Developer/Xcode/DerivedData`. Juno cleans what Juno created
    /// and nothing else.
    public static func derivedDataPath(workspaceKey: String, containerDirectory: URL) -> String {
        let safe = workspaceKey.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "-" }
        return containerDirectory
            .appendingPathComponent("SimulatorDerivedData", isDirectory: true)
            .appendingPathComponent(String(safe), isDirectory: true)
            .path
    }
}
