import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import Observation
import WebKit

/// The session's lease on its Preview: the dev servers it holds, which keep
/// running across session switches, and the page the agent drives
/// (CODE_AGENT_SPEC §4.1). The pane reads and drives the Preview through this
/// model; the agent through its tools; both reach the same registry.
///
/// Owned by Lane D (Preview and browser).
@MainActor
@Observable
public final class PreviewLeaseModel {
    public private(set) var sessionID: CodeSessionID?
    public private(set) var workspaceRoot: URL?
    public private(set) var catalog = PreviewLaunchCatalog(configurations: [])
    /// Every preview of this checkout, running or not.
    public private(set) var snapshots: [PreviewServerSnapshot] = []
    /// The configuration the pane shows.
    public var selectedName: String?
    /// A configuration waiting for the reader's approval before it starts.
    public private(set) var pendingApproval: ResolvedPreviewConfiguration?
    /// A problem from the last reader action, in words.
    public private(set) var notice: String?
    /// What the last reader action did, in words (a saved file).
    public private(set) var message: String?
    /// Opens the Simulator pane, for a project that is an app rather than a
    /// site. Set by the workbench; the pane offers it only when it is.
    @ObservationIgnored public var simulatorOpener: (@MainActor () -> Void)?
    /// Annotate mode (§5.15): the reader is picking an element.
    public var isAnnotating = false
    /// The element picked, waiting for the reader's note.
    public var pendingAnnotation: PreviewAnnotation?
    /// Where a finished annotation goes: the session's composer. Set by the
    /// workbench; annotate is offered only when it is.
    @ObservationIgnored public var annotationSink: (@MainActor (PreviewAnnotation) -> Void)?

    @ObservationIgnored private let registry: JunoCodeLocal.PreviewRegistry
    @ObservationIgnored private let settings: PreviewLocalSettings
    @ObservationIgnored private var observer: UUID?
    @ObservationIgnored private var observerTask: Task<Void, Never>?

    public init() {
        self.registry = .shared
        self.settings = .shared
    }

    init(registry: JunoCodeLocal.PreviewRegistry, settings: PreviewLocalSettings) {
        self.registry = registry
        self.settings = settings
    }

    /// Ties the model to its session and checkout and follows the registry.
    public func bind(sessionID: CodeSessionID?, workspaceRoot: URL?) {
        guard self.sessionID != sessionID || self.workspaceRoot != workspaceRoot || observer == nil else {
            refreshCatalog()
            return
        }
        self.sessionID = sessionID
        self.workspaceRoot = workspaceRoot
        refreshCatalog()
        observerTask?.cancel()
        let previous = observer
        observer = nil
        let box = WeakLeaseBox(self)
        observerTask = Task { [registry] in
            if let previous { await registry.removeObserver(previous) }
            let id = await registry.addObserver { _ in
                Task { @MainActor in await box.model?.refreshSnapshots() }
            }
            await MainActor.run { box.model?.observer = id }
            await box.model?.refreshSnapshots()
        }
    }

    public func refreshCatalog() {
        guard let workspaceRoot else { return }
        catalog = LaunchConfigurationStore.load(workspaceRoot: workspaceRoot)
        if selectedName == nil || catalog.configuration(named: selectedName ?? "") == nil && !snapshots.contains(where: { $0.key.name == selectedName }) {
            selectedName = catalog.defaultConfiguration?.name
        }
    }

    func refreshSnapshots() async {
        guard let workspaceRoot else { return }
        let next = await registry.snapshots(checkoutRoot: workspaceRoot)
        snapshots = next
        if let sessionID, selectedName == nil || !next.contains(where: { $0.key.name == selectedName }) {
            if let leased = next.first(where: { $0.leaseHolders.contains(sessionID) && $0.phase.isLive }) {
                selectedName = leased.key.name
            }
        }
        syncPage()
    }

    // MARK: - Reading

    public var selectedConfiguration: ResolvedPreviewConfiguration? {
        selectedName.flatMap { catalog.configuration(named: $0) }
    }

    public var selectedSnapshot: PreviewServerSnapshot? {
        guard let selectedName else { return nil }
        return snapshots.first { $0.key.name == selectedName }
    }

    public var selectedKey: PreviewKey? {
        guard let workspaceRoot, let selectedName else { return nil }
        return PreviewKey(checkoutRoot: workspaceRoot, name: selectedName)
    }

    /// The page of the selected preview, once its server answers.
    public var page: PreviewPage? {
        guard let key = selectedKey, selectedSnapshot?.phase.url != nil else { return nil }
        return PreviewPageRegistry.shared.existing(key)
    }

    /// Points the selected preview's page at its server, outside any view
    /// update.
    func syncPage() {
        guard let key = selectedKey, let snapshot = selectedSnapshot, let url = snapshot.phase.url else { return }
        let page = PreviewPageRegistry.shared.page(for: key)
        if page.origin.map({ !PreviewOrigin.sameOrigin($0, url) }) ?? true {
            page.open(origin: url, extraOrigins: snapshot.configuration?.allowedExternalOrigins ?? [])
        }
    }

