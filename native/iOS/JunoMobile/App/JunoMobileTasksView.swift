import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// **Tasks** — the account's scheduled prompts: a cadence, a model, and a
/// question Juno answers on its own and files into a chat.
///
/// Everything the web dashboard can do is here: create, edit, pause, delete, and
/// open the conversation a run wrote into. The screen states the plan ceiling
/// rather than hiding the New button behind a control that silently fails —
/// a 403 arriving after the form is filled in is the worst place to learn it.
struct JunoMobileTasksView: View {
    @Bindable var model: NativeScheduledTaskModel
    /// Chat models the account can actually schedule against, from the same
    /// catalog the composer uses.
    var models: [NativeChatModelOption] = []
    var openConversation: (String) -> Void

    @State private var editing: JunoTaskEditorRequest?
    @State private var deleteTarget: NativeScheduledTask?

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed:
                ContentUnavailableView {
                    Label("tasks.unavailable", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.lastErrorDescription ?? String(localized: "tasks.retry"))
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.borderedProminent)
                }
            case .ready:
                content
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editing = JunoTaskEditorRequest(
                        draft: NativeScheduledTaskDraft(model: defaultModelID), taskID: nil
                    )
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(model.isAtLimit || model.isPlanLocked || models.isEmpty)
                .accessibilityLabel("tasks.new")
                .accessibilityIdentifier("juno.mobile.tasks-new")
            }
        }
        .sheet(item: $editing) { request in
            JunoMobileTaskEditor(
                draft: request.draft,
                models: models,
                isEditing: request.taskID != nil,
                isSaving: model.isMutating
            ) { saved in
                if let taskID = request.taskID {
                    await model.update(id: taskID, draft: saved)
                } else {
                    await model.create(saved)
                }
            }
        }
        .confirmationDialog(
            deleteTarget.map { String(format: String(localized: "tasks.delete.confirm"), $0.name) } ?? "",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { await model.delete(id: target.id) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("tasks.delete.detail")
        }
        .accessibilityIdentifier("juno.mobile.tasks")
    }

    private var defaultModelID: String {
        models.first(where: \.isAvailable)?.id ?? models.first?.id ?? ""
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                JunoPageTitle(title: "navigation.tasks", subtitle: "tasks.subtitle")
                    .padding(.top, 6)

                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) { Task { await model.refresh() } }
                }

                if model.isPlanLocked {
                    locked
                } else if model.tasks.isEmpty {
                    empty
                } else {
                    ForEach(model.tasks) { task in
                        JunoMobileTaskCard(
                            task: task,
                            busy: model.isMutating,
                            onToggle: { enabled in
                                Task { await model.setEnabled(id: task.id, enabled: enabled) }
                            },
                            onEdit: {
                                editing = JunoTaskEditorRequest(
                                    draft: NativeScheduledTaskDraft(task: task), taskID: task.id
                                )
                            },
                            onDelete: { deleteTarget = task },
                            onOpenResults: { task.conversationID.map(openConversation) }
                        )
                    }
                    if model.isAtLimit {
                        Text(String(format: String(localized: "tasks.limit"), model.limit))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 4)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
    }

    private var empty: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("tasks.empty.title")
                    .font(.system(size: 17, weight: .semibold))
                Text("tasks.empty.detail")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button {
                    editing = JunoTaskEditorRequest(
                        draft: NativeScheduledTaskDraft(model: defaultModelID), taskID: nil
                    )
                } label: {
                    Text("tasks.new")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .modifier(JunoAccentGlassCapsule())
                }
                .buttonStyle(.plain)
                .disabled(models.isEmpty)
                .padding(.top, 2)
            }
        }
    }

    private var locked: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("tasks.locked.title", systemImage: "lock")
                    .font(.system(size: 17, weight: .semibold))
                Text("tasks.locked.detail")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// One scheduled task. The cadence leads because it is what distinguishes two
