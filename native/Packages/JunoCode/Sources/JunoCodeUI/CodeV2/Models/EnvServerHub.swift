import AppKit
import Foundation
import JunoCodeCore
import JunoCodeLocal
import Observation

/// The Mac's side of the local environment server: launches it, connects to
/// it, lists the provider instances it reports and opens sessions on it
/// (Code v2 SPEC §2, §6 "mac").
///
/// One per app. Started lazily — the first time Connections opens, a
/// subscription is picked, or at launch when the user had connected one — so a
/// Mac that only ever uses Alevr's own engine never runs Node.
@MainActor
@Observable
public final class EnvServerHub {
    public enum Phase: Equatable, Sendable {
        case idle
        case starting
        case ready
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// Instances the server reported; nil until it answers `provider.list`.
    public private(set) var instances: [CodeV2.ProviderInstance]?
    /// Instance ids being probed right now (Re-check dims the row).
    public private(set) var probing: Set<String> = []
    /// Instance ids whose setup terminal is opening.
    public private(set) var openingSetup: Set<String> = []
    public private(set) var lastError: String?
    /// Skills lane: bumped by each `skills.updated` (a skill installed, edited
    /// or removed on this Mac), so an open Skills list reads again.
    public private(set) var skillsRevision = 0
    /// Runtimes Alevr installs and signs in itself (Antigravity): download
    /// and sign-in progress per instance id.
    public private(set) var runtimeSetup: [String: CodeV2RuntimeSetup] = [:]
    /// Opens the vendor's sign-in page (the browser on this Mac).
    @ObservationIgnored public var openURL: @MainActor (URL) -> Void = { NSWorkspace.shared.open($0) }
    @ObservationIgnored private var setupTask: Task<Void, Never>?
    /// Re-probes an instance while its sign-in / install terminal is open, so
    /// a login finished in Terminal shows up without pressing anything.
    @ObservationIgnored private var setupWatches: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var activeObserver: NSObjectProtocol?
    /// How often, and for how long, a setup is watched.
    @ObservationIgnored var setupWatchInterval: Duration = .seconds(4)
    @ObservationIgnored var setupWatchLimit: Duration = .seconds(300)

    @ObservationIgnored private let sidecar: EnvServerSidecar
    @ObservationIgnored private let makeTransport: @Sendable (EnvServerLaunch) -> any EnvServerTransport
    @ObservationIgnored private let launcher: TerminalCommandLauncher
    @ObservationIgnored private(set) var connection: EnvServerConnection?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var sessions: [String: WeakSession] = [:]
    @ObservationIgnored private var terminals: [String: WeakTerminal] = [:]
    @ObservationIgnored private var unclaimedTerminalEvents: [String: [CodeV2.ServerEvent]] = [:]
    /// Dock › Terminal: one shell per env-server thread, kept for the app's life.
    @ObservationIgnored private var threadTerminals: [ObjectIdentifier: CodeV2EnvTerminal] = [:]
    @ObservationIgnored private var relaySinks: [UUID: @MainActor (CodeV2.ServerEventEnvelope) -> Void] = [:]

    public static let shared = EnvServerHub()

    /// Told about every env server this app launches (the computer bridge
    /// binds to its pid). Set once by the app shell.
    @ObservationIgnored public static var onLaunch: (@MainActor (EnvServerLaunch) -> Void)?

