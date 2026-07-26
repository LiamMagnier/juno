import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import SwiftUI
import WebKit

/// What the *page* is doing, read from the navigation delegate rather than
/// assumed.
///
/// "Connected" is never shown because an address was typed: the rejected build
/// lit a green pill the moment a URL existed, which claimed a development server
/// was answering before anything had been asked of it. This enum is only half the
/// story now — the other half is ``DevServerState``, which is a fact about a
/// child process. The indicator combines them, and it is green only when a
/// process is alive *and* a request to it succeeded.
enum CodePreviewLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// What the reader is looking at: which workspace the preview may start a server
/// in, and an address to open immediately.
///
/// Carried as the window's value so a preview opened from a session knows which
/// project it belongs to. The path is stored rather than a `URL` because this is
/// persisted by SwiftUI's scene restoration, and a file URL round-trips through
/// that with less ceremony as a string.
public struct CodePreviewTarget: Hashable, Codable, Sendable {
    public var workspaceRootPath: String?
    public var address: URL?

    public init(workspaceRootPath: String? = nil, address: URL? = nil) {
        self.workspaceRootPath = workspaceRootPath
        self.address = address
    }

    public init(workspaceRoot: URL?, address: URL? = nil) {
        self.workspaceRootPath = workspaceRoot?.path
        self.address = address
    }

    var workspaceRoot: URL? {
        workspaceRootPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
}

/// Everything the preview window knows, and the only place it is decided.
///
/// The server's state comes from ``DevServerService`` — a real child process with
/// a real pid — and the page's state comes from WebKit. Neither is ever inferred
/// from the other, and nothing here manufactures a state of its own.
@MainActor
@Observable
final class CodePreviewModel {
    let workspaceRoot: URL?

    private(set) var serverState: DevServerState = .stopped
    private(set) var log: [DevServerLogLine] = []
    /// How many lines fell out of the buffer, so the pane can say it is not the
    /// whole story rather than silently starting mid-sentence.
    private(set) var discardedLineCount = 0
    private(set) var commandSet: DevServerCommandSet?
    private(set) var runningCommand: String?
    private(set) var startedAt: Date?

    /// The reader's pick from the script menu; nil means "whatever the workspace
    /// suggests".
    var chosenCommandID: String?

    var addressText: String
    private(set) var address: URL?
    /// Set when the reader submits an address themselves, so a detected one never
    /// overwrites what they typed. Cleared by Start, because pressing Start is a
    /// request to look at *that* server.
    private var isAddressUserProvided: Bool
    private(set) var reloadID = UUID()
    private(set) var loadState: CodePreviewLoadState = .idle
    private(set) var reconnectAttempt = 0
    private(set) var addressValidationMessage: String?

    /// A dev server prints its address before it can answer a request — Next
    /// announces the port, then spends a few seconds compiling. Retrying a real
    /// request a bounded number of times is what turns that race into a page
    /// instead of an error the reader has to clear by hand.
    private static let maximumReconnectAttempts = 8
    /// A watch-mode server prints for hours; this is the tail worth keeping in
    /// memory for a window that may be open all day.
    private static let maximumLogLines = 2_000

    private let service = DevServerService()
    private var pump: Task<Void, Never>?
    private var reconnect: Task<Void, Never>?
    private var quitObserver: NSObjectProtocol?