    /// The subtitle: state in words (§4.7).
    public var statusSentence: String {
        if let snapshot = selectedSnapshot { return snapshot.statusSentence }
        if let configuration = selectedConfiguration {
            return "Not running · \(PreviewConfigurationDescription.commandText(configuration))"
        }
        if !catalog.issues.isEmpty { return "The launch file did not read" }
        return "No server found in this project"
    }

    public func needsApproval(_ configuration: ResolvedPreviewConfiguration) -> Bool {
        guard let workspaceRoot else { return true }
        // An attach `url` is asked about too: it points the page (and the
        // agent's input) at another server on this Mac.
        if settings.isApproved(configuration, in: workspaceRoot) { return false }
        if let sessionID, PreviewConfigApprovals.shared.isApproved(configuration, root: workspaceRoot, session: sessionID) {
            return false
        }
        return true
    }

    /// Whether to ask about the internet now: the server tried to reach a
    /// host while offline, and the reader has not answered for these bytes.
    public var internetQuestion: (host: String, configuration: ResolvedPreviewConfiguration)? {
        guard let workspaceRoot, let snapshot = selectedSnapshot, let host = snapshot.blockedOutboundHost,
              let configuration = snapshot.configuration,
              settings.shouldAskAboutInternet(for: configuration, in: workspaceRoot)
        else { return nil }
        return (host, configuration)
    }

    /// Whether to ask about a taken port now: the selected configuration's
    /// port was in use, its file leaves `autoPort` unset, and the reader has
    /// not answered (PV-15).
    public var portQuestion: (conflict: PreviewPortConflict, configuration: ResolvedPreviewConfiguration)? {
        guard let workspaceRoot, let snapshot = selectedSnapshot, let conflict = snapshot.portConflict,
              let configuration = snapshot.configuration ?? selectedConfiguration,
              settings.shouldAskAboutPort(for: configuration, in: workspaceRoot)
        else { return nil }
        return (conflict, configuration)
    }

    public var keepsSignIn: Bool {
        workspaceRoot.map { settings.project($0).persistSignIn } ?? false
    }

    public var allowsInspectionScripts: Bool {
        workspaceRoot.map { settings.project($0).allowEval } ?? false
    }

    // MARK: - Reader actions

    /// Start pressed: a configuration the reader has not approved shows its
    /// card first (PV-33, PV-35).
    public func requestStart(_ name: String? = nil) {
        notice = nil
        message = nil
        refreshCatalog()
        guard let configuration = (name ?? selectedName).flatMap({ catalog.configuration(named: $0) })
            ?? (name == nil ? catalog.defaultConfiguration : nil)
        else {
            if catalog.configurations.isEmpty {
                notice = fileProblem != nil
                    ? "Fix the launch file to start a server; Alevr found no other server to start in the project."
                    : "Alevr found no server to start in this project. Add .juno/launch.json to say how it starts."
            } else {
                notice = "There is no configuration named \(name ?? selectedName ?? "")."
            }
            return
        }
        selectedName = configuration.name
        if needsApproval(configuration) {
            pendingApproval = configuration
        } else {
            start(configuration)
        }
    }

    /// The card's answer.
    public func resolveApproval(start: Bool, always: Bool) {
        guard let configuration = pendingApproval, let workspaceRoot else { return }
        pendingApproval = nil
        guard start else { return }
        if always {
            settings.approve(configuration, in: workspaceRoot)
        } else if let sessionID {
            PreviewConfigApprovals.shared.approve(configuration, root: workspaceRoot, session: sessionID)
        }
        self.start(configuration)
    }

    private func start(_ configuration: ResolvedPreviewConfiguration) {
        guard let workspaceRoot else { return }
        let session = sessionID
        Task { [registry] in
            let outcome = await registry.start(configuration, checkoutRoot: workspaceRoot, session: session)
            await MainActor.run {
                if case let .failed(reason) = outcome.result { self.notice = reason }
            }
            await self.refreshSnapshots()
        }
    }

    public func stop() {
        guard let key = selectedKey else { return }
        Task { [registry] in
            await registry.stop(key)
            await self.refreshSnapshots()
        }
    }

    public func restart() {
        guard let configuration = selectedConfiguration, let workspaceRoot else { return }
        if needsApproval(configuration) {
            pendingApproval = configuration
            return
        }
        let session = sessionID
        Task { [registry] in
            _ = await registry.restart(configuration, checkoutRoot: workspaceRoot, session: session)
            await self.refreshSnapshots()
        }
    }

    /// The reader's answer to "let this server use the internet?", bound to
    /// the configuration's bytes and stored on this Mac only (PV-7).
    public func answerInternet(_ allow: Bool) {
        guard let question = internetQuestion, let workspaceRoot else { return }
        settings.setInternet(allow, for: question.configuration, in: workspaceRoot)
        if allow { restart() } else { Task { await refreshSnapshots() } }
    }

