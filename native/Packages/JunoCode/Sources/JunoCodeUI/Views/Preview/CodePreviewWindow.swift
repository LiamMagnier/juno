import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
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
    /// Stable identity shared by the dock and pop-out window. Without this,
    /// both surfaces constructed separate models and could each start their own
    /// dev server for the same workspace.
    public var previewID: UUID
    public var workspaceRootPath: String?
    public var address: URL?
    /// The Code session that owns this preview. This is the security boundary
    /// for agent diagnostics; older scene-restoration values decode as nil and
    /// therefore remain visible to the reader but not to an agent tool.
    public var sessionID: CodeSessionID?

    public init(
        previewID: UUID = UUID(),
        workspaceRootPath: String? = nil,
        address: URL? = nil,
        sessionID: CodeSessionID? = nil
    ) {
        self.previewID = previewID
        self.workspaceRootPath = workspaceRootPath
        self.address = address
        self.sessionID = sessionID
    }

    public init(
        previewID: UUID = UUID(),
        workspaceRoot: URL?,
        address: URL? = nil,
        sessionID: CodeSessionID? = nil
    ) {
        self.previewID = previewID
        self.workspaceRootPath = workspaceRoot?.path
        self.address = address
        self.sessionID = sessionID
    }

    private enum CodingKeys: String, CodingKey {
        case previewID
        case workspaceRootPath
        case address
        case sessionID
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Scene restoration values from pre-sharing builds have no previewID.
        // Give those values a fresh identity rather than failing to restore the
        // window entirely.
        previewID = try values.decodeIfPresent(UUID.self, forKey: .previewID) ?? UUID()
        workspaceRootPath = try values.decodeIfPresent(String.self, forKey: .workspaceRootPath)
        address = try values.decodeIfPresent(URL.self, forKey: .address)
        sessionID = try values.decodeIfPresent(CodeSessionID.self, forKey: .sessionID)
    }

    var workspaceRoot: URL? {
        workspaceRootPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
    }
}

/// A startable script together with the package that owns it.
///
/// ``DevServerCommandDiscovery`` intentionally scans one package at a time. A
/// preview, however, is opened for a repository, and the package that serves a
/// page is often `apps/web` or `packages/site` rather than the repository root.
/// Keeping the owning directory on the command prevents the UI from finding a
/// useful script and then starting it from the wrong working directory.
struct CodePreviewDiscoveredCommand: Identifiable, Hashable, Sendable {
    let command: DevServerCommand
    let workspaceRoot: URL
    let workspaceDisplayName: String

    var id: String { "\(workspaceRoot.path)#\(command.id)" }
    var name: String { command.name }
    var commandLine: String { command.commandLine }
    var script: String { command.script }
    var startsAServer: Bool { command.startsAServer }
}

struct CodePreviewCommandSet: Hashable, Sendable {
    let commands: [CodePreviewDiscoveredCommand]
    let unavailableReason: String?

    var suggested: CodePreviewDiscoveredCommand? {
        commands.first { $0.startsAServer } ?? commands.first
    }
}

/// Finds preview scripts in the repository root and in shallow nested packages.
///
/// This is deliberately a preview concern rather than a general-purpose
/// workspace index. It is bounded, skips generated/dependency trees, and keeps
/// the existing ``DevServerCommandDiscovery`` as the source of truth for script
/// ranking and package-manager detection. The common `apps/*` and `packages/*`
/// monorepo layouts are covered without walking an entire checkout.
enum CodePreviewProjectDiscovery {
    private static let maximumPackageDepth = 3
    private static let maximumPackageCount = 48
    private static let ignoredDirectoryNames: Set<String> = [
        ".git", ".hg", ".svn", ".next", ".nuxt", ".turbo", ".cache",
        "node_modules", "vendor", "Pods", "DerivedData", "build", "dist",
        "coverage", ".venv",
    ]