    init(target: CodePreviewTarget) {
        self.workspaceRoot = target.workspaceRoot
        self.addressText = target.address?.absoluteString ?? ""
        self.address = target.address
        self.isAddressUserProvided = target.address != nil
        self.loadState = target.address == nil ? .idle : .loading

        // `onDisappear` and `deinit` both cover closing the window, but neither
        // runs when the app is quit with a window still open. Without this the
        // server outlives Juno and keeps the port until the Mac is restarted.
        //
        // The service is captured weakly so this observer cannot be what keeps it
        // alive: once the window is gone the service deallocates, its own `deinit`
        // stops the process, and this closure becomes a no-op.
        quitObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak service = self.service] _ in
            service?.stop()
        }
    }

    deinit {
        // Only the service is touched here: `deinit` is nonisolated, and the
        // service is a `Sendable` value guarded by its own lock.
        service.stop()
    }

    // MARK: - Discovery

    /// Reads the workspace's `package.json`. Nothing is started as a result.
    func discover() async {
        guard let workspaceRoot else { return }
        commandSet = await DevServerCommandDiscovery.scan(workspaceRoot: workspaceRoot)
    }

    var selectedCommand: DevServerCommand? {
        guard let commandSet else { return nil }
        if let chosenCommandID,
           let match = commandSet.commands.first(where: { $0.id == chosenCommandID })
        {
            return match
        }
        return commandSet.suggested
    }

    var canStart: Bool {
        workspaceRoot != nil && selectedCommand != nil && !serverState.isLive
    }

    /// Why the Start button is unavailable, in the reader's terms. Nil when it is
    /// available.
    var startUnavailableReason: String? {
        if workspaceRoot == nil {
            return "This preview window has no workspace, so there is no project to start."
        }
        if serverState.isLive { return nil }
        guard let commandSet else { return "Looking for a development server command…" }
        return commandSet.unavailableReason
    }

    // MARK: - Lifecycle

    func start() {
        guard let workspaceRoot, let command = selectedCommand else { return }
        pump?.cancel()
        reconnect?.cancel()
        reconnectAttempt = 0
        log.removeAll()
        discardedLineCount = 0
        runningCommand = command.commandLine
        startedAt = .now
        serverState = .starting
        // The previous run's page is gone the moment its process is; keeping it
        // on screen while a new server boots shows a page that no longer exists.
        address = nil
        addressText = ""
        isAddressUserProvided = false
        addressValidationMessage = nil
        loadState = .idle

        let events = service.start(command: command.commandLine, workspaceRoot: workspaceRoot)
        pump = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                switch event {
                case .state(let state): self.apply(state)
                case .line(let line): self.append(line)
                }
            }
        }
    }

    func stop() {
        reconnect?.cancel()
        // The state change arrives through the stream, from the process's own
        // termination handler — not set here, so "stopped" always means the
        // process is actually gone.
        service.stop()
    }

    /// Closing the window: stop the server and stop listening to it.
    func shutDown() {
        if let quitObserver {
            NotificationCenter.default.removeObserver(quitObserver)
            self.quitObserver = nil
        }
        reconnect?.cancel()
        service.stop()
        pump?.cancel()
    }

    private func apply(_ state: DevServerState) {
        serverState = state
        // The address the server printed, opened as soon as it exists — unless
        // the reader typed one themselves, which wins.
        if let url = state.url, !isAddressUserProvided {
            addressText = url.absoluteString
            addressValidationMessage = nil
            open(url)
        }
        if !state.isLive {
            reconnect?.cancel()
            reconnectAttempt = 0
        }
    }

    private func append(_ line: DevServerLogLine) {
        log.append(line)
        if log.count > Self.maximumLogLines {
            let overflow = log.count - Self.maximumLogLines
            log.removeFirst(overflow)
            discardedLineCount += overflow
        }
    }

    // MARK: - Address

    /// Opens whatever is in the address field.
    func openTypedAddress() {
        var value = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            address = nil
            loadState = .idle
            addressValidationMessage = nil
            isAddressUserProvided = false
            return
        }
        if !value.contains("://") {
            value = "http://\(value)"
        }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil
        else {
            address = nil
            loadState = .idle
            addressValidationMessage = "Use a complete HTTP or HTTPS address, including the host."
            return
        }
        addressText = url.absoluteString
        addressValidationMessage = nil
        isAddressUserProvided = true
        open(url)
    }

    /// Opens the address the running server printed, discarding whatever the
    /// reader had typed in its place.
    func openDetectedAddress() {
        guard let url = serverState.url else { return }
        addressText = url.absoluteString
        addressValidationMessage = nil
        isAddressUserProvided = false
        open(url)
    }

    private func open(_ url: URL) {
        reconnect?.cancel()
        reconnectAttempt = 0
        loadState = .loading
        address = url
        reloadID = UUID()
    }

    func reload() {
        guard address != nil else { return }
        loadState = .loading
        reloadID = UUID()
    }

    func openInBrowser() {
        guard let address else { return }
        NSWorkspace.shared.open(address)
    }

    // MARK: - Page reporting

    func reportLoadStarted() {
        loadState = .loading
    }

    func reportLoadFinished() {
        loadState = .loaded
        reconnectAttempt = 0
    }

    func reportLoadFailed(_ message: String) {
        loadState = .failed(message)
        guard serverState.isLive, reconnectAttempt < Self.maximumReconnectAttempts else { return }
        reconnectAttempt += 1
        reconnect?.cancel()
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1_200))
            guard !Task.isCancelled, let self, self.serverState.isLive else { return }
            self.loadState = .loading
            self.reloadID = UUID()
        }
    }

    var isAwaitingServer: Bool {
        reconnectAttempt > 0 && serverState.isLive
    }

    var reconnectDetail: String {
        "attempt \(reconnectAttempt) of \(Self.maximumReconnectAttempts)"
    }
}

