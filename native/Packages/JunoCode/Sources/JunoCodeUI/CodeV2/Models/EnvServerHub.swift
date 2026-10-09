import Foundation
#if canImport(AppKit)
import AppKit
#endif
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

    @ObservationIgnored private let sidecar: EnvServerSidecar
    @ObservationIgnored private let makeTransport: @Sendable (EnvServerLaunch) -> any EnvServerTransport
    @ObservationIgnored private let launcher: TerminalCommandLauncher
    @ObservationIgnored private(set) var connection: EnvServerConnection?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var sessions: [String: WeakSession] = [:]
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
        if let sessionId = envelope.sessionId, let session = sessions[sessionId]?.value {
            session.receive(envelope)
        }
        for sink in relaySinks.values { sink(envelope) }
    }

    private func apply(_ instance: CodeV2.ProviderInstance) {
        followSignIn(instance)
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
        } catch {
            lastError = "Alevr could not open Terminal: \(error.localizedDescription)"
        }
    }

    // MARK: Managed runtimes (Antigravity)

    /// Flows this Mac started: their Google page opens here once, when the
    /// runtime reports it (a flow started from the web shows its link there).
    @ObservationIgnored private var flowsStartedHere: Set<String> = []
    @ObservationIgnored private var openedFlows: Set<String> = []
    /// Opens Google's sign-in page; the default browser in the app.
    @ObservationIgnored public var openURL: @MainActor (URL) -> Void = { url in
        #if canImport(AppKit)
        NSWorkspace.shared.open(url)
        #endif
    }

    public func installRuntime(_ instanceId: String, action: CodeV2.ProviderInstallAction = .start) async {
        do {
            let connection = try await ready()
            _ = try await connection.providerInstall(instanceId, action: action, operationId: instances?.first { $0.id == instanceId }?.install?.operationId)
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func signIn(_ instanceId: String) async {
        do {
            let connection = try await ready()
            let state = try await connection.providerAuth(instanceId, action: .start)
            if let flow = state.flowId { flowsStartedHere.insert(flow) }
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// The address Google's page ended on, pasted when the browser could not reach this Mac's loopback.
    public func completeSignIn(_ instanceId: String, callbackURL: String) async {
        do {
            let connection = try await ready()
            let flow = instances?.first { $0.id == instanceId }?.auth?.flowId
            _ = try await connection.providerAuth(instanceId, action: .complete, flowId: flow, callbackUrl: callbackURL)
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func cancelSignIn(_ instanceId: String) async {
        do {
            let connection = try await ready()
            let flow = instances?.first { $0.id == instanceId }?.auth?.flowId
            _ = try await connection.providerAuth(instanceId, action: .cancel, flowId: flow)
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func signOut(_ instanceId: String) async {
        do {
            let connection = try await ready()
            _ = try await connection.providerAuth(instanceId, action: .logout)
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Opens the Google page of a flow this Mac started, once.
    private func followSignIn(_ instance: CodeV2.ProviderInstance) {
        guard let auth = instance.auth, auth.phase == .waiting, let flow = auth.flowId,
              flowsStartedHere.contains(flow), !openedFlows.contains(flow),
              let raw = auth.authorizationUrl, let url = URL(string: raw),
              url.scheme == "https", url.host == "accounts.google.com"
        else { return }
        openedFlows.insert(flow)
        openURL(url)
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
}
