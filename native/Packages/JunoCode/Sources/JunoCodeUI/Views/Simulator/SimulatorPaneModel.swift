import Foundation
import JunoSimulator
import Observation
import SwiftUI

#if canImport(AppKit)
import AppKit
#endif

/// The observable face of ``SimulatorSessionService`` for SwiftUI.
///
/// The session is an actor that knows nothing about views; this is the thin
/// layer that subscribes to its events and republishes them on the main actor.
/// Keeping it thin is deliberate — no state is *derived* here that the session
/// does not already own, so the pane cannot show a status the session disagrees
/// with.
///
/// Buffers are bounded. A ten-minute build emits tens of thousands of lines, and
/// an unbounded `@Observable` array of them is how a window stops responding.
@MainActor
@Observable
public final class SimulatorPaneModel {
    public enum TranscriptTab: Hashable { case build, logs }

    public struct Line: Identifiable, Equatable {
        public let id: Int
        public let text: String
    }

    /// Enough scrollback to diagnose a failure, bounded so a runaway build
    /// cannot grow the window's memory without limit.
    private static let maxLines = 4_000

    private let session: SimulatorSessionService
    private var eventTask: Task<Void, Never>?
    private var runTask: Task<Void, Never>?
    private var frameTask: Task<Void, Never>?
    private var lineCounter = 0
    private var started = false

    public private(set) var state: SimulatorState = .discovering
    public private(set) var schemes: [String] = []
    public private(set) var devices: [SimulatorDevice] = []
    public private(set) var diagnostics: [SimulatorParsing.BuildDiagnostic] = []
    public private(set) var buildLines: [Line] = []
    public private(set) var logLines: [Line] = []
    public private(set) var latestFrame: NSImage?
    public private(set) var lease = SimulatorControlLease()
    public private(set) var isSharingFrameWithModel = false
    public let inputCapability = SimulatorInputCapability.current

    public var transcriptTab: TranscriptTab = .build
    public var confirmingClean = false
    public var selectedScheme: String = "" {
        didSet { pushSelection() }
    }
    public var selectedDeviceUDID: String = "" {
        didSet { pushSelection() }
    }

    public init(session: SimulatorSessionService) {
        self.session = session
    }

    // No `deinit` cleanup: `deinit` is nonisolated and cannot touch main-actor
    // state. Teardown is explicit instead — `paneClosed()` when the pane goes
    // away and `shutDown()` on a workspace/session change, sign-out or quit —
    // which is the honest shape anyway, because ending a build has to be
    // something the app *decides* to do rather than something it hopes ARC does.

    public var visibleLines: [Line] { transcriptTab == .build ? buildLines : logLines }

    public var canRun: Bool {
        !selectedScheme.isEmpty && !selectedDeviceUDID.isEmpty && !state.isBusy
    }

    public var statusLine: String {
        switch state {
        case .failed(let failure): failure.message
        case .unavailable(let reason): reason
        default: state.label
        }
    }

    // MARK: Lifecycle

    public func startIfNeeded() async {
        guard !started else { return }
        started = true
        subscribe()
        await session.discover()
        await syncFromSession()
    }