    static func scan(workspaceRoot: URL) async -> CodePreviewCommandSet {
        // /var is a symlink on macOS. FileManager enumerates the real path,
        // so normalize both sides before producing relative package labels or
        // comparing the selected package with the repository root.
        let repositoryRoot = workspaceRoot
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let packageRoots = packageRoots(in: repositoryRoot)
        guard !packageRoots.isEmpty else {
            return CodePreviewCommandSet(
                commands: [],
                unavailableReason:
                    "No package.json was found in \(repositoryRoot.lastPathComponent) or its nested packages. Start your server yourself and type its address above."
            )
        }

        var discovered: [CodePreviewDiscoveredCommand] = []
        var rootPackageManager = packageManager(in: repositoryRoot)
        let hasRootPackage = packageRoots.contains { $0.path == repositoryRoot.path }
        var scanReasons: [String] = []

        for packageRoot in packageRoots {
            let result = await DevServerCommandDiscovery.scan(workspaceRoot: packageRoot)
            if hasRootPackage && packageRoot.path == repositoryRoot.path {
                rootPackageManager = result.packageManager ?? rootPackageManager
            }
            if let reason = result.unavailableReason {
                scanReasons.append(reason)
            }

            for command in result.commands {
                // A package in a pnpm/yarn/bun monorepo usually inherits the
                // root lockfile. Re-spell its command with that manager so a
                // nested `dev` script can still resolve hoisted workspace bins.
                let effectiveManager = packageRoot.path == repositoryRoot.path
                    ? result.packageManager
                    : rootPackageManager ?? result.packageManager
                discovered.append(
                    CodePreviewDiscoveredCommand(
                        command: command.withPackageManager(effectiveManager),
                        workspaceRoot: packageRoot,
                        workspaceDisplayName: displayName(
                            for: packageRoot,
                            relativeTo: repositoryRoot
                        )
                    )
                )
            }
        }

        // Preserve each package's existing script order, but make a real server
        // the default even when the root only contains lint/build scripts.
        let serverCommands = discovered.filter(\.startsAServer)
        let otherCommands = discovered.filter { !$0.startsAServer }
        let commands = serverCommands + otherCommands

        let reason: String?
        if commands.isEmpty {
            reason = packageRoots.count > 1
                ? "No startable scripts were found in \(repositoryRoot.lastPathComponent) or its nested packages."
                : scanReasons.first ?? "No development server script was found."
        } else {
            reason = nil
        }

        return CodePreviewCommandSet(commands: commands, unavailableReason: reason)
    }

    private static func packageManager(in root: URL) -> String? {
        let lockfiles: [(String, String)] = [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("bun.lock", "bun"),
            ("package-lock.json", "npm"),
        ]
        return lockfiles.first {
            FileManager.default.fileExists(atPath: root.appendingPathComponent($0.0).path)
        }?.1
    }

    private static func displayName(for packageRoot: URL, relativeTo repositoryRoot: URL) -> String {
        let packageComponents = packageRoot.standardizedFileURL.pathComponents
            .filter { $0 != "/" }
        let repositoryComponents = repositoryRoot.standardizedFileURL.pathComponents
            .filter { $0 != "/" }

        if packageComponents == repositoryComponents {
            return repositoryRoot.lastPathComponent.isEmpty ? "Workspace" : repositoryRoot.lastPathComponent
        }

        // FileManager can expose a symlink-resolved child (`/private/var/...`)
        // while the caller supplied `/var/...`. Find the repository path as a
        // contiguous component sequence instead of comparing raw strings.
        if packageComponents.count >= repositoryComponents.count,
           let start = packageComponents.indices.first(where: { index in
               let end = index + repositoryComponents.count
               guard end <= packageComponents.count else { return false }
               return Array(packageComponents[index..<end]) == repositoryComponents
           })
        {
            let tail = packageComponents.dropFirst(start + repositoryComponents.count)
            if !tail.isEmpty { return tail.joined(separator: "/") }
        }

        return packageRoot.lastPathComponent.isEmpty ? "Workspace" : packageRoot.lastPathComponent
    }

