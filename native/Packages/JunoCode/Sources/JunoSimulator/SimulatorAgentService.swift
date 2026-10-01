import Foundation
import JunoCodeCore

/// The agent's Simulator: the fixed `simctl` verbs the `simulator` tool may
/// use, and nothing else (CODE_AGENT_SPEC §5.14, D-024).
///
/// Built on the same device and frame services as the pane, so a frame the
/// agent takes is the same `simctl io screenshot` of the named device — never
/// the desktop. No arbitrary command is reachable: each verb is one fixed
/// invocation from ``SimulatorCommands``.
public struct SimulatorAgentService: SimulatorAgentControlling {
    private let runner: SimulatorProcessRunner
    private let devicesService: SimulatorDeviceService
    private let frames: SimulatorFrameService

    public init(runner: SimulatorProcessRunner = SimulatorProcessRunner()) {
        self.runner = runner
        self.devicesService = SimulatorDeviceService(runner: runner)
        self.frames = SimulatorFrameService(runner: runner)
    }

    public func devices() async throws -> [SimulatorDeviceSummary] {
        let runtimes = (try? await devicesService.runtimes()) ?? []
        let names = Dictionary(runtimes.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        return try await devicesService.devices()
            .filter(\.isAvailable)
            .map {
                SimulatorDeviceSummary(
                    udid: $0.udid,
                    name: $0.name,
                    runtime: names[$0.runtimeID] ?? $0.runtimeID,
                    isBooted: $0.state == .booted
                )
            }
    }

    private func device(_ udid: String) async throws -> SimulatorDevice {
        guard let device = try await devicesService.devices().first(where: { $0.udid == udid }) else {
            throw SimulatorFailure(stage: .discovery, message: "No simulator has the udid \(udid).", detail: nil)
        }
        return device
    }

    public func boot(udid: String) async throws {
        try await devicesService.boot(try await device(udid))
    }

    public func shutdown(udid: String) async throws {
        let result = try await runner.run(SimulatorCommands.shutdown(udid: udid), timeout: 120)
        guard result.succeeded || result.combined.contains("current state: Shutdown") else {
            throw SimulatorFailure(stage: .boot, message: "Could not shut the simulator down.", detail: result.combined)
        }
    }

    public func install(udid: String, appPath: String) async throws {
        try await devicesService.install(udid: udid, appPath: appPath)
    }

    public func launch(udid: String, bundleID: String) async throws -> Int32 {
        try await devicesService.launch(udid: udid, bundleID: bundleID)
    }

    public func terminate(udid: String, bundleID: String) async throws {
        await devicesService.terminate(udid: udid, bundleID: bundleID)
    }

    public func screenshot(udid: String) async throws -> Data {
        try await frames.capture(udid: udid, enforceRate: false).png
    }

    public func openURL(udid: String, url: String) async throws {
        let result = try await runner.run(SimulatorCommands.openURL(udid: udid, url: url), timeout: 60)
        guard result.succeeded else {
            throw SimulatorFailure(stage: .launch, message: "The simulator could not open \(url).", detail: result.combined)
        }
    }
}

/// The failure's own sentence, for the agent and the thread, instead of a
/// struct dump.
extension SimulatorFailure: LocalizedError {
    public var errorDescription: String? { message }
}
