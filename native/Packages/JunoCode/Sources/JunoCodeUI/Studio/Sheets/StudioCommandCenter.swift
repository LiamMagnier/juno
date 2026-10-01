import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime
import JunoDesignSystem

// The sheets the slash verbs open (CODE_AGENT_SPEC §5.4, §5.5), in the Studio
// style: words for state, no pills, no dots. A visual redesign comes later
// on the new design system; these are functional and quiet.

extension View {
    /// Hosts what a session's slash verbs open: their sheets, the question a
    /// verb asks first, and `/btw`'s answer.
    func studioCommandCenter(controller: SessionController, models: [ModelOption]) -> some View {
        modifier(StudioCommandCenterHost(controller: controller, models: models))
    }
}

struct StudioCommandCenterHost: ViewModifier {
    @Bindable var controller: SessionController
    let models: [ModelOption]

    private var commands: CommandCenterModel { controller.commands }

    func body(content: Content) -> some View {
        @Bindable var commands = controller.commands
        content
            .sheet(item: $commands.activeSheet) { sheet in
                StudioCommandSheet(sheet: sheet, controller: controller, models: models)
            }
            .sheet(isPresented: Binding(
                get: { commands.aside != nil },
                set: { if !$0 { commands.aside = nil } }
            )) {
                if let aside = commands.aside {
                    StudioAsideSheet(aside: aside) { commands.aside = nil }
                }
            }
            .confirmationDialog(
                commands.confirmation?.title ?? "",
                isPresented: Binding(
                    get: { commands.confirmation != nil },
                    set: { if !$0 { commands.confirmation = nil } }
                ),
                presenting: commands.confirmation
            ) { confirmation in
                Button(confirmation.confirmLabel) {
                    Task { await commands.confirm(confirmation, host: controller) }
                }
                Button("Keep it", role: .cancel) { commands.confirmation = nil }
            } message: { confirmation in
                Text(confirmation.message)
            }
            .task(id: models.map(\.modelID)) {
                commands.availableModels = models
            }
            .task(id: controller.sessionID) {
                // A fork's first message waits in its composer for the reader.
                if let prompt = PendingForkPrompts.shared.take(for: controller.sessionID),
                   controller.composerText.isEmpty
                {
                    controller.composerText = prompt
                }
            }
    }
}

/// `/loop`s running in this session, one line each with Stop. Nothing when
/// there are none.
struct StudioCommandStatusLines: View {
    let commands: CommandCenterModel

    var body: some View {
        if !commands.loops.isEmpty {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ForEach(commands.loops) { loop in
                    HStack(spacing: JunoSpace.snug) {
                        Text(loop.line)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if loop.runs > 0 {
                            Text("· ran \(StudioFormat.plural(loop.runs, "time"))")
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.tertiary)
                        }
                        Spacer(minLength: JunoSpace.snug)
                        Button("Stop") { commands.stopLoop(loop.id) }
                            .buttonStyle(.link)
                            .accessibilityLabel("Stop the loop: \(loop.prompt)")
                    }
                }
            }
            .padding(.horizontal, JunoSpace.regular)
            .accessibilityIdentifier("juno.code.command.loops")
        }
    }
}

/// One sheet's frame: a title, what it is about, Done, and the content.
struct StudioSheetFrame<Content: View>: View {
    let title: String
    var subtitle: String?
    let done: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Studio.Font.title).foregroundStyle(Studio.Ink.primary)
                    if let subtitle {
                        Text(subtitle)
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(JunoSpace.regular)
            .studioHairline(.bottom)
            content()
        }
        .frame(width: 600, height: 560)
        .background(Studio.Surface.raised)
    }
}

