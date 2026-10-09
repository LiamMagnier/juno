import Foundation
import JunoCodeCore
import JunoCodeLocal
import Observation

/// Dock › Terminal for an env-server thread: one shell in the thread's
/// folder, run by the env server (`terminal.open/write/resize/close`). The
/// reader's, not the agent's: nothing typed here reaches the model.
///
/// The hub hands `terminal.output` and `terminal.exited` (global events
/// keyed by terminal id) to the terminal that owns the id. Re-opening with
/// the same id after a reconnect repaints the scrollback.
@MainActor
@Observable
public final class CodeV2EnvTerminal {
    public enum Phase: Equatable, Sendable {
        case idle
        case opening
        case running
        case exited(Int?)
        case failed(String)
    }

    public let cwd: String
    public private(set) var phase: Phase = .idle
    public private(set) var screen = CodeV2TerminalScreen()
    public private(set) var terminalId: String?
    public private(set) var size = (cols: 100, rows: 30)

    @ObservationIgnored private weak var hub: EnvServerHub?
    @ObservationIgnored private let connect: (() async throws -> EnvServerConnection)?
    @ObservationIgnored private var listener: Task<Void, Never>?

    init(hub: EnvServerHub, cwd: String) {
        self.hub = hub
        self.cwd = cwd
        self.connect = nil
    }

    /// Tests: a terminal on a given connection, outside any hub.
    public init(cwd: String, connection: @escaping () async throws -> EnvServerConnection) {
        self.cwd = cwd
        self.connect = connection
    }

    /// Previews and snapshot tests: a finished screen.
    public init(preview cwd: String, output: String, exited: Int? = nil) {
        self.cwd = cwd
        self.connect = nil
        screen.feed(output)
        phase = exited.map { .exited($0) } ?? .running
        terminalId = "preview"
    }

    public var isRunning: Bool { phase == .running }

    private func connection() async throws -> EnvServerConnection {
        if let connect { return try await connect() }
        guard let hub else { throw EnvServerConnectionError.closed }
        return try await hub.ready()
    }

    /// Opens the shell (or re-attaches to it after a reconnect).
    public func open(cols: Int? = nil, rows: Int? = nil) async {
        guard phase != .opening else { return }
        if phase == .running, terminalId != nil { return }
        if let cols, let rows { size = (max(20, cols), max(5, rows)) }
        let reattaching = terminalId
        phase = .opening
        do {
            let connection = try await connection()
            // Outside a hub, follow the connection before anything is sent,
            // so the shell's first prompt is not missed.
            if connect != nil, listener == nil { listen(to: await connection.events()) }
            if reattaching != nil { screen.clear() }
            let id = try await connection.terminalOpen(
                cwd: cwd, cols: size.cols, rows: size.rows, terminalId: reattaching
            )
            terminalId = id
            hub?.register(self, as: id)
            phase = .running
        } catch {
            phase = .failed(CodeV2EnvSession.describe(error))
        }
    }

    /// Sends what the reader typed. `line` is followed by Return.
    public func send(line: String) async {
        await write(line + "\r")
    }

    /// ⌃C, ⌃D, Tab, arrows: raw bytes, as a keyboard would send them.
    public func send(control: CodeV2TerminalKey) async {
        await write(control.bytes)
    }

    public func write(_ data: String) async {
        guard let terminalId, phase == .running else { return }
        do {
            try await connection().terminalWrite(terminalId, data: data)
        } catch {
            phase = .failed(CodeV2EnvSession.describe(error))
        }
    }

    public func resize(cols: Int, rows: Int) async {
        let next = (max(20, cols), max(5, rows))
        guard next != size else { return }
        size = next
        guard let terminalId, phase == .running else { return }
        try? await connection().terminalResize(terminalId, cols: next.0, rows: next.1)
    }

    public func close() async {
        guard let terminalId else { return }
        hub?.unregisterTerminal(terminalId)
        try? await connection().terminalClose(terminalId)
        self.terminalId = nil
        phase = .idle
    }

    /// A fresh shell after the last one exited.
    public func restart() async {
        if let terminalId { hub?.unregisterTerminal(terminalId) }
        terminalId = nil
        screen.clear()
        phase = .idle
        await open()
    }

    // MARK: Events

    /// Outside a hub (tests), the terminal follows the connection itself.
    private func listen(to events: AsyncStream<CodeV2.ServerEventEnvelope>) {
        listener = Task { [weak self] in
            for await envelope in events {
                guard let self else { return }
                self.receive(envelope.event)
            }
        }
    }

    /// The hub's (or a test's) delivery of one global terminal event.
    public func receive(_ event: CodeV2.ServerEvent) {
        switch event {
        case let .terminalOutput(id, data) where id == terminalId:
            screen.feed(data)
        case let .terminalExited(id, exitCode) where id == terminalId:
            phase = .exited(exitCode)
        default:
            break
        }
    }
}

/// Keys the terminal pane sends as raw bytes.
public enum CodeV2TerminalKey: String, CaseIterable, Sendable {
    case interrupt, endOfFile, tab, up, down, escape

    public var bytes: String {
        switch self {
        case .interrupt: "\u{03}"
        case .endOfFile: "\u{04}"
        case .tab: "\t"
        case .up: "\u{1B}[A"
        case .down: "\u{1B}[B"
        case .escape: "\u{1B}"
        }
    }
}