    public init(
        sidecar: EnvServerSidecar = EnvServerSidecar(),
        launcher: TerminalCommandLauncher = TerminalCommandLauncher(),
        makeTransport: @escaping @Sendable (EnvServerLaunch) -> any EnvServerTransport = { launch in
            WebSocketEnvServerTransport(url: launch.webSocketURL, token: launch.token)
        }
    ) {
        self.sidecar = sidecar
        self.launcher = launcher
        self.makeTransport = makeTransport
        // Coming back to Alevr (after signing in or installing elsewhere)
        // re-checks every connection that is not ready yet.
        activeObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.recheckUnready() }
        }
    }

    /// For tests and previews: a hub already connected over `transport`.
    public init(connection: EnvServerConnection, launcher: TerminalCommandLauncher = TerminalCommandLauncher()) {
        self.sidecar = EnvServerSidecar(resolveEntry: { nil })
        self.launcher = launcher
        self.makeTransport = { _ in fatalError("connected hub") }
        adopt(connection)
    }

    /// A hub that never starts, holding a fixed list (snapshots, previews).
    public init(previewInstances: [CodeV2.ProviderInstance]) {
        self.sidecar = EnvServerSidecar(resolveEntry: { nil })
        self.launcher = TerminalCommandLauncher(opener: { _ in })
        self.makeTransport = { _ in fatalError("preview hub") }
        self.instances = previewInstances
        self.phase = .ready
    }

    public var isReady: Bool { phase == .ready }

    // MARK: Lifecycle

    /// Starts the server (if needed) and connects. Safe to call repeatedly.
    public func start() {
        guard startTask == nil, phase != .ready else { return }
        phase = .starting
        startTask = Task { [weak self] in
            guard let self else { return }
            defer { self.startTask = nil }
            do {
                let launch = try await self.sidecar.start()
                Self.onLaunch?(launch)
                let connection = EnvServerConnection(transport: self.makeTransport(launch))
                self.adopt(connection)
                await self.refreshProviders()
            } catch {
                self.phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }

    /// Waits until the server is ready (starting it if needed), or throws.
    public func ready() async throws -> EnvServerConnection {
        if let connection, phase == .ready { return connection }
        start()
        while true {
            switch phase {
            case .ready:
                if let connection { return connection }
            case let .failed(message):
                throw EnvServerConnectionError.server(.notReady, message)
            case .idle, .starting:
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    public func stop() {
        eventTask?.cancel()
        eventTask = nil
        let connection = self.connection
        self.connection = nil
        Task {
            await connection?.close()
            await sidecar.stop()
        }
        phase = .idle
    }

    private func adopt(_ connection: EnvServerConnection) {
        self.connection = connection
        phase = .ready
        setupTask?.cancel()
        setupTask = Task { [weak self] in
            let updates = await connection.runtimeSetupUpdates()
            for await update in updates {
                self?.apply(update)
            }
        }
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            await connection.start()
            let events = await connection.events()
            for await envelope in events {
                guard let self else { return }
                self.route(envelope)
            }
            guard let self, self.connection === connection else { return }
            // The socket closed under us: the sidecar restarts the process;
            // reconnect when it is back.
            self.connection = nil
            self.phase = .failed("The local environment server disconnected.")
            try? await Task.sleep(for: .seconds(1))
            self.startTask = nil
            self.start()
        }
    }

    private func route(_ envelope: CodeV2.ServerEventEnvelope) {
        if case let .providerUpdated(instance) = envelope.event {
            apply(instance)
        }
        if case .skillsUpdated = envelope.event { skillsRevision += 1 }
        if let sessionId = envelope.sessionId, let session = sessions[sessionId]?.value {
            session.receive(envelope)
        }
        switch envelope.event {
        case let .terminalOutput(terminalId, _), let .terminalExited(terminalId, _):
            if let terminal = terminals[terminalId]?.value {
                terminal.receive(envelope.event)
            } else {
                // Output can land before `terminal.open`'s caller has the id:
                // keep a little of it for the terminal that registers next.
                var held = unclaimedTerminalEvents[terminalId, default: []]
                held.append(envelope.event)
                unclaimedTerminalEvents[terminalId] = Array(held.suffix(64))
                if unclaimedTerminalEvents.count > 16, let stale = unclaimedTerminalEvents.keys.first(where: { $0 != terminalId }) {
                    unclaimedTerminalEvents[stale] = nil
                }
            }
        default:
            break
        }
        for sink in relaySinks.values { sink(envelope) }
    }

    private func apply(_ instance: CodeV2.ProviderInstance) {
        // The contract carries a managed runtime's install and sign-in state.
        if instance.install != nil || instance.auth != nil {
            apply(EnvRuntimeSetup.Update(instanceId: instance.id, install: instance.install, auth: instance.auth))
        }
        var list = instances ?? []
        if let index = list.firstIndex(where: { $0.id == instance.id }) {
            list[index] = instance
        } else {
            list.append(instance)
        }
        instances = list
    }

    // MARK: Providers

    public func refreshProviders() async {
        guard let connection else { return }
        do {
            instances = try await connection.providerList()
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Re-check: runs the probe (never a login or a session, SPEC §2).
    public func probe(_ instanceId: String) async {
        guard let connection else {
            start()
            return
        }
        probing.insert(instanceId)
        defer { probing.remove(instanceId) }
        do {
            apply(try await connection.providerProbe(instanceId))
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Re-checks every instance that is not ready or limited (app became
    /// active, or Connections appeared).
    public func recheckUnready() {
        guard connection != nil, let list = instances else { return }
        for instance in list where instance.status != .ready && instance.status != .limited {
            guard !probing.contains(instance.id) else { continue }
            Task { await self.probe(instance.id) }
        }
    }

    /// Probes `instanceId` every few seconds until it is ready (or limited),
    /// or the watch times out. Replaces any earlier watch of the same id.
    func watchSetup(_ instanceId: String) {
        setupWatches[instanceId]?.cancel()
        let interval = setupWatchInterval
        let limit = setupWatchLimit
        setupWatches[instanceId] = Task { [weak self] in
            let deadline = ContinuousClock.now + limit
            while ContinuousClock.now < deadline, !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                await self.probe(instanceId)
                if let status = self.instances?.first(where: { $0.id == instanceId })?.status,
                   status == .ready || status == .limited {
                    break
                }
            }
            self?.setupWatches[instanceId] = nil
        }
    }

    /// Whether a sign-in / install is being watched (for tests).
    func isWatchingSetup(_ instanceId: String) -> Bool { setupWatches[instanceId] != nil }

    /// The command for Install / Sign in: the server's, else the known one.
    public func setupStep(for instanceId: String, action: CodeV2.ProviderSetupAction) async -> CodeV2.ProviderSetupStep? {
        if let connection, let step = try? await connection.providerSetup(instanceId, action: action) {
            return step
        }
        return CodeV2KnownSubscription.allCases.first { $0.instanceId == instanceId }?.fallbackStep(action)
    }

    /// Opens Terminal with the vendor's command typed in (not run), then
    /// re-probes when the user comes back.
    public func openSetup(for instanceId: String, action: CodeV2.ProviderSetupAction) async {
        openingSetup.insert(instanceId)
        defer { openingSetup.remove(instanceId) }
        // A managed runtime (Antigravity) installs and signs in through the env
        // server itself: no terminal, Google's page opens in the browser.
        if instances?.first(where: { $0.id == instanceId })?.install != nil {
            if action == .install { await installRuntime(instanceId) } else { await signIn(instanceId) }
            return
        }
        guard let step = await setupStep(for: instanceId, action: action) else {
            lastError = "There is nothing to \(action == .install ? "install" : "sign in to") for this connection."
            return
        }
        do {
            try launcher.open(command: step.command, title: step.label)
            watchSetup(instanceId)
        } catch {
            lastError = "Alevr could not open Terminal: \(error.localizedDescription)"
        }
    }

    // MARK: Managed runtimes (Antigravity)

    /// Whether Alevr installs and signs in this instance itself rather than
    /// handing the user a terminal command.
    public func managesRuntime(_ instanceId: String) -> Bool {
        runtimeSetup[instanceId] != nil
            || CodeV2KnownSubscription.allCases.first { $0.instanceId == instanceId }?.managedRuntime == true
    }

    func apply(_ update: EnvRuntimeSetup.Update) {
        var state = runtimeSetup[update.instanceId] ?? CodeV2RuntimeSetup()
        if let install = update.install { state.install = install }
        if let auth = update.auth { state.auth = auth }
        runtimeSetup[update.instanceId] = state
    }

    private func setup(_ instanceId: String, _ change: (inout CodeV2RuntimeSetup) -> Void) {
        var state = runtimeSetup[instanceId] ?? CodeV2RuntimeSetup()
        change(&state)
        runtimeSetup[instanceId] = state
    }

    /// Downloads the vendor's own runtime and checks it (size and SHA-256).
    public func installRuntime(_ instanceId: String) async {
        await runtimeCommand(instanceId) { connection in
            let install = try await connection.providerInstall(instanceId, action: .start)
            self.setup(instanceId) { $0.install = install }
            if install.phase == .succeeded { await self.probe(instanceId) }
        }
    }

    public func cancelInstall(_ instanceId: String) async {
        let operation = runtimeSetup[instanceId]?.install?.operationId
        await runtimeCommand(instanceId) { connection in
            let install = try await connection.providerInstall(instanceId, action: .cancel, operationId: operation)
            self.setup(instanceId) { $0.install = install }
        }
    }

    /// Starts the browser sign-in and opens the vendor's page. A browser on
    /// this Mac finishes on its own (the runtime listens on 127.0.0.1); the
    /// redirect address can be pasted back when it does not.
    public func signIn(_ instanceId: String) async {
        await runtimeCommand(instanceId) { connection in
            let auth = try await connection.providerAuth(instanceId, action: .start)
            self.setup(instanceId) { $0.auth = auth }
            self.openSignInPage(instanceId)
            if auth.phase == .succeeded { await self.probe(instanceId) }
        }
    }

    /// Opens the sign-in page again (the user closed the tab).
    public func openSignInPage(_ instanceId: String) {
        guard let url = EnvRuntimeSetup.isOpenableAuthorizationURL(runtimeSetup[instanceId]?.auth?.authorizationUrl) else { return }
        openURL(url)
    }

    /// The paste fallback: the address the browser landed on after signing in.
    @discardableResult
    public func completeSignIn(_ instanceId: String, redirect: String) async -> Bool {
        let pasted = redirect.trimmingCharacters(in: .whitespacesAndNewlines)
        guard EnvRuntimeSetup.isLoopbackRedirect(pasted) else {
            setup(instanceId) { $0.pasteError = "Paste the whole address from the browser's address bar. It starts with http://127.0.0.1 or http://localhost." }
            return false
        }
        let flow = runtimeSetup[instanceId]?.auth?.flowId
        var done = false
        await runtimeCommand(instanceId) { connection in
            let auth = try await connection.providerAuth(instanceId, action: .complete, flowId: flow, callbackUrl: pasted)
            self.setup(instanceId) {
                $0.auth = auth
                $0.pasteError = nil
            }
            done = auth.phase == .succeeded || auth.phase == .verifying
            if auth.phase == .succeeded { await self.probe(instanceId) }
        }
        return done
    }

    public func cancelSignIn(_ instanceId: String) async {
        let flow = runtimeSetup[instanceId]?.auth?.flowId
        await runtimeCommand(instanceId) { connection in
            let auth = try await connection.providerAuth(instanceId, action: .cancel, flowId: flow)
            self.setup(instanceId) { $0.auth = auth }
        }
    }

    public func signOut(_ instanceId: String) async {
        await runtimeCommand(instanceId) { connection in
            let auth = try await connection.providerAuth(instanceId, action: .logout)
            self.setup(instanceId) { $0.auth = auth }
            await self.probe(instanceId)
        }
    }

    private func runtimeCommand(_ instanceId: String, _ body: (EnvServerConnection) async throws -> Void) async {
        do {
            let connection = try await ready()
            try await body(connection)
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: Sessions

    /// The session model for an env-server session, created on first use.
    public func session(id: String, cwd: String, selection: CodeV2.ModelSelection) -> CodeV2EnvSession {
        if let existing = sessions[id]?.value { return existing }
        let session = CodeV2EnvSession(hub: self, sessionId: id, cwd: cwd, selection: selection)
        sessions[id] = WeakSession(value: session)
        return session
    }

    func register(_ session: CodeV2EnvSession, as id: String) {
        sessions[id] = WeakSession(value: session)
    }

    // MARK: Terminals

    /// The thread's Dock › Terminal shell (not opened until the tab shows).
    public func terminal(for session: CodeV2EnvSession) -> CodeV2EnvTerminal {
        let key = ObjectIdentifier(session)
        if let existing = threadTerminals[key] { return existing }
        let terminal = CodeV2EnvTerminal(hub: self, cwd: session.cwd)
        threadTerminals[key] = terminal
        return terminal
    }

    func register(_ terminal: CodeV2EnvTerminal, as id: String) {
        terminals[id] = WeakTerminal(value: terminal)
        for event in unclaimedTerminalEvents.removeValue(forKey: id) ?? [] { terminal.receive(event) }
    }

    func unregisterTerminal(_ id: String) {
        terminals[id] = nil
    }

    // MARK: Device link

    /// Forwards every env-server event to `sink` (the device relay that lets
    /// the web drive env-server sessions through this Mac). Returns a token
    /// for ``removeRelaySink(_:)``.
    @discardableResult
    public func addRelaySink(_ sink: @escaping @MainActor (CodeV2.ServerEventEnvelope) -> Void) -> UUID {
        let id = UUID()
        relaySinks[id] = sink
        return id
    }

    public func removeRelaySink(_ id: UUID) {
        relaySinks[id] = nil
    }

    private struct WeakSession {
        weak var value: CodeV2EnvSession?
    }

    private struct WeakTerminal {
        weak var value: CodeV2EnvTerminal?
    }
}

/// A managed runtime's state on this Mac: its install and its sign-in.
public struct CodeV2RuntimeSetup: Equatable, Sendable {
    public var install: EnvRuntimeSetup.InstallState?
    public var auth: EnvRuntimeSetup.AuthState?
    /// Why a pasted redirect was not sent.
    public var pasteError: String?

    public init(install: EnvRuntimeSetup.InstallState? = nil, auth: EnvRuntimeSetup.AuthState? = nil, pasteError: String? = nil) {
        self.install = install
        self.auth = auth
        self.pasteError = pasteError
    }
}
