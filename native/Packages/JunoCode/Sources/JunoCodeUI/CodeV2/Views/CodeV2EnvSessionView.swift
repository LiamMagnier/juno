import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// The centre column for a thread a vendor runtime runs through the env
/// server (Claude on the user's own `claude`, Codex on their ChatGPT plan,
/// an ACP agent): the thread, the queue dock and the composer — the same
/// composer and footer the Alevr engine's threads use.
public struct CodeV2EnvSessionView: View {
    let session: CodeV2EnvSession
    @Bindable var composer: CodeV2ComposerModel
    let directory: CodeV2ProviderDirectory
    var dock: CodeV2DockController?
    var openConnections: (() -> Void)?
    var setup: ((String, CodeV2.ProviderSetupAction) -> Void)?
    /// Where the thread runs, for the strip under the composer.
    var place: CodeV2SessionPlace?

    @State private var pendingIndex = 0
    /// "Resume at reset" was chosen: the task that sends "Continue." then.
    @State private var resumeTask: Task<Void, Never>?
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        session: CodeV2EnvSession,
        composer: CodeV2ComposerModel,
        directory: CodeV2ProviderDirectory,
        dock: CodeV2DockController? = nil,
        openConnections: (() -> Void)? = nil,
        setup: ((String, CodeV2.ProviderSetupAction) -> Void)? = nil,
        place: CodeV2SessionPlace? = nil
    ) {
        self.session = session
        self.composer = composer
        self.directory = directory
        self.dock = dock
        self.openConnections = openConnections
        self.setup = setup
        self.place = place
    }

    private var snapshot: CodeV2.SessionSnapshot { session.snapshot }
    private var instance: CodeV2.ProviderInstance? { directory.instance(snapshot.selection.instanceId) }
    private var pending: [CodeV2.TurnItem] { session.pendingRequests }
    /// Computer use through the bridge, asked for this thread's session.
    private var connected: [CodeV2ConnectedApprovals.Pending] {
        CodeV2ConnectedApprovals.shared.pending(forSession: session.sessionId)
    }
    private var isRunning: Bool { session.isRunning }
    private var canSteer: Bool { instance?.capabilities?.steering ?? false }

    private var context: CodeV2ContextReading? {
        guard let usage = snapshot.usage, let used = usage.contextTokens else { return nil }
        let window = usage.contextWindow ?? snapshot.selection.contextTokens ?? 0
        guard window > 0 else { return nil }
        let subscription = instance.map { !CodeV2ProviderDirectory.billsInDollars($0.kind) } ?? false
        let plan = instance?.account?.plan.map { CodeV2ProviderDirectory.planName($0) } ?? (instance.map(CodeV2ProviderDirectory.vendorName) ?? "")
        return CodeV2ContextReading(
            usedTokens: used, maxTokens: window,
            costUsd: subscription ? nil : usage.costUsd,
            planSentence: subscription ? "Counts against your \(plan) plan" : nil
        )
    }

    private var budget: (spent: Double, limit: Double)? {
        guard let limit = snapshot.routing?.budget?.maxUsd else { return nil }
        return (snapshot.usage?.costUsd ?? 0, limit)
    }

    public var body: some View {
        Group {
            if snapshot.items.isEmpty {
                newSession
            } else {
                thread
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Studio.Surface.canvas)
        .task(id: session.sessionId) {
            focused = true
            if session.state.cursor == nil { await session.open() }
        }
        .onChange(of: session.sessionId, initial: true) { old, new in
            if old != new { CodeV2ConnectedApprovals.shared.hiding(session: old) }
            CodeV2ConnectedApprovals.shared.showing(session: new)
        }
        .onDisappear { CodeV2ConnectedApprovals.shared.hiding(session: session.sessionId) }
    }

    /// A thread with no turns yet (TARGET §4): the question at about 38% of
    /// the canvas, the composer under it, nothing else.
    private var newSession: some View {
        GeometryReader { proxy in
            VStack(spacing: JunoSpace.section) {
                Text("What should we build in \(Text((snapshot.cwd as NSString).lastPathComponent).underline(pattern: .dot, color: Studio.Ink.tertiary))?")
                    .studioType(.display)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                composerView
            }
            .frame(maxWidth: Studio.Metrics.measure)
            .padding(.horizontal, Studio.Metrics.gutter)
            .frame(maxWidth: .infinity)
            .padding(.top, max(JunoSpace.region, proxy.size.height * 0.38 - 60))
        }
    }

    private var thread: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        CodeV2ThreadView(
                            items: snapshot.items,
                            activeTurnId: snapshot.activeTurnId,
                            selectedAgent: dock?.selectedAgent,
                            budget: budget,
                            actions: actions
                        )
                        if let message = session.lastError {
                            HStack(spacing: JunoSpace.snug) {
                                Text(message).studioType(.text).foregroundStyle(Studio.Ink.danger)
                                Spacer()
                            }
                            .frame(maxWidth: Studio.Metrics.measure)
                            .padding(.top, JunoSpace.cozy)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Studio.Metrics.gutter)
                    .padding(.top, 28)
                    .padding(.bottom, JunoSpace.regular)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: snapshot.items.count) { _, _ in
                    withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
            composerView
                .frame(maxWidth: Studio.Metrics.measure)
                .padding(.horizontal, Studio.Metrics.gutter)
                .padding(.bottom, JunoSpace.regular)
                .frame(maxWidth: .infinity)
                .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: pending.map(\.id))
        }
    }

    private var actions: CodeV2ThreadActions {
        var actions = CodeV2ThreadActions()
        actions.openFile = { path in dock?.show(.changes, path: path) }
        actions.review = { _ in dock?.show(.changes) }
        actions.selectAgent = { id in dock?.selectAgent(id) }
        actions.openFrame = { id in dock?.showFrame(id) }
        if instance?.capabilities?.rollback == true {
            actions.undo = { id in Task { await session.rollback(to: id) } }
            actions.editFromHere = { id in Task { await session.rollback(to: id) } }
        }
        return actions
    }

    // MARK: Composer

    private var takeover: AnyView? {
        if let first = connected.first {
            return AnyView(CodeV2ConnectedApprovalView(item: first, position: (1, connected.count + pending.count)) { decision in
                CodeV2ConnectedApprovals.shared.respond(first.id, decision)
            })
        }
        guard !pending.isEmpty else {
            if snapshot.state == .limited, let instance {
                let resumeDate = snapshot.resumeAt.flatMap(CodeV2Dates.parse)
                return AnyView(CodeV2LimitedNotice(
                    sentence: CodeV2ProviderDirectory.limitedSentence(instance, resumeAt: snapshot.resumeAt)
                        + (resumeTask == nil ? "" : " Alevr will continue then."),
                    resumeAtReset: resumeDate == nil || resumeTask != nil ? nil : { scheduleResume(at: resumeDate!) },
                    switchModel: { switchToAlevr() }
                ))
            }
            return nil
        }
        let index = min(pendingIndex, pending.count - 1)
        switch pending[index] {
        case let .approvalRequest(request):
            return AnyView(CodeV2ApprovalTakeover(
                request: request,
                position: (index + 1, pending.count),
                respond: { decision in Task { await session.respond(to: request.requestId, decision: decision) } },
                showDiff: { dock?.show(.changes) },
                move: pending.count > 1 ? { delta in pendingIndex = (index + delta + pending.count) % pending.count } : nil
            ))
        case let .userInputRequest(request):
            return AnyView(CodeV2QuestionTakeover(request: request) { answers in
                Task { await session.respond(to: request.requestId, decision: .accept, answers: answers) }
            })
        default:
            return nil
        }
    }

    /// Sends "Continue." once the plan window resets (DESIGN §6).
    private func scheduleResume(at date: Date) {
        resumeTask = Task {
            let wait = max(0, date.timeIntervalSinceNow) + 5
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            await session.send(
                "Continue.", selection: composer.selection, routing: composer.routing,
                runtimeMode: composer.runtimeMode, interactionMode: composer.interactionMode
            )
            resumeTask = nil
        }
    }

    /// Switch model from Limited: the first Alevr coding model the directory
    /// lists, so the thread can carry on on Alevr's plan.
    private func switchToAlevr() {
        guard let alevr = directory.instance("alevr"), let model = alevr.models?.first(where: { $0.isDefault == true }) ?? alevr.models?.first else { return }
        composer.choose(instanceId: "alevr", model: model)
    }

    private var composerView: some View {
        let enabled = !isRunning
        let hasProvider = instance?.status == .ready || instance?.status == .limited
        return StudioComposer(
            text: $composer.draft,
            placeholder: CodeV2ComposerLogic.placeholder(isRunning: isRunning, hasProvider: hasProvider),
            slashCommands: CodeV2EnvSessionView.commands,
            canSend: !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && snapshot.state != .limited,
            isRunning: isRunning,
            send: send,
            stop: { Task { await session.interrupt() } },
            focus: $focused,
            steer: canSteer ? { steer() } : nil,
            stopOnDoubleEscape: true,
            takeover: takeover,
            takeoverNeedsYou: !pending.isEmpty || !connected.isEmpty,
            plusMenu: AnyView(CodeV2PlusMenuItems(model: composer, directory: directory)),
            contextStrip: place.map { AnyView(CodeV2ContextStrip(place: $0)) },
            minimumLines: snapshot.items.isEmpty ? 3 : 2
        ) {
            CodeV2ComposerLeading(
                model: composer, directory: directory, isEnabled: enabled,
                threadTokens: snapshot.usage?.contextTokens ?? 0,
                openConnections: openConnections, setup: setup
            )
        } trailing: {
            CodeV2ComposerTrailing(
                context: context,
                queue: snapshot.queue,
                editQueued: { item in composer.draft = item.input.text; focused = true },
                steerQueued: canSteer ? { item in Task { await session.steer(item.input.text) } } : nil
            )
        }
    }

    /// The env server runs the vendor's own agent, which has its own slash
    /// commands; Alevr's session verbs do not apply, so none are offered.
    static let commands = CodeSlashCommandLibrary(commands: [])

    private func send() {
        let text = composer.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composer.draft = ""
        if isRunning {
            Task { await session.queue(text) }
        } else {
            Task {
                await session.send(
                    text, selection: composer.selection, routing: composer.routing,
                    runtimeMode: composer.runtimeMode, interactionMode: composer.interactionMode
                )
            }
        }
    }

    private func steer() {
        let text = composer.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composer.draft = ""
        Task { await session.steer(text) }
    }
}