    private func subscribe() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await event in await session.events() {
                if Task.isCancelled { return }
                await self.handle(event)
            }
        }
    }

    private func handle(_ event: SimulatorSessionService.Event) async {
        switch event {
        case .state(let next):
            state = next
            if next.isRunning { startFrameLoop() } else { stopFrameLoop() }
            if case .building = next { diagnostics = [] }
            await syncFromSession()
        case .buildLine(let text):
            append(text, to: &buildLines)
        case .logLine(let text):
            append(text, to: &logLines)
        case .diagnostics(let list):
            diagnostics = list
            if list.contains(where: { $0.severity == .error }) { transcriptTab = .build }
        case .frame(let frame):
            latestFrame = NSImage(data: frame.png)
        case .controlChanged(let next):
            lease = next
        case .sharingFrameWithModel(let sharing):
            isSharingFrameWithModel = sharing
        }
    }

    private func append(_ text: String, to buffer: inout [Line]) {
        lineCounter += 1
        buffer.append(Line(id: lineCounter, text: text))
        if buffer.count > Self.maxLines {
            buffer.removeFirst(buffer.count - Self.maxLines)
        }
    }

    private func syncFromSession() async {
        let projects = await session.projects
        let selection = await session.selection
        devices = await session.availableDevices.filter { device in
            // Only devices on an iOS runtime are offerable.
            device.isAvailable && device.runtimeID.contains("iOS")
        }
        schemes = projects.first { $0.path == selection?.projectPath }?.schemes
            ?? projects.first(where: { !$0.schemes.isEmpty })?.schemes
            ?? []

        if let selection {
            if selectedScheme != selection.scheme { assignWithoutPush { selectedScheme = selection.scheme } }
            if selectedDeviceUDID != selection.deviceUDID { assignWithoutPush { selectedDeviceUDID = selection.deviceUDID } }
        }
    }

    /// `didSet` on the pickers pushes the choice back to the session; syncing
    /// FROM the session must not bounce it straight back.
    private var suppressPush = false

    private func assignWithoutPush(_ body: () -> Void) {
        suppressPush = true
        body()
        suppressPush = false
    }

    private func pushSelection() {
        guard !suppressPush, !selectedScheme.isEmpty, !selectedDeviceUDID.isEmpty else { return }
        Task { [session, selectedScheme, selectedDeviceUDID] in
            guard let current = await session.selection else { return }
            var next = current
            next.scheme = selectedScheme
            next.deviceUDID = selectedDeviceUDID
            await session.select(next)
        }
    }

    // MARK: Actions

    public func run(clean: Bool = false) {
        runTask?.cancel()
        buildLines.removeAll()
        diagnostics = []
        transcriptTab = .build
        runTask = Task { [session] in await session.run(clean: clean) }
    }

    /// Cancel the in-flight build or launch. The task's cancellation propagates
    /// into the process group, so this stops `xcodebuild` rather than merely
    /// stopping listening to it.
    public func cancel() {
        runTask?.cancel()
        runTask = nil
    }

    public func stop() {
        runTask?.cancel()
        Task { [session] in await session.stop() }
    }

    public func rediscover() {
        Task { [session] in
            await session.discover()
            await self.syncFromSession()
        }
    }

    public func openSimulatorApp() {
        Task { [session] in
            guard let udid = await session.selection?.deviceUDID else { return }
            let runner = SimulatorProcessRunner()
            _ = try? await runner.run(SimulatorCommands.openSimulatorApp(udid: udid), timeout: 20)
        }
    }

    public func captureNow() {
        Task { [session] in _ = try? await session.captureFrame() }
    }

    /// A frame for a visual check, with the indicator raised while it happens.
    public func captureForModel() async -> Data? {
        try? await session.captureForModel().png
    }

    // MARK: Frames

    /// A bounded refresh while the pane is open. Not a video stream, and never
    /// sent anywhere — it only repaints this pane.
    private func startFrameLoop() {
        guard frameTask == nil else { return }
        frameTask = Task { [weak self, session] in
            let interval = UInt64(1_000_000_000 / max(1, Int(SimulatorFrameService.maxFramesPerSecond)))
            while !Task.isCancelled {
                _ = try? await session.captureFrame()
                try? await Task.sleep(nanoseconds: interval)
                if self?.state.isRunning != true { return }
            }
        }
    }

    private func stopFrameLoop() {
        frameTask?.cancel()
        frameTask = nil
    }

    /// Closing the pane stops the capture immediately — the loop must not
    /// outlive the surface that justified it.
    public func paneClosed() {
        stopFrameLoop()
    }

    /// Full teardown: workspace change, session change, sign-out, or quit.
    public func shutDown() async {
        eventTask?.cancel()
        runTask?.cancel()
        stopFrameLoop()
        await session.shutDown()
    }
}
