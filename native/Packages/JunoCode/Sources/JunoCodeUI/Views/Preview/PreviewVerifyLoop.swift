import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

// The visual verify loop, page side (CODE_AGENT_SPEC §4.6):
//
// 1. Baseline: console and server errors count as new from the run's latest
//    UI edit (its start before any), recorded as the edit is appended, so a
//    fixed error stops counting and a repeated one counts again.
// 2. Settle: after UI edits, the page is given until the DOM and network go
//    quiet (bounded at 10 s, or an error overlay appears), and the server log
//    since the edit is scanned for compile errors.
// 3. The stop check (PreviewUIGate, rule 8) hands the model `ui_unchecked`
//    naming the routes; the model checks with preview_browser.
// 4. Evidence: whenever a screenshot of a preview route is taken, the runtime
//    mints a UIVerificationRecord from what it observed against the baseline
//    and returns it as the tool's side effect, so it lands in the transcript
//    as `uiVerificationRecorded` — never from model text.

/// Everything the Preview tracks per session, shared by the tools, the pane
/// and the stop check. Thread-safe; its page work hops to the main actor.
final class PreviewSessionHub: @unchecked Sendable {
    static let shared = PreviewSessionHub()

    final class Entry: @unchecked Sendable {
        let sessionID: CodeSessionID
        let workspaceRoot: URL
        let verify: PreviewVerifyState
        /// The names this session's snapshots gave its refs.
        let labels = PreviewRefLabels()
        /// The consequential calls this session's reader was asked about.
        let floorApprovals = PreviewFloorApprovals()
        let lock = NSLock()
        var serverErrorsSinceEdit: [String] = []
        var settleTask: Task<Void, Never>?
        var observedStores: Set<ObjectIdentifier> = []

        init(sessionID: CodeSessionID, workspaceRoot: URL, verify: PreviewVerifyState) {
            self.sessionID = sessionID
            self.workspaceRoot = workspaceRoot
            self.verify = verify
        }
    }

    private let lock = NSLock()
    private var entries: [CodeSessionID: Entry] = [:]
    private var catalogs: [String: (at: Date, catalog: PreviewLaunchCatalog)] = [:]
    let registry: JunoCodeLocal.PreviewRegistry

    /// The workspace's launch catalog, read at most every few seconds: an
    /// edit batch asks for it once per file.
    func catalog(for root: URL) -> PreviewLaunchCatalog {
        let key = root.standardizedFileURL.path
        if let cached = lock.withLock({ catalogs[key] }), Date().timeIntervalSince(cached.at) < 3 {
            return cached.catalog
        }
        let catalog = LaunchConfigurationStore.load(workspaceRoot: root)
        lock.withLock { catalogs[key] = (Date(), catalog) }
        return catalog
    }

    init(registry: JunoCodeLocal.PreviewRegistry = .shared) {
        self.registry = registry
    }

    /// The session's entry, created on first use.
    func entry(for sessionID: CodeSessionID, workspaceRoot: URL) -> Entry {
        lock.withLock {
            if let existing = entries[sessionID] { return existing }
            let registry = self.registry
            let root = workspaceRoot
            let verify = PreviewVerifyState(sessionID: sessionID) { [weak self] in
                await self?.environment(for: sessionID, workspaceRoot: root, registry: registry)
                    ?? PreviewVerifyEnvironment(autoVerify: false, webRoots: [], hasLiveServer: false)
            }
            let entry = Entry(sessionID: sessionID, workspaceRoot: workspaceRoot, verify: verify)
            entries[sessionID] = entry
            return entry
        }
    }

    func existingEntry(for sessionID: CodeSessionID) -> Entry? {
        lock.withLock { entries[sessionID] }
    }

    /// Follows the session's transcript: revisions and UI records for the
    /// stop check, settling for the page, the reader's new
    /// message lifting a Stop, and a deleted session's leases.
    func observe(store: CodeSessionStore, sessionID: CodeSessionID, workspaceRoot: URL) async {
        let entry = entry(for: sessionID, workspaceRoot: workspaceRoot)
        let identifier = ObjectIdentifier(store)
        let isNew = entry.lock.withLock { entry.observedStores.insert(identifier).inserted }
        guard isNew else { return }
        entry.verify.replay(await store.events(for: sessionID))
        let registry = self.registry
        await store.addObserver { [weak self, weak entry] update in
            guard let self, let entry else { return }
            switch update {
            case let .eventAppended(event) where event.sessionID == sessionID:
                // Synchronous: the stop check that follows this append reads
                // the new revision.
                entry.verify.observe(event.payload)
                self.react(to: event.payload, entry: entry)
            case let .sessionRemoved(removed) where removed == sessionID:
                Task { await registry.releaseAll(session: sessionID) }
            default:
                break
            }
        }
    }

