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

    @State private var slashCommands: CodeSlashCommandLibrary = .builtIn
    @State private var isRewindPickerPresented = false
    @FocusState private var composerFocused: Bool

    private var preferences: StudioPreferences { .shared }

    public init(
        controller: SessionController,
        models: [ModelOption],
        openReview: @escaping (String?) -> Void,
        beginDictation: (() -> Void)? = nil
    ) {
        self.controller = controller
        self.models = models
        self.openReview = openReview
        self.beginDictation = beginDictation
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
        guard controller.isAgentTransportConfigured else { return "Sign in to Juno to run the agent" }
        if isRunning {
            return controller.activeInstructionKind == .steer
                ? "Steer Juno while it works"
                : "Queue a follow-up for when it finishes"
        }
        return controller.events.isEmpty ? "Describe the change you want" : "Ask for a follow-up"
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
                StudioApprovalPrompt(controller: controller)
                StudioQuestionPrompt(controller: controller)
                StudioPlanApprovalPrompt(controller: controller)
                goalSurfaces
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
            if let context = controller.context {
                slashCommands = .merged(workspace: await context.slashCommands())
            }
        }
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
            addAttachment: controller.currentModelSupportsVision ? { controller.attach($0) } : nil,
            removeAttachment: { controller.removeAttachment(id: $0) },
            slashCommands: slashCommands,
            searchFiles: controller.context == nil
                ? nil
                : { query in await controller.findFiles(nameContains: query, limit: 24) },
            chooseFile: { entry in
                if !entry.isDirectory { controller.registerComposerFileReference(entry.path) }
            },
            runCommand: run,
            commandUnavailableReason: unavailableReason,
            canSend: canSend,
            isRunning: isBusy,
            isSending: controller.isSubmitting,
            send: { Task { await controller.send() } },
            stop: { Task { await controller.stop() } },
            rewind: openRewindPicker,
            focus: $composerFocused,
            // The beam travels the composer's edge while the run works — the
            // one live effect on the surface (brief: Border beam, `line`).
            beam: isBusy ? .line : nil
        ) {
            StudioModeChip(mode: mode, select: select, isEnabled: !isBusy)
            if isRunning {
                Menu {
                    Picker("While Juno works", selection: $controller.activeInstructionKind) {
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
                .help("What your next message does while Juno is working")
            }
        } trailing: {
            if preferences.showContextMeter,
               let used = controller.contextTokens,
               let window = controller.contextWindowTokens,
               window > 0
            {
                StudioContextMeter(
                    used: used,
                    window: window,
                    spent: controller.sessionUsage,
                    cost: controller.sessionCostEstimate
                )
            }
            StudioModelChip(
                models: models,
                modelID: controller.session.configuration.modelID,
                effort: controller.session.configuration.reasoningEffort,
                selectModel: { id in Task { await controller.setModelID(id) } },
                selectEffort: { effort in Task { await controller.setReasoningEffort(effort) } },
                isEnabled: !isBusy
            )
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

    private func run(_ command: CodeSlashCommand, argument: String) -> Bool {
        if let action = command.action {
            switch action {
            case .compact:
                // The controller refuses mid-run and says why; the typed
                // focus stays in the field so it can be sent once the run ends.
                let accepted = !isBusy
                Task { await controller.compactConversation(focus: argument) }
                return accepted
            case .review:
                openReview(nil)
                return true
            case .rewind:
                // The picker, or the reason there is none, answers the
                // command, so the field is cleared either way.
                if let openRewindPicker {
                    openRewindPicker()
                } else {
                    controller.explainRewindUnavailable()
                }
                return true
            case .goal:
                // Typing `/goal` is the reader's approval of the goal itself;
                // the start card asks only for Start.
                Task { await controller.goal.perform(GoalCommand.parse(argument)) }
                return true
            }
        }
        if let behavior = command.behavior, behavior != controller.session.configuration.behavior {
            Task { await controller.setBehavior(behavior) }
        }
        return true
    }

    private func unavailableReason(_ command: CodeSlashCommand) -> String? {
        guard command.action == .compact else { return nil }
        if controller.isCompacting { return "Compacting now" }
        if isRunning { return "Available when Juno finishes" }
        return nil
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