/// What the thread asks of the dock: which tab, which file, which agent.
@MainActor
@Observable
public final class CodeV2DockController {
    public var isOpen = false
    public var tab: CodeV2DockTab = .changes
    public var focusedPath: String?
    public var selectedAgent: String?
    public var selectedFrame: String?
    public var scope: CodeV2ChangesPane.Scope = .thread
    public var decisions = CodeV2HunkDecisions()
    public var failure: String?
    /// Dock › Preview's target, made once per workspace so the preview keeps
    /// its identity (and its server lease) while the tab is switched.
    @ObservationIgnored private var previewTargets: [String: CodePreviewTarget] = [:]

    public init() {}

    func previewTarget(for workspace: CodeV2DockWorkspace) -> CodePreviewTarget? {
        let key = workspace.controller.sessionID.value
        if let target = previewTargets[key] { return target }
        guard let target = workspace.previewTarget else { return nil }
        previewTargets[key] = target
        return target
    }

    public func show(_ tab: CodeV2DockTab, path: String? = nil) {
        self.tab = tab
        if let path { focusedPath = path }
        isOpen = true
    }

    public func selectAgent(_ id: String) {
        selectedAgent = id
        show(.agents)
    }

    public func showFrame(_ id: String) {
        selectedFrame = id
        show(.screen)
    }

    /// Toggles a tab the way the toolbar does: the open tab closes the dock.
    public func toggle(_ tab: CodeV2DockTab) {
        if isOpen, self.tab == tab { isOpen = false } else { show(tab) }
    }
}