    private static func packageRoots(in workspaceRoot: URL) -> [URL] {
        var roots: [URL] = []
        let rootManifest = workspaceRoot.appendingPathComponent("package.json")
        if FileManager.default.fileExists(atPath: rootManifest.path) {
            roots.append(workspaceRoot)
        }

        guard let enumerator = FileManager.default.enumerator(
            at: workspaceRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            return roots
        }

        while let candidate = enumerator.nextObject() as? URL {
            let name = candidate.lastPathComponent
            if ignoredDirectoryNames.contains(name) {
                enumerator.skipDescendants()
                continue
            }

            let depth = candidate.pathComponents.count - workspaceRoot.pathComponents.count
            if depth > maximumPackageDepth + 1 {
                enumerator.skipDescendants()
                continue
            }

            guard name == "package.json",
                  candidate.deletingLastPathComponent() != workspaceRoot
            else { continue }

            roots.append(candidate.deletingLastPathComponent())
            if roots.count >= maximumPackageCount {
                break
            }
        }

        return roots.sorted { left, right in
            if left == workspaceRoot { return true }
            if right == workspaceRoot { return false }
            return left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }
}

private extension DevServerCommand {
    /// Rebuilds only the invocation spelling; the discovered script and its
    /// server ranking remain unchanged.
    func withPackageManager(_ manager: String?) -> DevServerCommand {
        guard let manager else { return self }
        let invocation = manager == "yarn"
            ? "yarn \(name)"
            : "\(manager) run \(name)"
        guard invocation != commandLine else { return self }
        return DevServerCommand(
            name: name,
            commandLine: invocation,
            script: script,
            startsAServer: startsAServer
        )
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
    private static var sessions: [UUID: CodePreviewModel] = [:]
    static let diagnosticsMessageName = "junoPreviewDiagnostics"
    static let diagnosticsScript = """
    (() => {
      const stringify = (value) => {
        try {
          if (value instanceof Error) return value.stack || value.message || String(value);
          if (typeof value === "string") return value;
          if (typeof value === "undefined") return "undefined";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        } catch (_) {
          return String(value);
        }
      };
      const send = (kind, values) => {
        try {
          window.webkit.messageHandlers.junoPreviewDiagnostics.postMessage({
            kind,
            message: values.map(stringify).join(" ")
          });
        } catch (_) {}
      };
      ["error", "warn"].forEach((level) => {
        const original = console[level];
        console[level] = (...values) => {
          send("console." + level, values);
          if (original) original.apply(console, values);
        };
      });
      window.addEventListener("error", (event) => {
        send("runtime.error", [event.message + " (" + event.filename + ":" + event.lineno + ")"]);
      });
      window.addEventListener("unhandledrejection", (event) => {
        send("runtime.unhandledrejection", [event.reason]);
      });
    })();
    """

    let previewID: UUID
    let workspaceRoot: URL?
    let sessionID: CodeSessionID?

    private(set) var serverState: DevServerState = .stopped
    private(set) var log: [DevServerLogLine] = []
    /// How many lines fell out of the buffer, so the pane can say it is not the
    /// whole story rather than silently starting mid-sentence.
    private(set) var discardedLineCount = 0
    private(set) var commandSet: CodePreviewCommandSet?
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
    private(set) var browserDiagnostics: [String] = []

    /// A dev server prints its address before it can answer a request — Next
    /// announces the port, then spends a few seconds compiling. Retrying a real
    /// request a bounded number of times is what turns that race into a page
    /// instead of an error the reader has to clear by hand.
    private static let maximumReconnectAttempts = 8
    /// A watch-mode server prints for hours; this is the tail worth keeping in
    /// memory for a window that may be open all day.
    private static let maximumLogLines = 2_000

    private let service: DevServerService
    private var pump: Task<Void, Never>?
    private var reconnect: Task<Void, Never>?
    private var quitObserver: NSObjectProtocol?
    private var activeSurfaceCount = 0
    private weak var activeWebView: WKWebView?
    private let diagnosticsRedactor = SecretRedactor()

    static func shared(for target: CodePreviewTarget) -> CodePreviewModel {
        if let existing = sessions[target.previewID] {
            return existing
        }
        let model = CodePreviewModel(target: target)
        sessions[target.previewID] = model
        return model
    }

    init(target: CodePreviewTarget) {
        self.previewID = target.previewID
        self.workspaceRoot = target.workspaceRoot
        self.sessionID = target.sessionID
        self.service = target.workspaceRoot.map {
            DevServerService.contained(workspaceRootURL: $0)
        }
           ?? DevServerService()
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
        commandSet = await CodePreviewProjectDiscovery.scan(workspaceRoot: workspaceRoot)
    }

    var selectedCommand: CodePreviewDiscoveredCommand? {
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

    var isServerContained: Bool { service.isContained }

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

    /// A preview target can have two surfaces: the dock and the optional
    /// pop-out. Keep the server alive until the last surface disappears.
    func acquireSurface() {
        activeSurfaceCount += 1
    }

    func releaseSurface() {
        guard activeSurfaceCount > 0 else { return }
        activeSurfaceCount -= 1
        guard activeSurfaceCount == 0 else { return }
        shutDown()
        Self.sessions.removeValue(forKey: previewID)
    }

    func start() {
        guard let command = selectedCommand else { return }
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

        let events = service.start(
            command: command.commandLine,
            workspaceRoot: command.workspaceRoot
        )
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
        activeWebView = nil
        browserDiagnostics.removeAll()
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

    /// Registers the WebKit surface currently owned by the dock or pop-out.
    /// There can be two surfaces for one preview, but both point to the same
    /// model and the latest attached web view is the one the agent should see.
    func attach(webView: WKWebView) {
        activeWebView = webView
    }

    func recordBrowserDiagnostic(kind: String, message: String) {
        let cleanKind = String(kind.prefix(80))
        let cleanMessage = diagnosticsRedactor.redact(
            message.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        guard !cleanMessage.isEmpty else { return }
        let line = "[\(cleanKind)] \(String(cleanMessage.prefix(2_000)))"
        browserDiagnostics.append(line)
        if browserDiagnostics.count > 100 {
            browserDiagnostics.removeFirst(browserDiagnostics.count - 100)
        }
    }

    /// Inspects the active preview for one granted workspace. This stays on the
    /// main actor because WebKit is UI state; the Code tool reaches it through
    /// `MainActor.run`, never by holding a WebKit object in the runtime layer.
    static func inspectActive(
        sessionID: CodeSessionID,
        includeScreenshot: Bool,
        maxText: Int
    ) async throws -> CodePreviewInspection {
        guard let model = sessions.values.first(where: { model in
            model.activeSurfaceCount > 0 && model.sessionID == sessionID
        }) else {
            throw CodePreviewInspectionError.noActivePreview
        }
        return try await model.inspect(includeScreenshot: includeScreenshot, maxText: maxText)
    }

    private func inspect(includeScreenshot: Bool, maxText: Int) async throws -> CodePreviewInspection {
        guard let webView = activeWebView else {
            throw CodePreviewInspectionError.previewNotReady(
                detail: "the WebKit page is still attaching"
            )
        }
        guard let address else {
            throw CodePreviewInspectionError.previewNotReady(
                detail: "no local server address has been opened"
            )
        }
        guard serverState.isLive, serverState.url == address else {
            throw CodePreviewInspectionError.previewNotReady(
                detail: "Juno did not start the server currently shown in the Preview"
            )
        }

        let boundedText = min(max(maxText, 200), 12_000)
        let script = """
        (() => ({
          url: window.location.href || "",
          title: document.title || "",
          text: (document.body && document.body.innerText || "").slice(0, \(boundedText)),
          interactive: document.querySelectorAll("a,button,input,textarea,select,[role='button']").length
        }))()
        """

        let value: Any
        do {
            guard let evaluated = try await webView.evaluateJavaScript(script) else {
                throw CodePreviewInspectionError.pageEvaluationFailed(
                    "the page returned no diagnostics"
                )
            }
            value = evaluated
        } catch {
            throw CodePreviewInspectionError.pageEvaluationFailed(error.localizedDescription)
        }
        guard let page = value as? [String: Any] else {
            throw CodePreviewInspectionError.pageEvaluationFailed(
                "the page returned an unexpected diagnostics shape"
            )
        }

        let rawPageURL = (page["url"] as? String) ?? address.absoluteString
        let safePageURL = diagnosticsRedactor.redact(rawPageURL)
        let pageURL = URL(string: safePageURL) ?? address
        let title = diagnosticsRedactor.redact(page["title"] as? String ?? "")
        let visibleText = diagnosticsRedactor.redact(page["text"] as? String ?? "")
        let interactiveCount = page["interactive"] as? Int
            ?? (page["interactive"] as? NSNumber)?.intValue
            ?? 0

        var screenshot: ModelImage?
        if includeScreenshot {
            do {
                let image = try await webView.takeSnapshot(configuration: nil)
                guard let png = Self.pngData(from: image) else {
                    throw CodePreviewInspectionError.screenshotFailed(
                        "WebKit returned an image Juno could not encode"
                    )
                }
                screenshot = ModelImage(mediaType: "image/png", data: png, detail: .high)
            } catch let error as CodePreviewInspectionError {
                throw error
            } catch {
                throw CodePreviewInspectionError.screenshotFailed(error.localizedDescription)
            }
        }

        return CodePreviewInspection(
            url: pageURL,
            title: title,
            visibleText: String(visibleText.prefix(boundedText)),
            interactiveElementCount: max(0, interactiveCount),
            diagnostics: Array(browserDiagnostics.suffix(20)),
            screenshot: screenshot
        )
    }

    private static func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff)
        else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    // MARK: - Page reporting

    func reportLoadStarted() {
        browserDiagnostics.removeAll()
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
        _model = State(initialValue: CodePreviewModel.shared(for: target))
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
        .onAppear { model.acquireSurface() }
        .task { await model.discover() }
        .onDisappear { model.releaseSurface() }
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
                        Text("\(command.workspaceDisplayName) · \(command.script)")
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
                        "Juno runs \(command.commandLine) in \(command.workspaceDisplayName) and opens the address it prints.",
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

/// The in-workspace version of the preview.
///
/// The window view remains available for a second display, but the primary Code
/// flow should not eject the reader into another window just to check a page.
/// This dock deliberately shares CodePreviewModel with that surface: command
/// discovery, server ownership, URL detection, retries, redaction and process
/// teardown therefore have one implementation and one set of semantics.
public struct CodePreviewDock: View {
    @State private var model: CodePreviewModel
    private let close: () -> Void
    private let openInWindow: (() -> Void)?
    @State private var isLogVisible = false

    public init(
        target: CodePreviewTarget,
        close: @escaping () -> Void,
        openInWindow: (() -> Void)? = nil
    ) {
        _model = State(initialValue: CodePreviewModel.shared(for: target))
        self.close = close
        self.openInWindow = openInWindow
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color.junoSeparator)
            viewport
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if isLogVisible {
                log
            }
        }
        .background(Color.junoCanvasWarm)
        .onAppear { model.acquireSurface() }
        .task {
            await model.discover()
            // Opening the pane is the user's request to inspect the project.
            // Start the discovered command immediately, while keeping the
            // explicit Start control for projects without a safe auto-start path.
            if model.address == nil, model.canStart {
                model.start()
            }
        }
        .onDisappear { model.releaseSurface() }
        .accessibilityIdentifier("juno.code.preview.dock")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(spacing: JunoSpace.tight) {
                Label("Preview", systemImage: "rectangle.on.rectangle")
                    .junoRowLabel()
                status
                Spacer(minLength: JunoSpace.tight)
                if let openInWindow {
                    Button {
                        openInWindow()
                    } label: {
                        Image(systemName: "macwindow.on.rectangle")
                    }
                    .buttonStyle(.borderless)
                    .help("Open the preview in a separate window")
                    .accessibilityLabel("Open preview in separate window")
                }
                Button(action: close) {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Close the preview pane")
                .accessibilityLabel("Close preview pane")
                .accessibilityIdentifier("juno.code.preview.close")
            }

            HStack(spacing: JunoSpace.tight) {
                runButton
                commandMenu
                Button {
                    model.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(model.address == nil)
                .help("Reload the preview")
                .accessibilityLabel("Reload preview")

                Spacer(minLength: JunoSpace.tight)

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
                .help(isLogVisible ? "Hide server log" : "Show server log")
                .accessibilityLabel(isLogVisible ? "Hide server log" : "Show server log")
            }

            HStack(spacing: JunoSpace.tight) {
                TextField("localhost:3000", text: $model.addressText)
                    .textFieldStyle(.roundedBorder)
                    .junoCode()
                    .onSubmit { model.openTypedAddress() }
                    .help(
                        model.addressValidationMessage
                            ?? "The address detected from the local development server"
                    )
                    .accessibilityLabel("Preview address")
                    .accessibilityIdentifier("juno.code.preview.dock.address")

                Button("Open") {
                    model.openTypedAddress()
                }
                .controlSize(.small)
                .disabled(model.addressText.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if let message = model.addressValidationMessage {
                Text(message)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, JunoSpace.snug)
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
            .help("Stop the local development server")
            .accessibilityIdentifier("juno.code.preview.dock.stop")
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
            .help(model.startUnavailableReason ?? "Start the local development server")
            .accessibilityIdentifier("juno.code.preview.dock.start")
        }
    }

    private var commandMenu: some View {
        Menu {
            if let commands = model.commandSet?.commands, !commands.isEmpty {
                ForEach(commands) { command in
                    Button {
                        model.chosenCommandID = command.id
                    } label: {
                        Text(command.commandLine)
                        Text("\(command.workspaceDisplayName) · \(command.script)")
                    }
                }
            }
        } label: {
            Text(model.selectedCommand?.commandLine ?? "No command")
                .junoCodeSmall()
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: 150, alignment: .leading)
        .disabled(model.commandSet?.commands.isEmpty ?? true)
        .help(
            model.selectedCommand
                .map { "\($0.name): \($0.script)" }
                ?? model.commandSet?.unavailableReason
                ?? "Reading package.json…"
        )
        .accessibilityLabel("Development server command")
        .accessibilityIdentifier("juno.code.preview.dock.command")
    }

    @ViewBuilder
    private var viewport: some View {
        if let address = model.address {
            ZStack(alignment: .bottomLeading) {
                CodePreviewWebView(url: address, reloadID: model.reloadID, model: model)
                statusPill
                    .padding(JunoSpace.snug)
            }
        } else {
            VStack(spacing: JunoSpace.snug) {
                if model.serverState == .starting {
                    ProgressView()
                    Text("Starting the local preview…")
                        .junoRowLabel()
                } else {
                    Image(systemName: "macwindow")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(
                        model.serverState == .stopped
                            ? "Preview is ready"
                            : "Preview is unavailable"
                    )
                    .junoRowLabel()
                }

                Text(
                    model.serverState == .stopped
                        ? "Juno will start the workspace's development server and open the address it prints."
                        : model.startUnavailableReason
                            ?? "Check the server log for the command's output."
                )
                .junoCaption()
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)

                if case .failed(let reason) = model.serverState {
                    Text(reason)
                        .junoCodeSmall()
                        .foregroundStyle(Color.junoDanger)
                        .lineLimit(4)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 340)
                }
            }
            .padding(JunoSpace.region)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var status: some View {
        let state = statusState
        return HStack(spacing: JunoSpace.hairline) {
            if state.busy {
                ProgressView().controlSize(.mini)
            } else {
                Circle()
                    .fill(state.tint)
                    .frame(width: 6, height: 6)
            }
           Text(state.label)
               .junoCaption()
               .foregroundStyle(.secondary)
               .lineLimit(1)
               .truncationMode(.middle)
            if model.isServerContained {
                Image(systemName: "lock.shield.fill")
                    .foregroundStyle(Color.junoSuccess)
                    .help("The preview server is contained to this workspace with network access disabled")
                    .accessibilityLabel("Preview server sandboxed")
            } else if model.workspaceRoot != nil {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(Color.junoCaution)
                    .help("Kernel containment is unavailable on this Mac; the preview still uses a scrubbed environment")
                    .accessibilityLabel("Preview server containment unavailable")
            }
       }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Preview \(state.label)")
    }

    private var statusPill: some View {
        let state = statusState
        return HStack(spacing: JunoSpace.hairline) {
            Circle()
                .fill(state.tint)
                .frame(width: 6, height: 6)
            Text(state.label)
                .junoCodeSmall()
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, JunoSpace.snug)
        .padding(.vertical, JunoSpace.tight)
        .junoFloatingChrome(cornerRadius: JunoRadius.floating)
        .accessibilityHidden(true)
    }

    private var statusState: (label: String, tint: Color, busy: Bool) {
        switch model.serverState {
        case .starting:
            return ("Starting", Color.junoCaution, true)
        case .running:
            switch model.loadState {
            case .idle:
                return ("Server running", Color.junoCaution, false)
            case .loading:
                return ("Loading", Color.junoCaution, true)
            case .loaded:
                return ("Running", Color.junoSuccess, false)
            case .failed:
                return (
                    model.isAwaitingServer ? "Waiting for server" : "Page unavailable",
                    Color.junoCaution,
                    model.isAwaitingServer
                )
            }
        case .failed:
            return ("Server failed", Color.junoDanger, false)
        case .exited:
            return ("Server exited", Color.junoDanger, false)
        case .stopped:
            return (
                model.loadState == .loaded ? "Connected" : "Not started",
                model.loadState == .loaded ? Color.junoSuccess : Color.secondary,
                false
            )
        }
    }

    private var log: some View {
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                if model.discardedLineCount > 0 {
                    Text("\(model.discardedLineCount) earlier lines are no longer held")
                        .junoCodeSmall()
                        .foregroundStyle(.tertiary)
                }
                ForEach(Array(model.log.suffix(240))) { line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .junoCodeSmall()
                        .foregroundStyle(
                            line.channel == .stderr ? Color.junoDanger : Color.primary
                        )
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 150)
        .background(Color.junoTerminal)
        .overlay(alignment: .top) {
            Rectangle().fill(Color.junoSeparator).frame(height: 1)
        }
        .accessibilityLabel("Server log")
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
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: CodePreviewModel.diagnosticsScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        configuration.userContentController.add(
            context.coordinator,
            name: CodePreviewModel.diagnosticsMessageName
        )
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
        context.coordinator.webView = webView
        model.attach(webView: webView)
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
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var model: CodePreviewModel
        var lastURL: URL?
        var lastReloadID: UUID?
        weak var webView: WKWebView?

        init(model: CodePreviewModel) {
            self.model = model
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == CodePreviewModel.diagnosticsMessageName,
                  let body = message.body as? [String: Any],
                  let kind = body["kind"] as? String,
                  let text = body["message"] as? String
            else { return }
            model.recordBrowserDiagnostic(kind: kind, message: text)
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