/// A live web preview of what the agent is building, in its own window.
///
/// Its own window because of what it is: something the reader wants *beside* the
/// code. At inspector width a page layout is meaningless, and at detail width it
/// evicts the transcript the reader is working in. A window can be moved to the
/// other display, resized to a phone width, and left open across sessions —
/// which is what a Mac user does with a preview.
///
/// The window runs the server. `CommandExecutionService` cannot: it times a
/// command out and kills its process group when it finishes, which is correct for
/// `npm test` and fatal for `npm run dev`. ``DevServerService`` keeps the process
/// alive, streams its output, and reports the address the server itself printed.
///
/// Nothing here asserts that a server is running. Before Start there is no
/// process and the window says so; while a process is alive but silent the state
/// is "starting"; the indicator turns green only once a real request to a real
/// process has returned a page.
public struct CodePreviewWindowView: View {
    @State private var model: CodePreviewModel
    @SceneStorage("juno.code.preview.log") private var isLogVisible = false
    @SceneStorage("juno.code.preview.logHeight") private var logHeight = 200.0
    @State private var logDragBaseline: Double?
    @State private var isPushingResizeCursor = false

    private static let minimumLogHeight = 96.0
    private static let maximumLogHeight = 460.0

    /// - Parameter target: the workspace this preview belongs to, and an optional
    ///   address to open immediately.
    public init(target: CodePreviewTarget = CodePreviewTarget()) {
        _model = State(initialValue: CodePreviewModel(target: target))
    }

    public var body: some View {
        VStack(spacing: 0) {
            controlBar
            Divider().overlay(Color.junoSeparator)
            viewport
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if isLogVisible {
                logPane
            }
        }
        .junoReadingCanvas()
        .navigationTitle("Preview")
        .navigationSubtitle(subtitle)
        .task { await model.discover() }
        .onDisappear { model.shutDown() }
    }

    private var subtitle: String {
        if let command = model.runningCommand, model.serverState.isLive {
            return command
        }
        return model.address?.absoluteString ?? "No server running"
    }

    // MARK: - Control bar