    private func react(to payload: SessionEventPayload, entry: Entry) {
        switch payload {
        case .userPrompt:
            entry.lock.withLock { entry.serverErrorsSinceEdit.removeAll() }
            let sessionID = entry.sessionID
            let registry = self.registry
            Task { @MainActor in
                for key in await registry.leasedKeys(session: sessionID) {
                    PreviewPageRegistry.shared.existing(key)?.allowAgent()
                }
            }
        case let .fileChanged(change):
            let root = entry.workspaceRoot
            let path = change.path.value
            Task {
                let catalog = self.catalog(for: root)
                let roots = await self.webRoots(for: root)
                guard catalog.autoVerify, PreviewUIEdits.isUIEdit(path, webRoots: roots) else { return }
                self.scheduleSettle(entry)
            }
        default:
            break
        }
    }

    // MARK: - Settling

    /// After UI edits: let the page settle, then read the server log since
    /// the edit for compile errors (§4.6 step 2). Debounced, so an edit
    /// batch settles once.
    private func scheduleSettle(_ entry: Entry) {
        let registry = self.registry
        entry.lock.withLock {
            entry.settleTask?.cancel()
            entry.settleTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled, let self else { return }
                var errors: [String] = []
                let since = entry.verify.errorBaseline(webRoots: await self.webRoots(for: entry.workspaceRoot)) ?? .distantPast
                for key in await registry.leasedKeys(session: entry.sessionID) {
                    if let page = PreviewPageRegistry.shared.existing(key), page.origin != nil {
                        _ = await PreviewBrowserEngine(page: page, workspaceRoot: entry.workspaceRoot).settle(timeout: 10)
                    }
                    errors += await registry.compileErrors(key, since: 0).filter { $0.at >= since }.map(\.text)
                }
                entry.lock.withLock { entry.serverErrorsSinceEdit = Array(errors.suffix(5)) }
            }
        }
    }

    // MARK: - Evidence

    /// Mints the record for a screenshot of `key`'s page (§4.6 step 5).
    @MainActor
    func mint(
        entry: Entry,
        key: PreviewKey,
        page: PreviewPage,
        outcome: PreviewActionOutcome,
        engine: PreviewBrowserEngine
    ) async -> UIVerificationRecord? {
        guard outcome.screenshotHash != nil, page.isOnPreviewOrigin, let route = outcome.route ?? page.currentURL.map(PreviewBrowserEngine.route(of:)) else {
            return nil
        }
        let since = entry.verify.errorBaseline(webRoots: await webRoots(for: entry.workspaceRoot)) ?? .distantPast
        let consoleErrors = page.diagnostics.console.filter { $0.level == .error && $0.at >= since }
        let overlay = ((try? await engine.js("return __juno.overlay()", [:])) as? String).flatMap { $0.isEmpty ? nil : $0 }
        let serverErrors = await registry.logErrors(key, since: 0)
            .filter { $0.at >= since }
            .map(\.text)
            .filter { !$0.lowercased().contains("warn") }
        return PreviewEvidence.mint(PreviewObservation(
            route: route,
            viewport: page.viewport.label,
            httpStatus: page.mainDocumentStatus,
            newConsoleErrors: consoleErrors.map(\.text),
            errorOverlay: overlay,
            newServerErrors: serverErrors,
            screenshotHash: outcome.screenshotHash,
            workspaceRevision: entry.verify.workspaceRevision
        ))
    }

    // MARK: - Environment for the stop check

    func environment(for sessionID: CodeSessionID, workspaceRoot: URL, registry: JunoCodeLocal.PreviewRegistry) async -> PreviewVerifyEnvironment {
        let catalog = catalog(for: workspaceRoot)
        let leased = await registry.leasedKeys(session: sessionID)
        var live = false
        for key in leased {
            if await registry.snapshot(key)?.agentURL != nil { live = true }
        }
        let errors = existingEntry(for: sessionID).map { entry in entry.lock.withLock { entry.serverErrorsSinceEdit } } ?? []
        return PreviewVerifyEnvironment(
            autoVerify: catalog.autoVerify,
            webRoots: await webRoots(for: workspaceRoot),
            hasLiveServer: live,
            serverErrorsSinceEdit: errors
        )
    }

    /// The folders whose UI edits are checked: those of the configurations a
    /// launch file names, and of any preview running now (§4.6: "a running
    /// or configured web configuration"). What discovery merely proposes is
    /// neither, so a Node backend with a `dev` script does not send every
    /// `.ts` edit to the Preview until a file says it is a website or a
    /// server for it runs.
    func webRoots(for root: URL) async -> [String] {
        let running = await registry.snapshots(checkoutRoot: root)
            .filter(\.phase.isLive)
            .compactMap(\.configuration)
        return Self.webRoots(catalog(for: root), running: running)
    }

    static func webRoots(_ catalog: PreviewLaunchCatalog, running: [ResolvedPreviewConfiguration] = []) -> [String] {
        var roots: [String] = []
        let configured = catalog.configurations.filter { $0.source != .discovered }
        for configuration in configured + running {
            let root = configuration.isAttach ? "." : configuration.workingDirectoryDisplay
            if !roots.contains(root) { roots.append(root) }
        }
        return roots
    }
}
