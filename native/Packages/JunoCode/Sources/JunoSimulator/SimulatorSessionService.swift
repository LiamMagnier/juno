import Foundation

/// One simulator session: the state machine, and the only place transitions
/// happen.
///
/// An actor because five different things drive it — the pane's buttons, a Code
/// task's events, the frame timer, the log stream, and teardown — and a state
/// machine with five concurrent drivers and no serialization is a state machine
/// that will eventually say "Running" about a device that shut down.
///
/// Nothing here executes an arbitrary command. The session can build, boot,
/// install, launch, capture, stop; that is the whole vocabulary, and each verb
/// maps to a fixed invocation from ``SimulatorCommands``. There is no
/// "run this shell string" entry point for a model or a browser to reach.
public actor SimulatorSessionService {
    public struct Configuration: Sendable {
        public let workspaceKey: String
        public let workspaceRoot: URL
        /// Juno-owned derived data. Never the user's global Xcode cache.
        public let derivedDataPath: String

        public init(workspaceKey: String, workspaceRoot: URL, containerDirectory: URL) {
            self.workspaceKey = workspaceKey
            self.workspaceRoot = workspaceRoot
            self.derivedDataPath = SimulatorCommands.derivedDataPath(
                workspaceKey: workspaceKey, containerDirectory: containerDirectory
            )
        }
    }

    public enum Event: Sendable {
        case state(SimulatorState)
        case buildLine(String)
        case logLine(String)
        case diagnostics([SimulatorParsing.BuildDiagnostic])
        case frame(SimulatorFrameService.Frame)
        case controlChanged(SimulatorControlLease)
        /// Emitted whenever a frame is about to be shared with the model, so the
        /// UI can show the indicator *before* it leaves the Mac, not after.
        case sharingFrameWithModel(Bool)
    }

    private let configuration: Configuration
    private let runner: SimulatorProcessRunner
    private let discovery: XcodeProjectDiscoveryService
    private let devices: SimulatorDeviceService
    private let frames: SimulatorFrameService

    private(set) public var state: SimulatorState = .discovering
    private(set) public var projects: [XcodeProject] = []
    private(set) public var runtimes: [SimulatorRuntime] = []
    private(set) public var availableDevices: [SimulatorDevice] = []
    private(set) public var selection: SimulatorSelection?
    private(set) public var settings: XcodeTargetSettings?
    private(set) public var lease = SimulatorControlLease()
    private(set) public var toolchain: XcodeProjectDiscoveryService.ToolchainStatus = .missing("Not checked yet.")

    private var continuations: [UUID: AsyncStream<Event>.Continuation] = [:]
    private var logTask: Task<Void, Never>?
    private var buildTask: Task<Void, Never>?
    /// Illegal transitions are dropped and counted rather than applied, and the
    /// count is asserted in tests — a silent drop that nobody can observe is
    /// just a different kind of lie.
    private(set) public var rejectedTransitions = 0

    public init(
        configuration: Configuration,
        runner: SimulatorProcessRunner = SimulatorProcessRunner()
    ) {
        self.configuration = configuration
        self.runner = runner
        self.discovery = XcodeProjectDiscoveryService(runner: runner)
        self.devices = SimulatorDeviceService(runner: runner)
        self.frames = SimulatorFrameService(runner: runner)
    }

    // MARK: - Events

    public func events() -> AsyncStream<Event> {
        AsyncStream { continuation in
            let id = UUID()
            continuations[id] = continuation
            continuation.yield(.state(state))
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeContinuation(id) }
            }
        }
    }

    private func removeContinuation(_ id: UUID) {
        continuations[id] = nil
    }

    private func emit(_ event: Event) {
        for continuation in continuations.values { continuation.yield(event) }
    }

    /// The single writer of `state`. Every transition is checked, so an illegal
    /// one is impossible rather than merely unlikely.
    private func transition(to next: SimulatorState) {
        guard SimulatorTransition.isValid(from: state, to: next) else {
            rejectedTransitions += 1
            return
        }
        state = next
        emit(.state(next))
    }

    // MARK: - Discovery

    public func discover() async {
        transition(to: .discovering)
        await frames.cleanUp()

        toolchain = await discovery.toolchain()
        guard case .ready = toolchain else {
            if case .missing(let reason) = toolchain { transition(to: .unavailable(reason: reason)) }
            return
        }

        projects = await discovery.findProjects(root: configuration.workspaceRoot)
        guard !projects.isEmpty else {
            transition(to: .unavailable(reason: "No Xcode project, workspace or iOS Swift package was found in this folder."))
            return
        }

        do {
            runtimes = try await devices.runtimes()
            availableDevices = try await devices.devices()
        } catch {
            transition(to: .unavailable(reason: describe(error)))
            return
        }

        guard let runtime = try? SimulatorParsing.preferredRuntime(in: runtimes) else {
            transition(to: .unavailable(reason: SimulatorParsing.ParseError.noIOSRuntime.description))
            return
        }

        // Keep an existing selection when it is still valid; a re-discovery must
        // not silently move the user to a different device.
        if let existing = selection,
           projects.contains(where: { $0.path == existing.projectPath }),
           availableDevices.contains(where: { $0.udid == existing.deviceUDID }) {
            transition(to: .ready)
            return
        }

        guard let project = projects.first(where: { !$0.schemes.isEmpty }) else {
            transition(
                to: .unavailable(
                    reason: """
                        No shared scheme was found. In Xcode, choose Product ▸ Scheme ▸ Manage Schemes \
                        and tick “Shared” for the app scheme.
                        """
                )
            )
            return
        }
        guard let device = SimulatorParsing.preferredDevice(in: availableDevices, runtimeID: runtime.id) else {
            transition(to: .unavailable(reason: "\(runtime.name) is installed but has no simulators. Add one in Xcode ▸ Settings ▸ Components."))
            return
        }

        selection = SimulatorSelection(
            projectPath: project.path,
            scheme: project.schemes[0],
            runtimeID: runtime.id,
            deviceUDID: device.udid
        )
        transition(to: .ready)
    }

    public func select(_ next: SimulatorSelection) {
        selection = next
        settings = nil
        if case .unavailable = state { transition(to: .ready) }
    }

    // MARK: - The build/run loop

    /// Build → boot → install → launch, in that order, cancellable at any point.
    ///
    /// Cancelling the returned task terminates the process group of whatever
    /// step is in flight; the state falls back to `.ready` rather than pretending
    /// something is running.
    public func run(clean: Bool = false) async {
        guard let selection, let project = projects.first(where: { $0.path == selection.projectPath }) else {
            transition(to: .failed(SimulatorFailure(stage: .discovery, message: "Choose a project and scheme first.")))
            return
        }
        guard let device = availableDevices.first(where: { $0.udid == selection.deviceUDID }) else {
            transition(to: .failed(SimulatorFailure(stage: .discovery, message: "The selected simulator is no longer available.")))
            return
        }

        // A rerun always ends the previous app and its log stream first, so two
        // runs can never both be streaming into the same session.
        await stopLog()
        if case .running(let bundleID, _) = state {
            await devices.terminate(udid: device.udid, bundleID: bundleID)
        }

        do {
            transition(to: .booting(deviceName: device.name))
            try await devices.boot(device)

            transition(to: .building(scheme: selection.scheme))
            let resolved = try await discovery.settings(
                project: project,
                scheme: selection.scheme,
                configuration: selection.configuration,
                derivedDataPath: configuration.derivedDataPath
            )
            settings = resolved

            try await build(project: project, selection: selection, clean: clean)

            transition(to: .installing(bundleID: resolved.bundleIdentifier))
            try await devices.install(udid: device.udid, appPath: resolved.appPath)

            transition(to: .launching(bundleID: resolved.bundleIdentifier))
            let pid = try await devices.launch(udid: device.udid, bundleID: resolved.bundleIdentifier)

            transition(to: .running(bundleID: resolved.bundleIdentifier, pid: pid))
            startLog(udid: device.udid, bundleID: resolved.bundleIdentifier)
        } catch is CancellationError {
            transition(to: .ready)
        } catch {
            transition(to: .failed(asFailure(error)))
        }
    }

    private func build(project: XcodeProject, selection: SimulatorSelection, clean: Bool) async throws {
        let invocation = SimulatorCommands.build(
            project: project,
            scheme: selection.scheme,
            configuration: selection.configuration,
            deviceUDID: selection.deviceUDID,
            derivedDataPath: configuration.derivedDataPath,
            clean: clean
        )
        emit(.buildLine("$ \(invocation.displayLine)"))

        var output = ""
        var exitCode: Int32 = 0
        for await line in runner.stream(invocation) {
            try Task.checkCancellation()
            switch line.channel {
            case .exit:
                exitCode = Int32(line.text) ?? 1
            case .stdout, .stderr:
                output += line.text + "\n"
                emit(.buildLine(line.text))
            }
        }

        let diagnostics = SimulatorParsing.parseDiagnostics(output)
        emit(.diagnostics(diagnostics))
        guard exitCode == 0 else {
            throw SimulatorFailure(
                stage: .build,
                message: diagnostics.first(where: { $0.severity == .error })?.message ?? "The build failed.",
                detail: String(output.suffix(8_000))
            )
        }
    }

    public func stop() async {
        guard case .running(let bundleID, _) = state, let udid = selection?.deviceUDID else { return }
        transition(to: .stopping)
        await stopLog()
        await devices.terminate(udid: udid, bundleID: bundleID)
        transition(to: .ready)
    }

    // MARK: - Logs

    private func startLog(udid: String, bundleID: String) {
        logTask?.cancel()
        logTask = Task { [weak self, runner] in
            for await line in runner.stream(SimulatorCommands.logStream(udid: udid, bundleID: bundleID)) {
                if Task.isCancelled { return }
                guard line.channel != .exit else { continue }
                await self?.emitLogLine(line.text)
            }
        }
    }

    private func emitLogLine(_ text: String) {
        emit(.logLine(text))
    }

    private func stopLog() async {
        logTask?.cancel()
        logTask = nil
    }

    // MARK: - Frames and visual checks

    /// One frame for the pane.
    public func captureFrame() async throws -> SimulatorFrameService.Frame {
        guard case .running = state, let udid = selection?.deviceUDID else {
            throw SimulatorFrameService.CaptureError.notBooted
        }
        let frame = try await frames.capture(udid: udid, enforceRate: true)
        emit(.frame(frame))
        return frame
    }

    /// A frame captured because the model asked to look.
    ///
    /// The indicator is raised *before* the capture and lowered after, so the
    /// visible state never lags the fact. The frame is returned to the caller
    /// and never written to a log.
    public func captureForModel() async throws -> SimulatorFrameService.Frame {
        guard case .running = state, let udid = selection?.deviceUDID else {
            throw SimulatorFrameService.CaptureError.notBooted
        }
        emit(.sharingFrameWithModel(true))
        defer { emit(.sharingFrameWithModel(false)) }
        let frame = try await frames.capture(udid: udid, enforceRate: false)
        emit(.frame(frame))
        return frame
    }

    // MARK: - Control lease

    /// Take input control. The user always wins; Juno waits its turn.
    @discardableResult
    public func takeControl(_ owner: SimulatorControlOwner, now: Date = Date(), duration: TimeInterval = 300) -> Bool {
        guard lease.canTake(owner, now: now) else { return false }
        lease = SimulatorControlLease(
            owner: owner,
            acquiredAt: owner == .none ? nil : now,
            expiresAt: owner == .none ? nil : now.addingTimeInterval(duration)
        )
        emit(.controlChanged(lease))
        return true
    }

    /// Drop an expired lease. Called on a timer and on disconnect so a
    /// browser that vanished mid-session does not hold input forever.
    public func expireLeaseIfNeeded(now: Date = Date()) {
        guard lease.owner != .none, lease.isExpired(now: now) else { return }
        lease = SimulatorControlLease()
        emit(.controlChanged(lease))
    }

    // MARK: - Capability

    public func capability(servesSimulatorSessions: Bool) -> SimulatorCapability {
        SimulatorCapability.from(
            toolchain: toolchain,
            runtimes: runtimes,
            devices: availableDevices,
            input: SimulatorInputCapability.current,
            servesSimulatorSessions: servesSimulatorSessions
        )
    }

    // MARK: - Teardown

    /// End everything this session started.
    ///
    /// Called when the pane closes, the workspace changes, the Code session
    /// changes, the user signs out, remote hosting is disabled, or Juno quits.
    /// It is safe to call more than once, which matters because several of those
    /// can happen at the same moment.
    public func shutDown(terminateApp: Bool = true) async {
        buildTask?.cancel()
        buildTask = nil
        await stopLog()

        if terminateApp, case .running(let bundleID, _) = state, let udid = selection?.deviceUDID {
            await devices.terminate(udid: udid, bundleID: bundleID)
        }
        runner.terminateAll()
        await frames.cleanUp()

        lease = SimulatorControlLease()
        emit(.controlChanged(lease))
        for continuation in continuations.values { continuation.finish() }
        continuations.removeAll()
    }

    /// Diagnostic for the teardown test: nothing of ours may still be running.
    public var liveProcessCount: Int { runner.liveProcessCount }

    // MARK: - Errors

    private func asFailure(_ error: Error) -> SimulatorFailure {
        if let failure = error as? SimulatorFailure { return failure }
        return SimulatorFailure(stage: .build, message: describe(error), detail: nil)
    }

    private func describe(_ error: Error) -> String {
        if let failure = error as? SimulatorFailure { return failure.message }
        if let parse = error as? SimulatorParsing.ParseError { return parse.description }
        if let process = error as? SimulatorProcessRunner.Failure { return process.description }
        return (error as CustomStringConvertible?)?.description ?? "\(error)"
    }
}
