import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// One session: the thread, anything waiting for an answer, and the composer.
///
/// The side panel is the host's (it belongs to the window's inspector), so
/// this view is the whole centre column and nothing else.
public struct StudioSessionView: View {
    @Bindable var controller: SessionController
    let models: [ModelOption]
    let openReview: (String?) -> Void
    let beginDictation: (() -> Void)?
    /// The Code v2 composer footer (model rail, traits, orchestrate, gauge)
    /// and the hand-off to the env server. Nil keeps the classic chips.
    let v2: CodeV2StudioContext?

    @State private var isRewindPickerPresented = false
    @FocusState private var composerFocused: Bool

    private var preferences: StudioPreferences { .shared }

    public init(
        controller: SessionController,
        models: [ModelOption],
        openReview: @escaping (String?) -> Void,
        beginDictation: (() -> Void)? = nil,
        v2: CodeV2StudioContext? = nil
    ) {
        self.controller = controller
        self.models = models
        self.openReview = openReview
        self.beginDictation = beginDictation
        self.v2 = v2
    }

    /// Computer use as the `+` menu's toggle and the composer's `Computer`.
    private var computerUseBinding: Binding<Bool>? {
        guard controller.computerUseUnavailableReason == nil || controller.computerUseActive else { return nil }
        return Binding(
            get: { controller.computerUseActive },
            set: { on in
                Task {
                    if on { await controller.startComputerUse() } else { await controller.stopComputerUse() }
                }
            }
        )
    }

    /// Project, branch and machine for the strip under the composer.
    private var place: CodeV2SessionPlace? {
        guard controller.context != nil else { return nil }
        return CodeV2SessionPlace(
            project: controller.workspaceDisplayName,
            branch: controller.gitStatus?.branch ?? controller.session.gitBranch
        )
    }

    /// A subscription is chosen: the next send hands the thread over.
    private var handsOff: Bool {
        guard let v2 else { return false }
        return v2.composer.engine == .envServer
    }

    private func sendOrHandOff() {
        if handsOff, let v2 {
            let text = controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            controller.composerText = ""
            v2.handoff(text)
        } else {
            Task { await controller.send() }
        }
    }

    /// The v2 controls' choices, applied to the Swift engine: Alevr models
    /// and BYOK keys alike (the env server runs subscriptions). Model, effort,
    /// permission, the context tier or Lean window, Orchestrate's roles and
    /// budget, where roles on other instances run, and the `auto` reviewer.
    private func syncV2(_ composer: CodeV2ComposerModel) {
        guard composer.engine == .alevr, let modelID = CodeV2EngineMapping.engineModelID(for: composer.selection) else { return }
        let configuration = controller.session.configuration
        if configuration.modelID != modelID {
            Task { await controller.setModelID(modelID) }
        }
        let effort = CodeV2EngineMapping.effort(composer.selection.effort)
        if configuration.reasoningEffort != effort {
            Task { await controller.setReasoningEffort(effort) }
        }
        let permission = CodeV2EngineMapping.permission(for: composer.runtimeMode)
        if configuration.permissionMode != permission {
            Task { await controller.setPermissionMode(permission) }
        }
        let window = CodeV2EngineMapping.contextWindow(for: composer.selection, lean: composer.lean)
        if controller.contextWindowOverride != window {
            controller.setContextWindowOverride(window)
        }
        // Orchestrate (roles, budget) and the `auto` reviewer reach the engine too.
        if controller.roleRouting != composer.routing {
            controller.setRoleRouting(composer.routing)
        }
        let providers = v2?.subagentProviders?()
        if controller.subagentProviders?.fingerprint != providers?.fingerprint {
            controller.setSubagentProviders(providers)
        }
        let autoReview = composer.runtimeMode == .auto
        if controller.autoReviewEnabled != autoReview {
            Task { await controller.setAutoReview(autoReview) }
        }
    }

