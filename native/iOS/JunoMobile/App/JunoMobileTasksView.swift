import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// **Tasks** — the account's scheduled prompts: a cadence, a model, and a
/// question Alevr answers on its own and files into a chat.
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
                        .buttonStyle(.bordered)
                        .contentShape(.rect)
                }
            case .ready:
                content
            }
        }
        // The page names itself in the navigation bar, as a large title in the
        // display face, so the search field sits under the title rather than
        // above it and the name collapses into the bar on scroll.
        .navigationTitle("navigation.tasks")
        .navigationBarTitleDisplayMode(.large)
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
                // `isCreatable` is the server's own word for it. The reading it
                // replaced — no limit and no tasks — was false for every
                // account that had a task, so this `+` stayed enabled on
                // exactly the accounts whose POST now answers 410.
                .disabled(!model.isCreatable || model.isAtLimit || models.isEmpty)
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
            .contentShape(.rect)
            Button("Cancel", role: .cancel) { deleteTarget = nil }
            .contentShape(.rect)
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
        if model.isRetiredAndEmpty {
            ContentUnavailableView {
                Label("tasks.moved.title", systemImage: "checklist")
            } description: {
                Text("tasks.moved.detail")
            }
        } else if model.tasks.isEmpty {
            ContentUnavailableView {
                Label("tasks.empty.title", systemImage: "checklist")
            } description: {
                Text("tasks.empty.detail")
            } actions: {
                Button("tasks.new") {
                    editing = JunoTaskEditorRequest(
                        draft: NativeScheduledTaskDraft(model: defaultModelID), taskID: nil
                    )
                }
                .disabled(models.isEmpty || !model.isCreatable)
                .contentShape(.rect)
            }
        } else {
            List {
                if let error = model.lastErrorDescription {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                        Button("Retry") { Task { await model.refresh() } }
                    }
                }
                Section {
                    ForEach(model.tasks) { task in
                        JunoMobileTaskRow(
                            task: task,
                            busy: model.isMutating,
                            editable: model.canEdit(task),
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
                } header: {
                    Text("tasks.subtitle")
                        .textCase(nil)
                } footer: {
                    if model.isAtLimit {
                        Text(String(format: String(localized: "tasks.limit"), model.limit))
                    }
                }
            }
            .listStyle(.insetGrouped)
            .junoGroupedPage()
        }
    }
}

/// One scheduled task as a stock list row: name, cadence and model beneath,
/// where it stands on a third line, and the switch — pausing is the change
/// most often wanted and the one most easily undone. Tap to edit; swipe or
/// long-press for the rest.
private struct JunoMobileTaskRow: View {
    let task: NativeScheduledTask
    let busy: Bool
    /// False once the task has become an Automation: every write on
    /// `/api/tasks/<id>` answers 409 from then on.
    let editable: Bool
    /// `@MainActor @Sendable` because it is called from inside a `Binding`'s
    /// setter, whose accessors are `@Sendable` in the iOS 26 SDK.
    let onToggle: @MainActor @Sendable (Bool) -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onOpenResults: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onEdit) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.name)
                        .foregroundStyle(task.enabled ? Color.primary : Color.secondary)
                        .lineLimit(1)
                    Text(verbatim: "\(task.scheduleDescription) · \(task.modelName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    statusLine
                        .font(.footnote)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!editable)
            // Called, not passed: passing the isolated closure itself is what
            // emits the thunk the CI toolchain crashes on.
            Toggle("", isOn: Binding(get: { task.enabled }, set: { onToggle($0) }))
                .labelsHidden()
                .disabled(busy || !editable)
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
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) { onDelete() }
                .disabled(!editable)
        }
        .contextMenu {
            Button("Edit", systemImage: "pencil") { onEdit() }
                .disabled(!editable)
            if task.conversationID != nil {
                Button("tasks.results", systemImage: "bubble.left") { onOpenResults() }
            }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) { onDelete() }
                .disabled(!editable)
        }
    }

    /// Where the task stands — the last run, or the first one ahead. A failed
    /// run says *why* rather than showing a red dot.
    @ViewBuilder
    private var statusLine: some View {
        if let run = task.latestRun, run.isRunning {
            Text("tasks.status.running").foregroundStyle(.secondary)
        } else if !editable {
            Text("tasks.status.moved").foregroundStyle(.secondary)
        } else if !task.enabled {
            Text("tasks.status.paused").foregroundStyle(.secondary)
        } else if let run = task.latestRun, run.didFail {
            Text(run.errorDescription ?? String(localized: "tasks.status.failed"))
                .foregroundStyle(Color.junoCaution)
        } else if let run = task.latestRun {
            Text(
                String(
                    format: String(localized: "tasks.status.ran"),
                    (run.finishedAt ?? run.startedAt).formatted(.relative(presentation: .named))
                )
            )
            .foregroundStyle(.secondary)
        } else {
            Text(
                String(
                    format: String(localized: "tasks.status.first-run"),
                    task.nextRunAt.formatted(date: .abbreviated, time: .shortened)
                )
            )
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
                }

                Section("tasks.section.how") {
                    Picker("tasks.field.model", selection: $draft.model) {
                        ForEach(models.filter(\.isAvailable)) { option in
                            Text(option.displayName).tag(option.id)
                        }
                    }
                    Toggle("tasks.field.web", isOn: $draft.webSearch)
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