    /// No control appears or disappears as the server's state changes: each one is
    /// always present and disabled when it cannot act, so the bar never reflows
    /// under the pointer. The run button is the one exception, and it changes in
    /// place — Start becomes Stop, in the same position, the way a transport
    /// control does.
    private var controlBar: some View {
        HStack(spacing: JunoSpace.snug) {
            runButton
            scriptMenu
            Divider().frame(height: JunoSpace.regular).overlay(Color.junoSeparator)

            Button { model.reload() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .disabled(model.address == nil)
            .keyboardShortcut("r", modifiers: .command)
            .help("Reload the preview (⌘R)")
            .accessibilityLabel("Reload")

            TextField("Address", text: $model.addressText)
                .textFieldStyle(.roundedBorder)
                .junoCode()
                .onSubmit { model.openTypedAddress() }
                .help(
                    model.addressValidationMessage
                        ?? "The address a started server printed, or one you type yourself"
                )
                .accessibilityLabel("Preview address")
                .accessibilityIdentifier("juno.code.preview.address")

            Button("Open") { model.openTypedAddress() }
                .controlSize(.small)
                .disabled(model.addressText.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("juno.code.preview.open")

            Button { model.openInBrowser() } label: {
                Image(systemName: "safari")
            }
            .buttonStyle(.borderless)
            .disabled(model.address == nil)
            .help("Open this address in the default browser")
            .accessibilityLabel("Open in browser")

            Button {
                isLogVisible.toggle()
            } label: {
                Image(systemName: "text.alignleft")
            }
            .buttonStyle(.borderless)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(isLogVisible ? Color.junoRowSelected : .clear)
            )
            .help(isLogVisible ? "Hide the server log" : "Show the server log")
            .accessibilityLabel("Server log")
            .accessibilityIdentifier("juno.code.preview.log-toggle")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }

    @ViewBuilder
    private var runButton: some View {
        if model.serverState.isLive {
            Button {
                model.stop()
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Stop the development server and everything it started")
            .accessibilityIdentifier("juno.code.preview.stop")
        } else {
            Button {
                model.start()
            } label: {
                Label("Start", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .controlSize(.small)
            .disabled(!model.canStart)
            .help(model.startUnavailableReason ?? "Run \(model.selectedCommand?.commandLine ?? "")")
            .accessibilityIdentifier("juno.code.preview.start")
        }
    }

    /// The workspace's own scripts. Never a hardcoded `npm run dev`: a project
    /// that calls it `serve`, `dev:web` or nothing at all is the common case, and
    /// offering a command that does not exist is worse than offering none.
    private var scriptMenu: some View {
        Menu {
            if let commands = model.commandSet?.commands, !commands.isEmpty {
                ForEach(commands) { command in
                    Button {
                        model.chosenCommandID = command.id
                    } label: {
                        Text(command.commandLine)
                        Text(command.script)
                    }
                }
            }
        } label: {
            Text(model.selectedCommand?.commandLine ?? "No command")
                .junoCode()
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: 220, alignment: .leading)
        .disabled(model.commandSet?.commands.isEmpty ?? true)
        .help(
            model.selectedCommand
                .map { "\($0.name): \($0.script)" }
                ?? model.commandSet?.unavailableReason
                ?? "Reading package.json…"
        )
        .accessibilityLabel("Development server command")
        .accessibilityIdentifier("juno.code.preview.command")
    }

    // MARK: - Viewport

    @ViewBuilder
    private var viewport: some View {
        if let address = model.address {
            ZStack(alignment: .bottomLeading) {
                CodePreviewWebView(url: address, reloadID: model.reloadID, model: model)
                // The one glass element on this surface: a small transient status
                // control floating over an opaque viewport, which is exactly what
                // the material is for. The page behind it is a reading surface and
                // stays opaque.
                statusPill
                    .padding(JunoSpace.cozy)
            }
        } else {
            idleState
                .padding(JunoSpace.region)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var idleState: some View {
        switch model.serverState {
        case .starting:
            VStack(spacing: JunoSpace.regular) {
                ProgressView()
                Text("Starting \(model.runningCommand ?? "the development server")")
                    .junoRowLabel()
                Text(
                    "The preview opens as soon as the server prints the address it is listening on. Juno does not guess a port."
                )
                .junoCaption()
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
                logTail
            }
        case .failed(let reason):
            failureState(title: "The server did not start", reason: reason)
        case .exited(let code):
            failureState(
                title: "The server stopped",
                reason: "It exited on its own with code \(code). The log has its last output."
            )
        case .running(let url):
            // A running server with nothing open: the reader cleared the address
            // field. The server is real, so the offer to open it is too.
            JunoEmptyState(
                title: "The server is running",
                message: "It is serving \(url.absoluteString), which is not open in this window.",
                symbol: "macwindow",
                actionLabel: "Open",
                action: { model.openDetectedAddress() }
            )
        case .stopped:
            readyState
        }
    }

    @ViewBuilder
    private var readyState: some View {
        VStack(spacing: JunoSpace.regular) {
            if let command = model.selectedCommand {
                JunoEmptyState(
                    title: "Start the development server",
                    message:
                        "Juno runs \(command.commandLine) in \(model.workspaceRoot?.lastPathComponent ?? "the workspace") and opens the address it prints.",
                    symbol: "macwindow",
                    actionLabel: "Start",
                    action: { model.start() }
                )
            } else {
                JunoEmptyState(
                    title: "No development server command",
                    message: model.startUnavailableReason
                        ?? "Type the address of a server you have already started.",
                    symbol: "macwindow"
                )
            }
            capabilityNote
        }
    }

    private func failureState(title: String, reason: String) -> some View {
        VStack(spacing: JunoSpace.regular) {
            Label(title, systemImage: "exclamationmark.triangle")
                .junoEmptyTitle()
                .foregroundStyle(Color.junoDanger)

            // The command's own output, verbatim. It is the only honest
            // explanation, and paraphrasing it would lose the line the reader
            // needs.
            ScrollView {
                Text(reason)
                    .junoCode()
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(JunoSpace.cozy)
            }
            .frame(maxWidth: 620, maxHeight: 220)
            .background(Color.junoTerminal)
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )

            HStack(spacing: JunoSpace.snug) {
                Button("Start again") { model.start() }
                    .disabled(!model.canStart)
                Button(isLogVisible ? "Hide log" : "Show log") { isLogVisible.toggle() }
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// The last few lines while the server boots, so a slow start is visibly
    /// progress rather than a stalled spinner.
    @ViewBuilder
    private var logTail: some View {
        let tail = model.log.suffix(4)
        if !tail.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(tail) { line in
                    Text(line.text)
                        .junoCodeSmall()
                        .foregroundStyle(line.channel == .stderr ? Color.junoDanger : .secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
        }
    }

    /// Stated plainly rather than implied by absent controls.
    ///
    /// There is no `simctl` or `xcodebuild` service anywhere in the packages: no
    /// build-product resolution, no simulator mirroring, no screenshot stream and
    /// no input injection into a simulator. The agent can run those tools as
    /// ordinary commands and stream their text, and a "Run in Simulator" button
    /// here would be a promise nothing beneath it can keep.
    private var capabilityNote: some View {
        Text(
            "Juno previews web addresses only. It cannot mirror an iOS Simulator or launch a Mac app: it can run your build and simulator tools as commands and stream their output to the console."
        )
        .junoCaption()
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
    }

    // MARK: - Status

    /// The process first, the page second.
    ///
    /// Green requires both: a child process that is still alive, and a request to
    /// it that actually returned a page. A typed address that loads while Juno
    /// started nothing says "Connected", which is true of the request and claims
    /// nothing about a server Juno is not running.
    private var indicator: (label: String, tint: Color, isBusy: Bool) {
        switch model.serverState {
        case .starting:
            return ("Starting · \(model.runningCommand ?? "")", .junoCaution, true)
        case .running:
            switch model.loadState {
            case .idle:
                return ("Server running", .junoCaution, false)
            case .loading:
                return ("Loading \(model.address?.host() ?? "")", .junoCaution, true)
            case .loaded:
                return ("Running · \(model.runningCommand ?? "")", .junoSuccess, false)
            case .failed(let message):
                return model.isAwaitingServer
                    ? ("Waiting for the server · \(model.reconnectDetail)", .junoCaution, true)
                    : ("Server running · page unavailable: \(message)", .junoCaution, false)
            }
        case .failed(let reason):
            return ("Failed · \(reason.split(separator: "\n").first.map(String.init) ?? reason)", .junoDanger, false)
        case .exited(let code):
            return ("Server exited · code \(code)", code == 0 ? .secondary : .junoDanger, false)
        case .stopped:
            // No process of Juno's. Whatever the pill says now is about the
            // request, and it says so.
            switch model.loadState {
            case .idle: return ("Not opened", .secondary, false)
            case .loading: return ("Loading", .junoCaution, true)
            case .loaded: return ("Connected · not started by Juno", .junoSuccess, false)
            case .failed(let message): return ("Unavailable · \(message)", .junoDanger, false)
            }
        }
    }

    private var statusPill: some View {
        let indicator = self.indicator
        return HStack(spacing: JunoSpace.tight) {
            if indicator.isBusy {
                ProgressView().controlSize(.mini)
            } else {
                Circle()
                    .fill(indicator.tint)
                    .frame(width: 6, height: 6)
            }
            Text(indicator.label)
                .junoCodeSmall()
                .lineLimit(1)
                .truncationMode(.middle)

            if model.serverState.isLive {
                Button {
                    model.stop()
                } label: {
                    Image(systemName: "stop.fill")
                        .imageScale(.small)
                }
                .buttonStyle(.borderless)
                .help("Stop the development server")
                .accessibilityLabel("Stop the development server")
                .accessibilityIdentifier("juno.code.preview.stop-floating")
            }
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.tight)
        .junoFloatingChrome(cornerRadius: JunoRadius.floating)
        .frame(maxWidth: 420, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Preview \(indicator.label)")
        .accessibilityIdentifier("juno.code.preview.status")
    }

    // MARK: - Log

    /// The server's own output, opaque like every other reading surface.
    private var logPane: some View {
        VStack(spacing: 0) {
            logResizeHandle
            logHeader
            Divider().overlay(Color.junoSeparator)
            logBody
        }
        .frame(height: max(Self.minimumLogHeight, min(Self.maximumLogHeight, logHeight)))
        .background(Color.junoRaised)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.junoSeparator).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Server log")
    }

    private var logResizeHandle: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(height: 5)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let baseline = logDragBaseline ?? logHeight
                        logDragBaseline = baseline
                        logHeight = max(
                            Self.minimumLogHeight,
                            min(Self.maximumLogHeight, baseline - Double(value.translation.height))
                        )
                    }
                    .onEnded { _ in logDragBaseline = nil }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    guard !isPushingResizeCursor else { return }
                    isPushingResizeCursor = true
                    NSCursor.resizeUpDown.push()
                case .ended:
                    guard isPushingResizeCursor else { return }
                    isPushingResizeCursor = false
                    NSCursor.pop()
                }
            }
            .accessibilityHidden(true)
    }

    private var logHeader: some View {
        HStack(spacing: JunoSpace.snug) {
            Text("Server log")
                .junoRowLabel()

            if let command = model.runningCommand {
                Text(command)
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if let startedAt = model.startedAt, model.serverState.isLive {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(elapsed(since: startedAt))
                        .junoCaption()
                        .monospacedDigit()
                }
            }

            Spacer(minLength: JunoSpace.snug)

            Button {
                copyLog()
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .disabled(model.log.isEmpty)
            .help("Copy this output to the clipboard")
            .accessibilityLabel("Copy server output")

            Button {
                isLogVisible = false
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.borderless)
            .help("Hide the server log")
            .accessibilityLabel("Hide the server log")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.bottom, JunoSpace.tight)
    }

    private var logBody: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    if model.discardedLineCount > 0 {
                        Text("\(model.discardedLineCount) earlier lines are no longer held")
                            .junoCodeSmall()
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(model.log) { line in
                        Text(line.text.isEmpty ? " " : line.text)
                            .junoCodeSmall()
                            .foregroundStyle(channelStyle(line.channel))
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                            .accessibilityLabel(
                                line.channel == .stderr ? "Error output: \(line.text)" : line.text
                            )
                    }
                }
                .padding(.vertical, JunoSpace.tight)
                .padding(.horizontal, JunoSpace.snug)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.junoTerminal)
            .overlay {
                if model.log.isEmpty {
                    Text("The development server's output appears here while it runs.")
                        .junoCaption()
                        .multilineTextAlignment(.center)
                        .padding(JunoSpace.regular)
                }
            }
            .onChange(of: model.log.last?.id) { _, newValue in
                guard let newValue else { return }
                proxy.scrollTo(newValue, anchor: .bottom)
            }
        }
    }

    private func channelStyle(_ channel: ToolOutputChannel) -> AnyShapeStyle {
        switch channel {
        case .stdout: AnyShapeStyle(.primary)
        case .stderr: AnyShapeStyle(Color.junoDanger)
        case .log: AnyShapeStyle(.secondary)
        }
    }

    private func copyLog() {
        let text = model.log.map(\.text).joined(separator: "\n")
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func elapsed(since date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        return seconds < 60
            ? "\(seconds)s"
            : String(format: "%dm %02ds", seconds / 60, seconds % 60)
    }
}

/// The preview's window scene.
///
/// Declared beside the view it presents so the window identifier and the value
/// type cannot drift apart. The host app adds `CodePreviewScene()` to its scene
/// body; opening one is
/// `openWindow(id: CodePreviewScene.windowID, value: CodePreviewTarget(workspaceRoot: root))`.
public struct CodePreviewScene: Scene {
    public static let windowID = "juno.code.preview"

    public init() {}

    public var body: some Scene {
        WindowGroup(id: Self.windowID, for: CodePreviewTarget.self) { $target in
            CodePreviewWindowView(target: target ?? CodePreviewTarget())
                .frame(minWidth: 520, minHeight: 360)
        }
        .defaultSize(width: 960, height: 760)
    }
}

/// An ephemeral WebKit preview.
///
/// The data store is non-persistent, so a preview never leaves cookies, local
/// storage or caches behind for the app to carry around, and every state the pill
/// shows comes from a navigation-delegate callback.
private struct CodePreviewWebView: NSViewRepresentable {
    let url: URL
    let reloadID: UUID
    let model: CodePreviewModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        // What shows before the page paints, and behind a page shorter than the
        // window. The system default is white, which flashes on every reload in
        // dark mode; the raised token matches the app in both appearances. The
        // page's own `prefers-color-scheme` still follows the Mac's setting,
        // because WebKit takes it from the view's effective appearance.
        webView.underPageBackgroundColor = NSColor(Color.junoRaised)
        // A preview of something being built is exactly where Web Inspector is
        // wanted, and it is off by default on modern WebKit.
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.lastURL = url
        context.coordinator.lastReloadID = reloadID
        webView.load(Self.request(for: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.model = model
        if context.coordinator.lastURL != url {
            context.coordinator.lastURL = url
            context.coordinator.lastReloadID = reloadID
            webView.load(Self.request(for: url))
        } else if context.coordinator.lastReloadID != reloadID {
            context.coordinator.lastReloadID = reloadID
            // A fresh request rather than `reload()`: after a failed provisional
            // navigation there is nothing to reload, and a retry against a server
            // that was still compiling is exactly when that happens.
            webView.load(Self.request(for: url))
        }
    }

    /// Cache is wrong for this surface. The whole point is to see the file that
    /// was just saved, and a dev server's own headers are not something Juno
    /// should have to trust for that.
    private static func request(for url: URL) -> URLRequest {
        URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var model: CodePreviewModel
        var lastURL: URL?
        var lastReloadID: UUID?

        init(model: CodePreviewModel) {
            self.model = model
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation: WKNavigation?) {
            model.reportLoadStarted()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            model.reportLoadFinished()
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            model.reportLoadFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            // A cancelled navigation is the previous request being replaced by the
            // one that superseded it, not a failure the reader should see.
            if (error as NSError).code == NSURLErrorCancelled { return }
            model.reportLoadFailed(error.localizedDescription)
        }
    }
}