    private var v2Context: CodeV2ContextReading? {
        guard let used = controller.contextTokens, let window = controller.contextWindowTokens, window > 0 else { return nil }
        return CodeV2ContextReading(usedTokens: used, maxTokens: window, costUsd: controller.sessionCostEstimate)
    }

    private var mode: StudioMode {
        StudioMode(
            behavior: controller.session.configuration.behavior,
            permission: controller.session.configuration.permissionMode
        )
    }

    private var isRunning: Bool { controller.isRunning }

    /// A `/compact` between runs holds the session much as a run does: the
    /// history is being replaced, so nothing is sent and the contract stays
    /// put until it is done, and Stop is offered for the model's summary.
    private var isBusy: Bool { isRunning || controller.isCompacting }

    private var canSend: Bool {
        (!controller.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !controller.pendingAttachments.isEmpty)
            && controller.isAgentTransportConfigured
            && !controller.isCompacting
            && !controller.isSubmitting
            && !controller.isRewinding
    }

    private var placeholder: String {
        guard controller.isAgentTransportConfigured else { return "Sign in to Alevr to run the agent" }
        if isRunning {
            return controller.activeInstructionKind == .steer
                ? "Steer Alevr while it works"
                : "Queue a follow-up. ⌘↩ to steer now"
        }
        return "Ask for a change. @ for files, / for commands"
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let problem = controller.settingsProblem {
                StudioBanner(text: problem, tone: .warning)
            } else if let notice = controller.settingsNotice {
                StudioBanner(text: notice)
            }
            StudioThreadView(controller: controller, openReview: openReview)
            VStack(spacing: JunoSpace.snug) {
                // Resume, the session's worktree, its CI (Lane E).
                StudioShipBar(controller: controller)
                StudioQuestionPrompt(controller: controller)
                StudioPlanApprovalPrompt(controller: controller)
                // The verify recipe card (CODE_AGENT_SPEC §1.8). Lane B.
                StudioVerifyRecipeSlot(controller: controller)
                goalSurfaces
                // `/loop`s running in this session, in words (Lane F).
                StudioCommandStatusLines(commands: controller.commands)
                composer
            }
            .frame(maxWidth: Studio.Metrics.measure)
            .padding(.horizontal, Studio.Metrics.gutter)
            .padding(.bottom, JunoSpace.regular)
            .frame(maxWidth: .infinity)
            .animation(JunoMotion.standard, value: controller.pendingApprovals.map(\.id))
            .animation(JunoMotion.standard, value: controller.pendingQuestions.map(\.id) + controller.pendingPlans.map(\.id))
        }
        .background(Studio.Surface.canvas)
        .task(id: controller.sessionID) {
            composerFocused = true
            await controller.commands.reload(context: controller.context)
        }
        // The sheets, questions and side answers slash verbs open (Lane F).
        .studioCommandCenter(controller: controller, models: models)
        .onChange(of: isRunning) { _, running in
            if running { controller.activeInstructionKind = preferences.followUp.instructionKind }
        }
        // A rewind of the conversation puts the message back in the composer,
        // and the reader's next move is to edit it.
        .onChange(of: controller.rewindGeneration) {
            composerFocused = true
        }
        .sheet(isPresented: $isRewindPickerPresented) {
            StudioRewindPicker(controller: controller) {
                isRewindPickerPresented = false
            }
            .junoSheetSurface(.fitted)
        }
        .sheet(isPresented: Binding(
            get: { controller.goal.isSheetPresented },
            set: { controller.goal.isSheetPresented = $0 }
        )) {
            StudioGoalSheet(
                goal: controller.goal.current,
                history: controller.goal.history,
                perform: performGoalAction,
                done: { controller.goal.isSheetPresented = false }
            )
            .junoSheetSurface(.fitted)
        }
    }

    /// The goal's start card while one is being drafted or edited, else its
    /// progress row, directly above the composer (§2.8).
    @ViewBuilder
    private var goalSurfaces: some View {
        let goal = controller.goal
        if goal.draft != nil {
            StudioGoalStartCard(
                draft: Binding(
                    get: { goal.draft ?? GoalDraft(objective: "") },
                    set: { goal.draft = $0 }
                ),
                isEditing: goal.draftEditsCurrent,
                isDrafting: goal.isDrafting,
                replacesCurrent: goal.startReplacesCurrent,
                errorMessage: goal.errorMessage,
                start: { Task { await goal.confirmDraft() } },
                cancel: { Task { await goal.cancelDraft() } }
            )
            .transition(.opacity)
        } else if let row = goal.row {
            StudioGoalRow(
                content: row,
                isWorking: goal.isWorking && row.status == .active,
                perform: performGoalAction,
                openSheet: { goal.isSheetPresented = true }
            )
            .transition(.opacity)
        }
    }

    private func performGoalAction(_ action: GoalRowContent.Action) {
        let goal = controller.goal
        Task {
            switch action {
            case .pause: await goal.perform(.pause)
            case .resume: await goal.perform(.resume)
            case .keepGoing: await goal.perform(.resume)
            case .edit:
                goal.isSheetPresented = false
                await goal.perform(.edit)
            case .clear: await goal.perform(.clear)
            }
        }
    }

    /// The rewind picker, from esc esc or `/rewind`. Not while a run is active:
    /// the run owns the history a rewind would cut.
    private var openRewindPicker: (() -> Void)? {
        // Nor mid-fold: a `/compact` saves its result over the history.
        guard !isBusy, !controller.rewindTurns.isEmpty else { return nil }
        return { isRewindPickerPresented = true }
    }

    private var composer: some View {
        StudioComposer(
            text: $controller.composerText,
            placeholder: placeholder,
            attachments: controller.pendingAttachments,
            // Offered whatever the model: a picture pasted for a model that
            // cannot see says so, instead of vanishing (§5.11).
            addAttachment: { controller.attach($0) },
            removeAttachment: { controller.removeAttachment(id: $0) },
            slashCommands: controller.commands.library,
            searchFiles: controller.context == nil
                ? nil
                : { query in await controller.findFiles(nameContains: query, limit: 24) },
            chooseFile: { entry in
                // A folder is a mention too: it is listed when the message goes.
                controller.registerComposerFileReference(entry.path)
            },
            shellIDs: controller.context.map { context in
                context.shells.sessions(ownedBy: controller.sessionID).filter(\.state.isRunning).map(\.id)
            } ?? [],
            runCommand: run,
            commandUnavailableReason: unavailableReason,
            canSend: canSend,
            isRunning: isBusy,
            isSending: controller.isSubmitting,
            send: sendOrHandOff,
            stop: { Task { await controller.stop() } },
            rewind: openRewindPicker,
            focus: $composerFocused,
            steer: isRunning ? {
                controller.activeInstructionKind = .steer
                Task { await controller.send() }
            } : nil,
            stopOnDoubleEscape: isRunning,
            // An approval takes over the composer body (code-v4 TARGET §7.4).
            takeover: controller.pendingApprovals.isEmpty ? nil : AnyView(StudioApprovalPrompt(controller: controller)),
            plusMenu: v2.map { v2 in
                AnyView(CodeV2PlusMenuItems(model: v2.composer, directory: v2.directory, computerUse: computerUseBinding))
            },
            contextStrip: place.map { AnyView(CodeV2ContextStrip(place: $0)) }
        ) {
            if let v2 {
                CodeV2ComposerLeading(
                    model: v2.composer, directory: v2.directory, isEnabled: !isBusy,
                    threadTokens: controller.contextTokens ?? 0, computerUse: computerUseBinding,
                    openConnections: v2.openConnections, setup: v2.setup
                )
                    .onChange(of: v2.composer.selection) { _, _ in syncV2(v2.composer) }
                    .onChange(of: v2.composer.runtimeMode) { _, _ in syncV2(v2.composer) }
                    .onChange(of: v2.composer.routing) { _, _ in syncV2(v2.composer) }
                    .onChange(of: v2.composer.lean) { _, _ in syncV2(v2.composer) }
                    .onChange(of: v2.directory.instances) { _, _ in syncV2(v2.composer) }
                    .onAppear { syncV2(v2.composer) }
            } else {
            StudioModeChip(mode: mode, select: select, isEnabled: !isBusy)
            }
            if isRunning, v2 == nil {
                Menu {
                    Picker("While Alevr works", selection: $controller.activeInstructionKind) {
                        Text("Steer the current run").tag(UserInstructionKind.steer)
                        Text("Queue for after it finishes").tag(UserInstructionKind.queue)
                    }
                    .pickerStyle(.inline)
                } label: {
                    StudioChipLabel(title: controller.activeInstructionKind == .steer ? "Steer" : "Queue")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .fixedSize()
                .help("What your next message does while Alevr is working")
            }
        } trailing: {
            if let v2 {
                CodeV2ComposerTrailing(
                    context: preferences.showContextMeter ? v2Context : nil,
                    compact: { Task { await controller.compactConversation() } }
                )
            } else if preferences.showContextMeter,
               let used = controller.contextTokens,
               let window = controller.contextWindowTokens,
               window > 0
            {
                StudioContextMeter(
                    used: used,
                    window: window,
                    spent: controller.sessionUsage,
                    cost: controller.sessionCostEstimate,
                    openDetails: { controller.commands.present(.context) }
                )
            }
            if v2 == nil {
            StudioModelChip(
                models: models,
                modelID: controller.session.configuration.modelID,
                effort: controller.session.configuration.reasoningEffort,
                selectModel: { id in Task { await controller.setModelID(id) } },
                selectEffort: { effort in Task { await controller.setReasoningEffort(effort) } },
                isEnabled: !isBusy
            )
            }
            if let beginDictation {
                Button(action: beginDictation) { JunoIconView(.mic, size: 15) }
                    .buttonStyle(StudioIconButtonStyle())
                    .help("Dictate")
                    .accessibilityLabel("Dictate")
                    .accessibilityIdentifier("juno.code.composer.dictate")
            }
        }
    }

    private func select(_ mode: StudioMode) {
        Task {
            await controller.setBehavior(mode.behavior)
            if mode.behavior == .code {
                await controller.setPermissionMode(mode.permission)
            }
        }
    }

    /// Every command goes through the session's command centre (Lane F,
    /// CODE_AGENT_SPEC §5.4): verbs run their handlers, prompts switch the
    /// behaviour they imply.
    private func run(_ command: CodeSlashCommand, argument: String) -> Bool {
        if command.action == nil, let behavior = command.behavior,
           behavior != controller.session.configuration.behavior
        {
            Task { await controller.setBehavior(behavior) }
        }
        return controller.commands.run(
            command,
            argument: argument,
            host: controller,
            view: SlashCommandViewActions(
                openRewind: openRewindPicker ?? { controller.explainRewindUnavailable() },
                openReview: openReview
            ),
            imports: controller.context?.userExtensionPolicy
        )
    }

    private func unavailableReason(_ command: CodeSlashCommand) -> String? {
        if command.action == .compact, controller.isCompacting { return "Compacting now" }
        return controller.commands.unavailableReason(command, isBusy: isBusy)
    }
}

/// A one-line notice across the top of a column.
struct StudioBanner: View {
    enum Tone { case warning, info }
    let text: String
    var tone: Tone = .info

    var body: some View {
        HStack(spacing: JunoSpace.snug) {
            JunoIconView(tone == .warning ? .triangleAlert : .circleHelp, size: 13)
                .foregroundStyle(tone == .warning ? Studio.Ink.danger : Studio.Ink.secondary)
            Text(text)
                .font(Studio.Font.meta)
                .foregroundStyle(Studio.Ink.secondary)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
        .background(Studio.Surface.muted.opacity(0.6))
        .studioHairline(.bottom)
    }
}