    /// The reader's answer to "its port is taken: use a free one?", kept on
    /// this Mac for the configuration. A yes starts it again on a free port.
    public func answerPort(useFreePort: Bool) {
        guard let question = portQuestion, let workspaceRoot else { return }
        settings.setAutoPort(useFreePort, for: question.configuration, in: workspaceRoot)
        notice = nil
        if useFreePort { restart() } else { Task { await refreshSnapshots() } }
    }

    public func setKeepSignIn(_ keep: Bool) {
        guard let workspaceRoot else { return }
        settings.update(workspaceRoot) { $0.persistSignIn = keep }
        if let key = selectedKey, PreviewPageRegistry.shared.existing(key) != nil {
            _ = PreviewPageRegistry.shared.rebuild(key)
        }
    }

    public func setAllowsInspectionScripts(_ allow: Bool) {
        guard let workspaceRoot else { return }
        settings.update(workspaceRoot) { $0.allowEval = allow }
    }

    /// Clears the page's cookies and storage.
    public func clearSiteData() {
        guard let page else { return }
        let store = page.webView.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStoreAllTypes.types, modifiedSince: .distantPast) {}
        page.reload()
    }

    /// One click in the servers menu: shows that configuration and starts
    /// it, unless it already runs. A new configuration still shows its
    /// approval card first.
    public func startConfiguration(_ name: String) {
        selectedName = name
        if snapshots.first(where: { $0.key.name == name })?.phase.isLive == true {
            syncPage()
            return
        }
        requestStart(name)
    }

    /// Writes a configuration discovery found into the project's launch
    /// file, for the reader to review in Changes (§4.2). The selected one
    /// when no name is given.
    public func saveConfiguration(_ name: String? = nil) {
        guard let workspaceRoot else { return }
        notice = nil
        message = nil
        let wanted = name ?? selectedName
        let proposed = LaunchConfigurationDiscovery.propose(workspaceRoot: workspaceRoot).configurations
        guard let configuration = proposed.first(where: { $0.name == wanted }) ?? (wanted == nil ? proposed.first : nil) else {
            notice = "There is no server found in the project named \(wanted ?? "")."
            return
        }
        do {
            message = try LaunchConfigurationStore.save(configuration, workspaceRoot: workspaceRoot)
            refreshCatalog()
        } catch {
            notice = "Could not write \(catalog.editableFileRelativePath): \(error.localizedDescription)"
        }
    }

    /// The older name for ``saveConfiguration(_:)`` on the selection.
    public func saveDiscoveredConfiguration() {
        saveConfiguration(nil)
    }

    /// Whether the project has an Alevr launch file to edit.
    public var hasEditableFile: Bool { catalog.hasJunoFile || catalog.hasAlevrFile }

    public var launchFileURL: URL? {
        workspaceRoot.map { $0.appendingPathComponent(catalog.editableFileRelativePath) }
    }

    /// A launch file that did not read, in words, while the pane offers what
    /// it found in the project instead.
    public var fileProblem: String? {
        catalog.issues.first { $0.source != .discovered }?.message
    }

    // MARK: - Annotate

    public var canAnnotate: Bool { annotationSink != nil && page != nil }

    /// Sends the picked element and its note to the composer, and stays in
    /// annotate mode for the next one.
    public func sendAnnotation() {
        guard let annotation = pendingAnnotation else { return }
        annotationSink?(annotation)
        pendingAnnotation = nil
    }

    public func cancelAnnotation() {
        pendingAnnotation = nil
        isAnnotating = false
    }

    // MARK: - The stop check

    /// The session's answer to rule 8 for the web surface: Lane A's
    /// ``AutonomyGate`` asks it at rule 8, inside the rules' own guards (Off,
    /// Plan and Ask, a pending approval, the continuation cap).
    public func uiAdvisor(sessionID: CodeSessionID, workspaceRoot: URL) -> any PreviewUIVerifyAdvising {
        PreviewSessionHub.shared.entry(for: sessionID, workspaceRoot: workspaceRoot).verify
    }

    /// Rule 8 of the stop check for the web surface, around `base`
    /// (CODE_AGENT_SPEC §1.4, §4.6), for a gate without the rules. Code
    /// sessions use ``uiAdvisor(sessionID:workspaceRoot:)`` inside Lane A's.
    public func completionGate(
        wrapping base: any CompletionGating,
        sessionID: CodeSessionID,
        workspaceRoot: URL
    ) -> any CompletionGating {
        PreviewUIGate(
            base: base,
            advisor: PreviewSessionHub.shared.entry(for: sessionID, workspaceRoot: workspaceRoot).verify
        )
    }
}

/// A weak reference the registry's observer can carry across actors.
private final class WeakLeaseBox: @unchecked Sendable {
    weak var model: PreviewLeaseModel?
    init(_ model: PreviewLeaseModel) { self.model = model }
}

/// Every website data type, for "Clear data".
@MainActor
enum WKWebsiteDataStoreAllTypes {
    static var types: Set<String> { WKWebsiteDataStore.allWebsiteDataTypes() }
}