/// tasks at a glance; the switch is the only control on the card itself, since
/// pausing is the change most often wanted and the one most easily undone.
private struct JunoMobileTaskCard: View {
    let task: NativeScheduledTask
    let busy: Bool
    /// `@MainActor @Sendable` because it is called from inside a `Binding`'s
    /// setter, whose accessors are `@Sendable` in the iOS 26 SDK. The toggle is
    /// driven on the main actor, so the annotation states what already happens.
    let onToggle: @MainActor @Sendable (Bool) -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onOpenResults: () -> Void

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(task.scheduleDescription)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.tertiary)
                        Text(task.name)
                            .font(JunoSerif.cardTitle)
                            .lineLimit(1)
                        HStack(spacing: 5) {
                            Text(task.modelName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if task.webSearch {
                                Image(systemName: "globe")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    Spacer(minLength: 4)
                    // Called, not passed — the second of the two sites, and see
                    // the note on the same `Binding` in JunoMobileAttachmentMenu:
                    // passing the isolated closure itself is what emits the
                    // thunk the CI toolchain crashes on.
                    Toggle("", isOn: Binding(get: { task.enabled }, set: { onToggle($0) }))
                        .labelsHidden()
                        .tint(Color.junoAccent)
                        .disabled(busy)
                        .accessibilityLabel(
                            Text(
                                String(
                                    format: String(
                                        localized: task.enabled ? "tasks.pause" : "tasks.resume"
                                    ),
                                    task.name
                                )
                            )
                        )
                    Menu {
                        Button { onEdit() } label: { Label("Edit", systemImage: "pencil") }
                        if task.conversationID != nil {
                            Button { onOpenResults() } label: {
                                Label("tasks.results", systemImage: "arrow.up.right")
                            }
                        }
                        Divider()
                        Button(role: .destructive) { onDelete() } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("tasks.options")
                }

                Divider().overlay(Color.junoHairline)

                HStack(spacing: 8) {
                    statusLine
                    Spacer(minLength: 6)
                    if task.conversationID != nil {
                        Button(action: onOpenResults) {
                            HStack(spacing: 3) {
                                Text("tasks.results")
                                Image(systemName: "arrow.up.right")
                            }
                            .font(.caption.weight(.medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .opacity(task.enabled ? 1 : 0.7)
    }

    /// One line summing up where the task stands — the last run, or the first one
    /// ahead. A failed run says *why* rather than showing a red dot.
    @ViewBuilder
    private var statusLine: some View {
        if let run = task.latestRun, run.isRunning {
            Label("tasks.status.running", systemImage: "circle.dotted")
                .font(.caption)
                .foregroundStyle(Color.junoAccent)
        } else if !task.enabled {
            Text("tasks.status.paused").font(.caption).foregroundStyle(.secondary)
        } else if let run = task.latestRun, run.didFail {
            Text(run.errorDescription ?? String(localized: "tasks.status.failed"))
                .font(.caption)
                .foregroundStyle(.orange)
                .lineLimit(2)
        } else if let run = task.latestRun {
            Text(
                String(
                    format: String(localized: "tasks.status.ran"),
                    (run.finishedAt ?? run.startedAt).formatted(.relative(presentation: .named))
                )
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        } else {
            Text(
                String(
                    format: String(localized: "tasks.status.first-run"),
                    task.nextRunAt.formatted(date: .abbreviated, time: .shortened)
                )
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

/// Create and edit share one form, because the server's PATCH is a partial of
/// its POST and two forms is how the two drift apart.
private struct JunoMobileTaskEditor: View {
    @State var draft: NativeScheduledTaskDraft
    let models: [NativeChatModelOption]
    let isEditing: Bool
    let isSaving: Bool
    let save: (NativeScheduledTaskDraft) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("tasks.field.name", text: $draft.name)
                        .accessibilityIdentifier("juno.mobile.task-name")
                    TextField(
                        "tasks.field.prompt", text: $draft.prompt, axis: .vertical
                    )
                    .lineLimit(3...8)
                    .accessibilityIdentifier("juno.mobile.task-prompt")
                } header: {
                    Text("tasks.section.what")
                } footer: {
                    Text("tasks.field.prompt.help")
                }

                Section("tasks.section.when") {
                    Picker("tasks.field.cadence", selection: $draft.cadence) {
                        ForEach(NativeTaskCadence.allCases) { cadence in
                            Text(cadence.label).tag(cadence)
                        }
                    }
                    if draft.cadence.needsWeekday {
                        Picker(
                            "tasks.field.weekday",
                            selection: Binding(
                                get: { draft.weekday ?? 1 }, set: { draft.weekday = $0 }
                            )
                        ) {
                            ForEach(0..<7, id: \.self) { index in
                                Text(NativeScheduledTask.weekdayLabel(index)).tag(index)
                            }
                        }
                    }
                    if draft.cadence.needsMonthday {
                        Picker(
                            "tasks.field.monthday",
                            selection: Binding(
                                get: { draft.monthday ?? 1 }, set: { draft.monthday = $0 }
                            )
                        ) {
                            // 1–28 so a monthly task lands inside every month —
                            // the 30th would silently never fire in February.
                            ForEach(1...28, id: \.self) { day in
                                Text(NativeScheduledTask.ordinal(day)).tag(day)
                            }
                        }
                    }
                    DatePicker(
                        "tasks.field.time", selection: $time, displayedComponents: .hourAndMinute
                    )
                    LabeledContent("tasks.field.timezone", value: draft.timezone)
                        .foregroundStyle(.secondary)
                }

                Section("tasks.section.how") {
                    Picker("tasks.field.model", selection: $draft.model) {
                        ForEach(models.filter(\.isAvailable)) { option in
                            Text(option.displayName).tag(option.id)
                        }
                    }
                    Toggle("tasks.field.web", isOn: $draft.webSearch)
                        .tint(Color.junoAccent)
                }
            }
            .navigationTitle(isEditing ? "tasks.edit" : "tasks.new")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        applyTime()
                        Task {
                            await save(draft)
                            dismiss()
                        }
                    }
                    .disabled(!draft.isValid || isSaving)
                    .accessibilityIdentifier("juno.mobile.task-save")
                }
            }
            .onAppear {
                time = Calendar.current.date(
                    bySettingHour: draft.hour, minute: draft.minute, second: 0, of: Date()
                ) ?? Date()
            }
            .onChange(of: time) { _, _ in applyTime() }
        }
    }

    private func applyTime() {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        draft.hour = parts.hour ?? draft.hour
        draft.minute = parts.minute ?? draft.minute
    }
}

/// What the editor sheet is opened with. A box rather than the draft itself:
/// `sheet(item:)` re-presents whenever the item's id changes, and a draft is a
/// value that changes on every keystroke.
private struct JunoTaskEditorRequest: Identifiable {
    let id = UUID()
    let draft: NativeScheduledTaskDraft
    /// Nil when creating.
    let taskID: String?
}
