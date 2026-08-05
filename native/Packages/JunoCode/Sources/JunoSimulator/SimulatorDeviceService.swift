import Foundation

/// Runtimes and devices, from `simctl`.
///
/// Every answer here is read back from CoreSimulator rather than remembered:
/// a device can be booted, erased or deleted from Xcode while Juno is running,
/// and a cached device list is how a pane ends up claiming a simulator that no
/// longer exists.
public struct SimulatorDeviceService: Sendable {
    private let runner: SimulatorProcessRunner

    public init(runner: SimulatorProcessRunner) {
        self.runner = runner
    }

    public func runtimes() async throws -> [SimulatorRuntime] {
        let result = try await runner.run(SimulatorCommands.listRuntimes(), timeout: 60)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .discovery, message: "Could not list simulator runtimes.", detail: result.combined)
        }
        return try SimulatorParsing.parseRuntimes(Data(result.standardOutput.utf8))
    }

    public func devices() async throws -> [SimulatorDevice] {
        let result = try await runner.run(SimulatorCommands.listDevices(), timeout: 60)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .discovery, message: "Could not list simulators.", detail: result.combined)
        }
        return try SimulatorParsing.parseDevices(Data(result.standardOutput.utf8))
    }

    /// Boot a device and wait until it is genuinely usable.
    ///
    /// `simctl boot` returns as soon as the boot has *started*; installing into
    /// that window fails intermittently with an opaque error. `bootstatus -b`
    /// blocks until the device's services are up, so it is the wait, and an
    /// already-booted device short-circuits.
    public func boot(_ device: SimulatorDevice) async throws {
        if device.state != .booted {
            let boot = try await runner.run(SimulatorCommands.boot(udid: device.udid), timeout: 180)
            // "Unable to boot device in current state: Booted" is a race with
            // Xcode or another Juno window, and is a success, not a failure.
            if !boot.succeeded, !boot.combined.contains("current state: Booted") {
                throw SimulatorFailure(
                    stage: .boot,
                    message: "Could not boot \(device.name).",
                    detail: boot.combined
                )
            }
        }
        let status = try await runner.run(SimulatorCommands.waitForBoot(udid: device.udid), timeout: 300)
        guard status.succeeded else {
            throw SimulatorFailure(stage: .boot, message: "\(device.name) did not finish booting.", detail: status.combined)
        }
    }

    public func install(udid: String, appPath: String) async throws {
        // Fail early and clearly: `simctl install` on a missing path reports a
        // path error that reads like a simulator problem.
        guard FileManager.default.fileExists(atPath: appPath) else {
            throw SimulatorFailure(
                stage: .install,
                message: "The build finished but no app was found at \(appPath).",
                detail: nil
            )
        }
        let result = try await runner.run(SimulatorCommands.install(udid: udid, appPath: appPath), timeout: 300)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .install, message: "Could not install the app.", detail: result.combined)
        }
    }

    public func launch(udid: String, bundleID: String) async throws -> Int32 {
        let result = try await runner.run(SimulatorCommands.launch(udid: udid, bundleID: bundleID), timeout: 120)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .launch, message: "Could not launch \(bundleID).", detail: result.combined)
        }
        // No pid means no evidence the app is running — and `.running` is only
        // ever entered on evidence.
        guard let pid = SimulatorParsing.parseLaunchPID(result.standardOutput) else {
            throw SimulatorFailure(
                stage: .launch,
                message: "The simulator reported no process id for \(bundleID), so Juno cannot confirm it started.",
                detail: result.combined
            )
        }
        return pid
    }

    public func terminate(udid: String, bundleID: String) async {
        // Best effort: an app that already exited makes this fail, and that is
        // the outcome the caller wanted anyway.
        _ = try? await runner.run(SimulatorCommands.terminate(udid: udid, bundleID: bundleID), timeout: 60)
    }

    /// Open the real Simulator app on this device — the disclosed fallback for
    /// interaction. Never called implicitly; only from the pane's own control.
    public func openSimulatorApp(udid: String) async throws {
        let result = try await runner.run(SimulatorCommands.openSimulatorApp(udid: udid), timeout: 30)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .input, message: "Could not open the Simulator app.", detail: result.combined)
        }
    }
}