/// A row of a sheet: a label, a value, and an optional note under them.
struct StudioSheetRow: View {
    let label: String
    var value: String?
    var note: String?
    var mono = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(mono ? Studio.Font.mono : Studio.Font.label)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                Spacer(minLength: JunoSpace.regular)
                if let value {
                    Text(value)
                        .font(Studio.Font.metaDigits)
                        .foregroundStyle(Studio.Ink.secondary)
                }
            }
            if let note {
                Text(note)
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Picks the sheet a verb opened.
struct StudioCommandSheet: View {
    let sheet: CommandSheet
    let controller: SessionController
    let models: [ModelOption]

    private func done() { controller.commands.activeSheet = nil }

    var body: some View {
        switch sheet {
        case .context: StudioContextSheet(controller: controller, done: done)
        case .cost: StudioCostSheet(controller: controller, done: done)
        case .permissions: StudioPermissionsSheet(controller: controller, done: done)
        case .agents: StudioAgentsSheet(controller: controller, done: done)
        case .mcp: StudioMCPSheet(controller: controller, done: done)
        case .hooks: StudioHooksSheet(controller: controller, done: done)
        case .tasks: StudioTasksSheet(controller: controller, done: done)
        case .memory: StudioMemorySheet(controller: controller, done: done)
        case .resume: StudioResumeSheet(controller: controller, done: done)
        case .model: StudioModelSheet(controller: controller, models: models, done: done)
        case .goal: StudioCommandGoalSheet(controller: controller, done: done)
        case .verify: StudioVerifySheet(controller: controller, done: done)
        }
    }
}

// MARK: - /context

struct StudioContextSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var breakdown: ContextBreakdown?

    var body: some View {
        StudioSheetFrame(
            title: "Context",
            subtitle: "What the model reads on each turn, by part. Each part is Juno's estimate, scaled to the size the provider last reported.",
            done: done
        ) {
            if let breakdown {
                StudioContextBreakdownView(breakdown: breakdown)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { breakdown = await controller.contextBreakdown() }
    }
}

struct StudioContextBreakdownView: View {
    let breakdown: ContextBreakdown

    private var headline: String {
        let used = StudioFormat.tokens(breakdown.total)
        guard let window = breakdown.window, window > 0 else {
            return breakdown.isMeasured ? "\(used) tokens" : "About \(used) tokens, before the first reply"
        }
        let percent = Int(Double(breakdown.total) / Double(window) * 100)
        return "\(used) of \(StudioFormat.tokens(window)) tokens · \(percent)%"
    }

    var body: some View {
        Form {
            Section {
                StudioSheetRow(
                    label: headline,
                    note: breakdown.compactionThreshold.map { "Juno compacts at \(StudioFormat.tokens($0)) tokens." }
                )
            }
            Section("By part") {
                if breakdown.rows.isEmpty {
                    Text("Nothing has been sent yet.").foregroundStyle(Studio.Ink.tertiary)
                }
                ForEach(breakdown.rows) { row in
                    StudioSheetRow(
                        label: row.part.label + (row.part == .images && breakdown.imageCount > 0 ? " (\(breakdown.imageCount))" : ""),
                        value: "\(StudioFormat.tokens(row.tokens)) · \(share(row.tokens))"
                    )
                }
            }
            if !breakdown.suggestions.isEmpty {
                Section("You could") {
                    ForEach(breakdown.suggestions, id: \.self) { suggestion in
                        Text(suggestion).font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private func share(_ tokens: Int) -> String {
        guard breakdown.total > 0 else { return "0%" }
        let percent = Double(tokens) / Double(breakdown.total) * 100
        return percent < 1 ? "under 1%" : "\(Int(percent.rounded()))%"
    }
}

// MARK: - /cost

struct StudioCostSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var breakdown: CostBreakdown?

    var body: some View {
        StudioSheetFrame(
            title: "Cost",
            subtitle: "This session's model calls at the models' published rates. An estimate: what is billed comes from the providers' own counts.",
            done: done
        ) {
            if let breakdown {
                StudioCostBreakdownView(breakdown: breakdown)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { breakdown = await controller.costBreakdown() }
    }
}

struct StudioCostBreakdownView: View {
    let breakdown: CostBreakdown

    var body: some View {
        Form {
            Section {
                StudioSheetRow(
                    label: breakdown.cost.map(Self.money) ?? "No published price for these models",
                    value: StudioFormat.plural(breakdown.total.requests, "request"),
                    note: StudioContextMeter.spendLine(breakdown.total, cost: nil)
                        .replacingOccurrences(of: "This session: ", with: "")
                )
            }
            Section("Who spent it") {
                ForEach(breakdown.spenders) { row in
                    StudioSheetRow(
                        label: row.label,
                        value: row.cost.map(Self.money) ?? "\(StudioFormat.tokens(row.totals.inputTokens + row.totals.outputTokens)) tokens",
                        note: StudioContextMeter.spendLine(row.totals, cost: nil)
                            .replacingOccurrences(of: "This session: ", with: "")
                    )
                }
            }
            if !breakdown.models.isEmpty {
                Section("By model") {
                    ForEach(breakdown.models) { row in
                        StudioSheetRow(
                            label: row.modelID.isEmpty ? "Unnamed model" : row.modelID,
                            value: row.cost.map(Self.money),
                            note: "\(StudioFormat.tokens(row.totals.freshInputTokens)) in, \(StudioFormat.tokens(row.totals.cacheReadTokens)) from cache, \(StudioFormat.tokens(row.totals.cacheWriteTokens)) cached, \(StudioFormat.tokens(row.totals.outputTokens)) out",
                            mono: true
                        )
                    }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    static func money(_ value: Double) -> String {
        value < 0.01 ? "under $0.01" : String(format: "$%.2f", value)
    }
}

// MARK: - /btw

struct StudioAsideSheet: View {
    let aside: CommandCenterModel.Aside
    let done: () -> Void

    var body: some View {
        StudioSheetFrame(title: "A side question", subtitle: "Answered from this conversation. It is not added to it.", done: done) {
            ScrollView {
                VStack(alignment: .leading, spacing: JunoSpace.regular) {
                    Text(aside.question)
                        .font(Studio.Font.labelEmphasis)
                        .foregroundStyle(Studio.Ink.primary)
                    if let answer = aside.answer {
                        Text(answer)
                            .studioReadingFont()
                            .foregroundStyle(Studio.Ink.primary)
                            .textSelection(.enabled)
                    } else {
                        HStack(spacing: JunoSpace.snug) {
                            StudioSpinner().frame(width: 10, height: 10)
                            Text("Thinking about it…").font(Studio.Font.meta).foregroundStyle(Studio.Ink.tertiary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(JunoSpace.regular)
            }
        }
    }
}

// MARK: - /model

struct StudioModelSheet: View {
    let controller: SessionController
    let models: [ModelOption]
    let done: () -> Void

    var body: some View {
        StudioSheetFrame(
            title: "Model",
            subtitle: "Switching re-reads the whole conversation on the next turn, without the prompt cache.",
            done: done
        ) {
            List(models) { model in
                Button {
                    Task {
                        await controller.setModelID(model.modelID)
                        done()
                    }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.displayName).font(Studio.Font.label)
                            Text(model.modelID).font(Studio.Font.monoSmall).foregroundStyle(Studio.Ink.tertiary)
                        }
                        Spacer()
                        if model.modelID == controller.session.configuration.modelID {
                            Text("In use").font(Studio.Font.meta).foregroundStyle(Studio.Ink.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - /goal (until the goal sheet lands)

struct StudioCommandGoalSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var draft = ""

    private var goal: SessionGoal? { controller.session.goal }

    var body: some View {
        StudioSheetFrame(title: "Goal", subtitle: "What Juno works toward until it is met.", done: done) {
            Form {
                if let goal {
                    Section {
                        TextField("Objective", text: $draft, axis: .vertical)
                            .lineLimit(2...6)
                        HStack {
                            Text(Self.state(goal.lifecycle))
                                .font(Studio.Font.meta)
                                .foregroundStyle(Studio.Ink.secondary)
                            Spacer()
                            if draft.trimmingCharacters(in: .whitespacesAndNewlines) != goal.objective,
                               !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            {
                                Button("Save") { Task { await save() } }
                            }
                        }
                    }
                    Section("Steps") {
                        ForEach(goal.steps) { step in
                            StudioSheetRow(label: step.title, value: Self.state(step.status))
                        }
                    }
                    if !goal.verificationEvidence.isEmpty {
                        Section("Evidence") {
                            ForEach(goal.verificationEvidence, id: \.id) { evidence in
                                StudioSheetRow(label: evidence.summary, note: evidence.source)
                            }
                        }
                    }
                    Section {
                        HStack {
                            if goal.lifecycle == .active {
                                Button("Pause") { Task { await controller.setGoalLifecycle(.paused) } }
                            } else if goal.lifecycle != .completed {
                                Button("Resume") { Task { await controller.setGoalLifecycle(.active) } }
                            }
                            Spacer()
                            Button("Clear", role: .destructive) {
                                Task {
                                    _ = await controller.commandClearGoal()
                                    done()
                                }
                            }
                        }
                    }
                } else {
                    Section {
                        Text("No goal. Type /goal and what you want done, and Juno keeps working until it is met.")
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .onAppear { draft = goal?.objective ?? "" }
    }

    private func save() async {
        guard let live = controller.live else { return }
        let objective = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try? await live.store.updateGoal(sessionID: controller.sessionID, mutation: .setObjective(objective))
    }

    static func state(_ lifecycle: GoalLifecycle) -> String {
        switch lifecycle {
        case .active: "Working toward it"
        case .paused: "Paused"
        case .blocked: "Blocked"
        case .completed: "Met"
        }
    }

    static func state(_ status: GoalStepStatus) -> String {
        switch status {
        case .pending: "Not started"
        case .inProgress: "In progress"
        case .completed: "Done"
        case .blocked: "Blocked"
        }
    }
}

// MARK: - /verify (until the verify recipe lands)

struct StudioVerifySheet: View {
    let controller: SessionController
    let done: () -> Void

    var body: some View {
        StudioSheetFrame(
            title: "Checks",
            subtitle: "The checks Juno found in this project. Running one asks first, as any command does.",
            done: done
        ) {
            Form {
                Section {
                    if controller.testSuggestions.isEmpty {
                        Text("Juno found no checks here.").foregroundStyle(Studio.Ink.tertiary)
                    }
                    ForEach(controller.testSuggestions) { suggestion in
                        HStack {
                            StudioSheetRow(label: suggestion.command, note: suggestion.toolchain, mono: true)
                            Button("Run") {
                                done()
                                Task { await controller.runTest(command: suggestion.command) }
                            }
                            .disabled(controller.commandSessionIsBusy || controller.isRunningTest)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - /resume

struct StudioResumeSheet: View {
    let controller: SessionController
    let done: () -> Void
    @State private var sessions: [CodeSession] = []
    @State private var query = ""

    private var shown: [CodeSession] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return sessions.filter { session in
            session.id != controller.sessionID
                && (needle.isEmpty || session.title.lowercased().contains(needle))
        }
    }

    var body: some View {
        StudioSheetFrame(title: "Sessions", subtitle: "Open another session. One Juno was stopped in offers to resume it there.", done: done) {
            VStack(spacing: 0) {
                TextField("Search sessions", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding(JunoSpace.regular)
                List(shown, id: \.id) { session in
                    Button {
                        NotificationCenter.default.post(name: .junoCodeOpenSession, object: session.id)
                        done()
                    } label: {
                        StudioSheetRow(
                            label: session.title,
                            value: StudioFormat.age(session.updatedAt),
                            note: Self.state(session.status)
                        )
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .scrollContentBackground(.hidden)
            }
        }
        .task {
            guard let live = controller.live else { return }
            sessions = await live.store.allSessions().filter { $0.parentSessionID == nil }
        }
    }

    static func state(_ status: SessionStatus) -> String {
        switch status {
        case .idle, .completed: "Finished"
        case .running, .planning, .waitingForProvider, .degraded: "Working"
        case .waitingForApproval: "Waiting for you"
        case .failed: "Ended with an error"
        case .cancelled, .stopping: "Stopped"
        }
    }
}

// MARK: - /memory

struct StudioMemorySheet: View {
    let controller: SessionController
    let done: () -> Void

    private struct File: Identifiable {
        let path: String
        let note: String
        let isYours: Bool
        var id: String { path }
    }

    private var files: [File] {
        [
            File(path: "~/.juno/JUNO.md", note: "Yours, in every project. Opens in your editor.", isYours: true),
            File(path: "AGENTS.md", note: "This project's instructions for any agent.", isYours: false),
            File(path: "JUNO.md", note: "This project's instructions for Juno.", isYours: false),
            File(path: "CLAUDE.md", note: "This project's instructions for Claude Code, read by Juno too.", isYours: false),
        ]
    }

    var body: some View {
        StudioSheetFrame(title: "Instruction files", subtitle: "What Juno reads before it works. They are context, never permissions.", done: done) {
            Form {
                Section {
                    ForEach(files) { file in
                        HStack {
                            StudioSheetRow(label: file.path, note: file.note, mono: true)
                            Button("Open") { Task { await open(file) } }
                                .disabled(!file.isYours && controller.context == nil)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
    }

    private func open(_ file: File) async {
        if file.isYours {
            let directory = controller.context?.userSettingsDirectory ?? CodeSettingsStore.defaultUserDirectory
            StudioFiles.openOrCreate(directory.appendingPathComponent("JUNO.md"))
            return
        }
        guard let context = controller.context, let path = try? WorkspacePath(file.path) else { return }
        if (try? context.access.resolveForReading(path)).map({ FileManager.default.fileExists(atPath: $0.path) }) != true {
            _ = try? await context.files.create(path, content: "# \(file.path)\n\n", sessionID: controller.sessionID)
        }
        if let document = await controller.openWorkspaceFile(path) {
            done()
            controller.review.openDocument = document
        }
    }
}
