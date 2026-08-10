import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// What the Tasks page and the Tasks inspector both stand on.
///
/// The two are no longer one view. `.inspector` attached to a
/// `NavigationSplitView`'s detail column takes the process down with SIGTRAP —
/// ``DesktopCodeWorkspace`` carries the bisected report — so the trailing column
/// is now mounted on the window's split view and this page is only what fills the
/// detail column. That puts the table and the inspector in two different columns
/// of one window, and `@State` cannot span them.
///
/// It is one object rather than three bindings because the page is built by
/// `DesktopDestinationView`, which has nothing to hand down: ``DesktopChatWorkspace``
/// owns this, renders the inspector from it directly, and puts it in the
/// environment for the page. Selection is here for the obvious reason — the
/// inspector describes whatever row is selected — and the two pending
/// presentations are here because the inspector raises the same editor and the
/// same delete confirmation the table's own menu does, while the page is what
/// presents them.
@MainActor
@Observable
final class DesktopTasksSurface {
    /// The `Table`'s selection, and therefore the record the inspector describes.
    var selectedTaskID: NativeScheduledTask.ID?
    /// A requested editor. The sheet is presented by the page, never by the
    /// inspector: a column the reader can close is not a place to present from.
    var editorRequest: DesktopTaskEditorRequest?
    /// A requested delete confirmation, presented by the page for the same reason.
    var deleteTarget: NativeScheduledTask?
}

/// **Tasks** — the account's scheduled prompts: a cadence, a model, and a
/// question Juno answers on its own and files into a chat.
///
/// Laid out the way `src/app/(app)/tasks/page.tsx` is: a mono eyebrow, an
/// editorial serif heading, one sentence of what the page is for, and the
/// plan count sitting quietly at the end of that line. Below it the records —
/// a Mac window shows a set of records as a `Table`, so that is what this is,
/// **on a raised card over the warm canvas** rather than painted straight onto
/// it. That relationship is the whole difference between this window and the
/// website: the web puts white `--card` surfaces on `--background`, and a page
/// that skips the card reads as one flat cream field.
///
/// The canvas itself is painted once, on the detail column
/// (`DesktopChatWorkspace`), and deliberately not repainted here.
///
/// Nothing on this page is glass. A table of runs is a reading surface and an
/// inspector is a column; glass is reserved for chrome that floats.
///
/// Everything here is wired to ``NativeScheduledTaskModel``. There is
/// deliberately **no Run-now**: `/api/tasks` publishes GET/POST and
/// PATCH/DELETE only, the worker is the sole thing that starts a run, and a
/// button that cannot reach the server is worse than an absent one.
struct DesktopTasksScreen: View {
    @Bindable var model: NativeScheduledTaskModel
    let modelOptions: [NativeChatModelOption]
    let openConversation: (String) -> Void

    /// Whether the trailing column is up.
    ///
    /// The `.inspector` this drives belongs to the window (``DesktopChatWorkspace``
    /// declares the same key), so the key itself is the wire: scene storage is one
    /// value per key per scene, and both views read and write that one value. The
    /// toolbar toggle below therefore still opens and closes a column this page
    /// does not own — and the default stays `true`, because task detail is the
    /// point of the page rather than an extra.
    @SceneStorage("juno.desktop.tasks.inspector") private var isInspectorShown = true
    /// Selection and the two pending presentations, shared with the inspector the
    /// window renders. Injected by ``DesktopChatWorkspace``, which is the only
    /// place this page is built.
    @Environment(DesktopTasksSurface.self) private var surface
    // Soonest-first: the question a schedule answers is "what happens next".
    @State private var sortOrder = [
        KeyPathComparator(\NativeScheduledTask.nextRunAt, order: .forward)
    ]

    private var selectedTask: NativeScheduledTask? {
        model.task(withID: surface.selectedTaskID)
    }

    private var canCreate: Bool {
        !model.isPlanLocked && !model.isAtLimit && !modelOptions.isEmpty
    }

    var body: some View {
        @Bindable var surface = surface
        // `Color.clear.overlay { … }` — the clamp. A detail column reports its
        // ideal size upward and `NavigationSplitView` grows its AppKit split
        // view to satisfy it, so a tall page resizes the *window* instead of
        // being clipped. `Color.clear` accepts whatever height it is proposed
        // and an overlay is sized by its base, so this page can never push back.
        //
        // No `.inspector` here. The trailing column is mounted on the window's
        // split view (``DesktopChatWorkspace``); attached to a detail column it
        // is the SIGTRAP ``DesktopCodeWorkspace`` bisected, and this page reached
        // it on a single sidebar click because its flag defaults to showing.
        Color.clear
            .overlay { page }
            .toolbar { tasksToolbar }
            .onDeleteCommand { surface.deleteTarget = selectedTask }
            .sheet(item: $surface.editorRequest) { request in
                DesktopTaskEditor(
                    model: model,
                    request: request,
                    modelOptions: modelOptions
                )
            }
            .desktopPreviewOverlays(
                sheet: newTask,
                confirm: { surface.deleteTarget = model.tasks.first }
            )
            .confirmationDialog(
                surface.deleteTarget.map { "Delete “\($0.name)”?" } ?? "",
                isPresented: Binding(
                    get: { surface.deleteTarget != nil },
                    set: { if !$0 { surface.deleteTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Task", role: .destructive) {
                    guard let target = surface.deleteTarget else { return }
                    surface.deleteTarget = nil
                    if surface.selectedTaskID == target.id {
                        surface.selectedTaskID = nil
                    }
                    Task { await model.delete(id: target.id) }
                }
                Button("Cancel", role: .cancel) { surface.deleteTarget = nil }
            } message: {
                Text(
                    "The schedule stops and its run history is removed. The chat its results were written into is kept."
                )
            }
            .accessibilityIdentifier("juno.desktop.tasks")
    }

    private var page: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, JunoSpace.region)
                .padding(.top, JunoSpace.region)
                .padding(.bottom, JunoSpace.roomy)

            if model.phase == .ready, let error = model.lastErrorDescription {
                errorNotice(
                    DesktopStatusCopy(subject: "scheduled tasks", singular: "task")
                        .humanized(error, fallback: "Juno couldn't refresh your scheduled tasks.")
                )
                .padding(.horizontal, JunoSpace.region)
                .padding(.bottom, JunoSpace.regular)
            }

            content
                .padding(.horizontal, JunoSpace.region)
                .padding(.bottom, JunoSpace.region)
                // The greedy frame goes *outside* the padding. The other order
                // asks for "everything, plus 32", which is unsatisfiable and is
                // how a page ends up sizing the split view.
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - Header

    /// The website's page head. No fill of its own: the warm canvas is the
    /// backdrop here, and the card below is what lifts off it.
    private var header: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.regular) {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text("Tasks")
                        .junoCodeSmall()
                        .foregroundStyle(Color.junoMutedForeground)
                    Text("Scheduled tasks")
                        .junoPageHeading()
                }
                Spacer(minLength: JunoSpace.snug)
                HStack(spacing: JunoSpace.snug) {
                    if model.isMutating {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Saving")
                    }
                    if let count = planCount {
                        Text(count)
                            .junoCodeSmall()
                            .foregroundStyle(Color.junoMutedForeground)
                            .help("Scheduled tasks used against this plan's ceiling.")
                    }
                }
            }
            Text("Prompts Juno runs for you on a schedule — each run lands in the task's chat thread.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// `3 / 10`, the way the web states it. Absent rather than zeroed while the
    /// list is still loading, and absent when the plan carries no ceiling to
    /// count against.
    private var planCount: String? {
        guard model.phase == .ready, model.limit > 0 else { return nil }
        return "\(model.tasks.count) / \(model.limit)"
    }

    /// A load failure that arrived while a list is already on screen. It gets a
    /// card of its own rather than a band across the bottom of the window — the
    /// web puts it in the flow, directly under the heading it belongs to.
    private func errorNotice(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Color.junoDanger)
            Text(message)
                .junoCaption()
                .foregroundStyle(Color.junoDanger)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: JunoSpace.snug)
            Button("Try Again") { Task { await model.refresh() } }
                .controlSize(.small)
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .junoCard()
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed:
            JunoEmptyState(
                title: "Tasks unavailable",
                // Through the shared copy: the service answers with bare status
                // phrases, and "Not found" as the only thing on an empty screen
                // tells the reader nothing about what to do next.
                message: DesktopStatusCopy(subject: "scheduled tasks", singular: "task")
                    .humanized(
                        model.lastErrorDescription,
                        fallback: "The scheduled-task service could not be reached."
                    ),
                symbol: "exclamationmark.triangle",
                actionLabel: "Try Again",
                action: { Task { await model.refresh() } }
            )
        case .ready:
            if model.isPlanLocked {
                // The same sentence the web shows for `limit === 0`. No upgrade
                // button: the desktop shell has no purchase surface to send
                // anyone to, and a button that goes nowhere is worse than none.
                JunoEmptyState(
                    title: "Tasks are part of Pro",
                    message: "Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson.",
                    symbol: "lock"
                )
            } else if model.tasks.isEmpty {
                emptyState
            } else {
                tableCard
            }
        }
    }

    /// One honest state, never a stack of placeholder rows behind it.
    @ViewBuilder
    private var emptyState: some View {
        let message = "Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson."
        // The destination's own mark rather than SF's `clock`. The web draws no
        // glyph in this state at all, so there is nothing to copy — but a page
        // whose sidebar row is a Lucide calendar-clock should not name itself
        // with a borrowed one when its empty state is the only picture on it.
        if canCreate {
            JunoEmptyState(
                title: "Nothing scheduled",
                message: message,
                icon: .tasks,
                actionLabel: "New Task",
                action: newTask
            )
        } else {
            JunoEmptyState(
                title: "Nothing scheduled",
                message: modelOptions.isEmpty
                    ? "No model is available to schedule against yet."
                    : message,
                icon: .tasks
            )
        }
    }

    // MARK: - Table

    /// The table on a raised card.
    ///
    /// Two details carry that. `alternatesRowBackgrounds: false` — an inset
    /// table with alternating rows paints stripes across the *whole* view, so a
    /// short list grows a run of phantom grey rows under its real ones. And
    /// `.scrollContentBackground(.hidden)`, so the card's white shows through
    /// instead of the table's own system fill sitting on top of it.
    private var tableCard: some View {
        table
            .scrollContentBackground(.hidden)
            .clipShape(
                RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
            )
            .junoCard()
    }

    private var table: some View {
        Table(
            model.tasks.sorted(using: sortOrder),
            selection: Bindable(surface).selectedTaskID,
            sortOrder: $sortOrder
        ) {
            // The web card's one on-card control, and the change most often
            // wanted. Backed by `setEnabled`, which flips locally and rolls back
            // if the server refuses.
            TableColumn("On", value: \.enabledRank) { task in
                Toggle("", isOn: taskEnabledBinding(task, in: model))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .tint(Color.junoAccent)
                    .disabled(model.isMutating)
                    .help(task.enabled ? "Pause this task" : "Resume this task")
                    .accessibilityLabel(
                        task.enabled ? "Pause \(task.name)" : "Resume \(task.name)"
                    )
            }
            .width(min: 44, ideal: 52, max: 64)

            // System font, not the serif the web card uses for a name: a table
            // row is scanned, and 19pt Newsreader in a 24pt row is a heading in
            // the wrong place. The serif carries the name in the inspector,
            // where it is a title rather than a cell.
            TableColumn("Name", value: \.name) { task in
                Text(task.name)
                    .lineLimit(1)
                    .help(task.prompt)
            }
            .width(min: 140, ideal: 220)

            // `Daily · 08:00` in the monospace role, exactly as the web card
            // sets it. The full sentence and the cron form are in the inspector.
            TableColumn("Schedule", value: \.scheduleDescription) { task in
                Text(task.scheduleDescription)
                    .junoCodeSmall()
                    .foregroundStyle(Color.junoMutedForeground)
                    .lineLimit(1)
                    .help(TaskSchedule.words(for: task))
            }
            .width(min: 120, ideal: 165)

            TableColumn("Model", value: \.modelName) { task in
                HStack(spacing: JunoSpace.hairline) {
                    Text(task.modelName)
                        .lineLimit(1)
                    if task.webSearch {
                        Image(systemName: "globe")
                            .foregroundStyle(Color.junoMutedForeground)
                            .accessibilityLabel("Web search allowed")
                    }
                }
            }
            .width(min: 110, ideal: 150)

            TableColumn("Next run", value: \.nextRunAt) { task in
                Text(
                    task.nextRunAt,
                    format: .dateTime.weekday(.abbreviated).month(.abbreviated)
                        .day().hour().minute()
                )
                .lineLimit(1)
                // A paused task keeps a computed next run that will not fire, so
                // the date is stated quietly rather than as a promise.
                .foregroundStyle(task.enabled ? Color.junoForeground : Color.junoMutedForeground)
                .help(
                    task.enabled
                        ? task.nextRunAt.formatted(date: .complete, time: .shortened)
                        : "Paused — this task will not run."
                )
            }
            .width(min: 130, ideal: 170)

            // One column, not two. The web says "Ran 3 hours ago · $0.02" or
            // "Failed 2 days ago — <reason>" in a single line, because when a
            // run happened and how it went are one fact.
            TableColumn("Last run", value: \.lastRunSortKey) { task in
                DesktopTaskStatusCell(task: task)
            }
            .width(min: 160, ideal: 260)
        }
        .tableStyle(.inset(alternatesRowBackgrounds: false))
        // The selected row in the web's warm grey rather than the app accent,
        // which is what macOS paints a focused table selection with. It has to
        // sit *below* the row switch's own `.tint(Color.junoAccent)` in the
        // hierarchy — a tint set inside a cell wins over the table's — which is
        // why the switch stays coral while the row behind it goes grey.
        .junoSidebarSelectionTint()
        .contextMenu(forSelectionType: NativeScheduledTask.ID.self) { ids in
            if let target = model.task(withID: ids.first) {
                rowMenu(for: target)
            } else {
                Button("New Task", action: newTask)
                    .disabled(!canCreate)
            }
        } primaryAction: { ids in
            guard let target = model.task(withID: ids.first) else { return }
            surface.editorRequest = DesktopTaskEditorRequest(task: target)
        }
        .accessibilityIdentifier("juno.desktop.tasks-table")
    }

    @ViewBuilder
    private func rowMenu(for task: NativeScheduledTask) -> some View {
        Button("Edit Task…") { surface.editorRequest = DesktopTaskEditorRequest(task: task) }
        Button(task.enabled ? "Pause Task" : "Resume Task") {
            Task { await model.setEnabled(id: task.id, enabled: !task.enabled) }
        }
        .disabled(model.isMutating)
        Button("Open Results") {
            guard let conversationID = task.conversationID else { return }
            openConversation(conversationID)
        }
        .disabled(task.conversationID == nil)
        Divider()
        Button("Delete Task…", role: .destructive) { surface.deleteTarget = task }
    }

    // MARK: - Toolbar

    /// Every item is present in every state and disables rather than vanishing:
    /// a `ToolbarItem` that comes and goes makes SwiftUI rebuild the AppKit
    /// toolbar under a live window, which is what drove this shell's split-view
    /// constraint loop.
    ///
    /// The web puts *New task* in the page header because it has no toolbar. A
    /// Mac window does, and stating the action twice on one surface is noise.
    @ToolbarContentBuilder
    private var tasksToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button(action: newTask) {
                Label("New Task", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .disabled(!canCreate)
            .help(newTaskHelp)
            .accessibilityLabel("New task")
            .accessibilityIdentifier("juno.desktop.tasks-new")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                guard let task = selectedTask else { return }
                surface.editorRequest = DesktopTaskEditorRequest(task: task)
            } label: {
                Label("Edit Task", systemImage: "pencil")
            }
            .keyboardShortcut("e", modifiers: [.command])
            .disabled(selectedTask == nil)
            .help("Edit the selected task (⌘E)")
            .accessibilityLabel("Edit task")
            .accessibilityIdentifier("juno.desktop.tasks-edit")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: [.command])
            .disabled(model.phase == .loading)
            .help("Reload schedules and run history (⌘R)")
            .accessibilityLabel("Refresh tasks")
            .accessibilityIdentifier("juno.desktop.tasks-refresh")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                isInspectorShown.toggle()
            } label: {
                Label("Task Details", systemImage: "sidebar.trailing")
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            .help("Show or hide task details (⌥⌘I)")
            .accessibilityLabel("Toggle task details")
            .accessibilityIdentifier("juno.desktop.tasks-inspector-toggle")
        }
    }

    private var newTaskHelp: String {
        if model.isPlanLocked { return "This account's plan allows no scheduled tasks." }
        if model.isAtLimit { return "This plan allows \(model.limit) scheduled tasks." }
        if modelOptions.isEmpty { return "No model is available to schedule against." }
        return "Create a scheduled task (⇧⌘N)"
    }

    // MARK: - Actions

    private func newTask() {
        surface.editorRequest = DesktopTaskEditorRequest(
            draft: NativeScheduledTaskDraft(model: modelOptions.first?.id ?? ""),
            taskID: nil
        )
    }
}

// MARK: - Inspector

/// **Task details** — the web card, opened out: the mono cadence, the name in the
/// editorial serif, the status line, then the detail a card has no room for.
///
/// A view of its own, rendered by the *window*: `.inspector` on a
/// `NavigationSplitView`'s detail column is a hard crash, so the column hangs off
/// the split view in ``DesktopChatWorkspace`` and what it shows lives here. Page
/// and inspector meet on one ``DesktopTasksSurface`` — this reads the selection
/// from it and writes back the editor and the delete confirmation the page
/// presents, so neither the table's menu nor this column can ask for something the
/// other cannot show.
///
/// A grouped `Form` rather than hand-built cards — on macOS it already draws its
/// groups as raised rounded surfaces over the window's ground, which is the same
/// card-on-canvas relationship the rest of the page is built from, and it tracks
/// the platform as that treatment changes.
struct DesktopTasksInspector: View {
    let model: NativeScheduledTaskModel
    let surface: DesktopTasksSurface
    let openConversation: (String) -> Void

    private var selectedTask: NativeScheduledTask? {
        model.task(withID: surface.selectedTaskID)
    }

    var body: some View {
        // Clamped for the same reason the page is: the inspector is a column of
        // the same split view, and a long prompt would otherwise report an ideal
        // height the window would try to grow to satisfy.
        Color.clear.overlay {
            if let task = selectedTask {
                Form {
                    Section {
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            Text(task.scheduleDescription)
                                .junoCodeSmall()
                                .foregroundStyle(Color.junoMutedForeground)
                            Text(task.name)
                                .font(JunoSerif.cardTitle)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            // Not `.junoCaption()`: that sets a secondary
                            // foreground, which would land outside the cell and
                            // erase the status tint a failure depends on.
                            DesktopTaskStatusCell(task: task)
                        }
                        .padding(.vertical, JunoSpace.hairline)

                        Toggle("Enabled", isOn: taskEnabledBinding(task, in: model))
                            .toggleStyle(.switch)
                            .tint(Color.junoAccent)
                            .disabled(model.isMutating)
                            .accessibilityIdentifier("juno.desktop.tasks-enabled")
                    }

                    Section("Schedule") {
                        Text(TaskSchedule.words(for: task))
                            .junoBody()
                            .fixedSize(horizontal: false, vertical: true)
                        // The equivalent cron expression, in the monospace role:
                        // the worker walks calendar days in the task's own zone,
                        // so the zone is a separate field rather than part of
                        // the line.
                        LabeledContent("Cron") {
                            Text(TaskSchedule.cron(for: task))
                                .junoCode()
                                .textSelection(.enabled)
                        }
                        LabeledContent("Time zone") {
                            Text(task.timezone)
                                .junoCode()
                                .textSelection(.enabled)
                        }
                        LabeledContent("Next run") {
                            Text(
                                task.nextRunAt,
                                format: .dateTime.weekday(.wide).month(.wide)
                                    .day().hour().minute()
                            )
                        }
                    }

                    Section("How it runs") {
                        LabeledContent("Model") {
                            Text(task.modelName)
                        }
                        LabeledContent("Web search") {
                            Text(task.webSearch ? "Allowed" : "Off")
                        }
                    }

                    Section("Last run") {
                        lastRunDetail(task)
                    }

                    Section("Prompt") {
                        Text(task.prompt)
                            .junoBody()
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Section {
                        Button("Edit Task…") {
                            surface.editorRequest = DesktopTaskEditorRequest(task: task)
                        }
                        Button("Open Results") {
                            guard let conversationID = task.conversationID else { return }
                            openConversation(conversationID)
                        }
                        .disabled(task.conversationID == nil)
                        .help(
                            task.conversationID == nil
                                ? "This task has not written a chat yet."
                                : "Open the chat this task writes into."
                        )
                        Button("Delete Task…", role: .destructive) {
                            surface.deleteTarget = task
                        }
                    }
                }
                .formStyle(.grouped)
            } else {
                JunoEmptyState(
                    title: "No task selected",
                    message: "Select a task to read its schedule, its last run and its prompt.",
                    symbol: "list.bullet"
                )
            }
        }
    }

    @ViewBuilder
    private func lastRunDetail(_ task: NativeScheduledTask) -> some View {
        if let run = task.latestRun {
            LabeledContent("Started") {
                Text(run.startedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
            }
            if let finishedAt = run.finishedAt {
                LabeledContent("Finished") {
                    Text(finishedAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                }
            }
            if run.costMicroUSD > 0 {
                LabeledContent("Cost") {
                    Text(NativeScheduledTask.costText(run.costMicroUSD))
                }
            }
            if let errorDescription = run.errorDescription {
                Text(errorDescription)
                    .junoBody()
                    .foregroundStyle(Color.junoDanger)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text("This task has not run yet.")
                .junoCaption()
        }
    }
}

// MARK: - Shared record views

/// The last run as the server described it — never a tick that is not backed by a
/// `done` row, and never a failure without its reason.
///
/// A view rather than a method on either surface: the table's last column and the
/// inspector's header state the same fact, and two copies of that rendering is how
/// one run ends up described two ways.
private struct DesktopTaskStatusCell: View {
    let task: NativeScheduledTask

    var body: some View {
        let status = task.statusLine
        Label {
            Text(status.text)
                .lineLimit(1)
                .truncationMode(.tail)
        } icon: {
            Image(systemName: status.symbol)
        }
        .foregroundStyle(status.tint)
        .help(status.help)
    }
}

/// The on/off switch, wired straight to the model.
///
/// Shared by the table cell and the inspector for the same reason the status line
/// is: `setEnabled` flips locally and rolls back if the server refuses, and the
/// two switches are the same switch.
@MainActor
private func taskEnabledBinding(
    _ task: NativeScheduledTask,
    in model: NativeScheduledTaskModel
) -> Binding<Bool> {
    Binding(
        get: { task.enabled },
        set: { enabled in
            Task { await model.setEnabled(id: task.id, enabled: enabled) }
        }
    )
}

private extension NativeScheduledTaskModel {
    /// The record behind a selection, or nil while nothing is selected — and nil
    /// again for an id whose task a refresh has since removed.
    func task(withID id: NativeScheduledTask.ID?) -> NativeScheduledTask? {
        guard let id else { return nil }
        return tasks.first { $0.id == id }
    }
}

// MARK: - Editor

/// What the editor sheet was opened with. A box rather than the draft itself:
/// `sheet(item:)` re-presents whenever the item's id changes, and a draft is a
/// value that changes on every keystroke.
///
/// Not private: it is the type of a ``DesktopTasksSurface`` field, because the
/// inspector the window renders asks for the editor the page presents.
struct DesktopTaskEditorRequest: Identifiable {
    let id = UUID()
    let draft: NativeScheduledTaskDraft
    /// Nil when creating.
    let taskID: String?

    init(draft: NativeScheduledTaskDraft, taskID: String?) {
        self.draft = draft
        self.taskID = taskID
    }

    init(task: NativeScheduledTask) {
        self.init(draft: NativeScheduledTaskDraft(task: task), taskID: task.id)
    }
}

/// Create and edit share one form, because the server's PATCH is a partial of
/// its POST and two forms is how the two drift apart.
///
/// The sheet is its own window, so its fixed frame cannot reach the split view
/// the page lives in — but it is fixed rather than greedy all the same, because
/// a form that sizes itself to a four-thousand-character prompt is a sheet that
/// grows past the screen. The `Form` scrolls inside it instead.
private struct DesktopTaskEditor: View {
    let model: NativeScheduledTaskModel
    let request: DesktopTaskEditorRequest
    let modelOptions: [NativeChatModelOption]

    @Environment(\.dismiss) private var dismiss
    @State private var draft: NativeScheduledTaskDraft
    @State private var isSaving = false
    /// The failure from *this* save, not whatever error the model was already
    /// carrying when the sheet opened.
    @State private var saveErrorDescription: String?

    /// The day the time picker's clock hands belong to. A schedule stores a
    /// wall-clock hour and minute in the task's own zone, so only the time
    /// components of this date are ever read.
    private let clockDay = Calendar.current.startOfDay(for: Date())

    // Mon–Sun for the weekly picker, stored as 0 = Sunday to match the server.
    private static let weekdayOrder = [1, 2, 3, 4, 5, 6, 0]

    init(
        model: NativeScheduledTaskModel,
        request: DesktopTaskEditorRequest,
        modelOptions: [NativeChatModelOption]
    ) {
        self.model = model
        self.request = request
        self.modelOptions = modelOptions
        _draft = State(initialValue: request.draft)
    }

    private var isEditing: Bool { request.taskID != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(isEditing ? "Edit task" : "New task")
                    .junoPageHeading(compact: true)
                Text(
                    isEditing
                        ? "Adjust what runs, on which model, and when."
                        : "Juno runs this prompt on a schedule — results land in a chat thread."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.top, JunoSpace.roomy)

            Form {
                Section("What Juno should do") {
                    TextField(
                        "Name",
                        text: $draft.name,
                        prompt: Text("Daily AI news brief")
                    )
                    .accessibilityIdentifier("juno.desktop.task-name")
                    TextField(
                        "Prompt",
                        text: $draft.prompt,
                        prompt: Text("Summarize today's most important AI news in five short bullet points, with sources."),
                        axis: .vertical
                    )
                    .lineLimit(4...10)
                    .accessibilityIdentifier("juno.desktop.task-prompt")
                }

                Section("When it runs") {
                    Picker("Repeats", selection: $draft.cadence) {
                        ForEach(NativeTaskCadence.allCases) { cadence in
                            Text(cadence.label)
                                .tag(cadence)
                        }
                    }
                    .pickerStyle(.segmented)

                    if draft.cadence.needsWeekday {
                        Picker("Day of week", selection: weekdayBinding) {
                            ForEach(Self.weekdayOrder, id: \.self) { index in
                                Text(TaskSchedule.weekdayName(index))
                                    .tag(index)
                            }
                        }
                    }
                    if draft.cadence.needsMonthday {
                        // 1–28 so a monthly task lands inside every month — the
                        // 30th would silently never fire in February.
                        Picker("Day of month", selection: monthdayBinding) {
                            ForEach(1...28, id: \.self) { day in
                                Text(NativeScheduledTask.ordinal(day))
                                    .tag(day)
                            }
                        }
                    }
                    DatePicker(
                        "Time",
                        selection: timeBinding,
                        displayedComponents: .hourAndMinute
                    )
                    TextField(
                        "Time zone",
                        text: $draft.timezone,
                        prompt: Text(NativeScheduledTask.defaultTimezone)
                    )
                    .accessibilityIdentifier("juno.desktop.task-timezone")
                    LabeledContent("Cron") {
                        Text(TaskSchedule.cron(for: draft))
                            .junoCode()
                            .textSelection(.enabled)
                    }
                    Text(TaskSchedule.words(for: draft))
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("How it runs") {
                    Picker("Model", selection: $draft.model) {
                        ForEach(modelOptions) { option in
                            Text(option.displayName)
                                .tag(option.id)
                        }
                    }
                    Toggle("Allow web search", isOn: $draft.webSearch)
                        .toggleStyle(.switch)
                        .tint(Color.junoAccent)
                }

                if let saveErrorDescription {
                    Section {
                        Label {
                            Text(saveErrorDescription)
                                .foregroundStyle(Color.junoDanger)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(Color.junoDanger)
                        }
                    }
                }
            }
            .formStyle(.grouped)

            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEditing ? "Save Changes" : "Create Task", action: save)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(!draft.isValid || isSaving || modelOptions.isEmpty)
                    .accessibilityIdentifier("juno.desktop.task-save")
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.bottom, JunoSpace.roomy)
        }
        .frame(width: 560, height: 620)
        // The sheet contract, from `JunoOverlays.swift` — not `junoReadingCanvas`,
        // which is what stood here and is the *page's* ground.
        //
        // This editor was the sheet the contract was written from: it was the one
        // that painted a ground when the other eight painted none. What it got
        // wrong is the two things the modifier does that a bare `.background`
        // cannot, and both were visible in dark:
        //
        //  · `junoReadingCanvas` is `junoCanvas`, the same colour as the page.
        //    Measured on the running app, the sheet's ground came out `#242421`
        //    against a dimmed page of `#201E1D` — 14 parts in 765, no edge at
        //    all. The platter's rounded corners were invisible.
        //  · nothing hid the `Form`'s own grouped background, so the sheet had
        //    *two* grounds: `#242421` behind the header and `#3F3E3C` behind the
        //    form, meeting at a hard square seam that cut across the platter.
        //
        // `junoSheetSurface` fixes both at once — the raised `junoPopover`
        // ground, and the `scrollContentBackground(.hidden)` that lets it reach
        // under the form. `.fitted` because the frame above already states the
        // size, exactly as `DesktopSettingsSheetHost` does.
        .junoSheetSurface(.fitted)
    }

    private func save() {
        isSaving = true
        saveErrorDescription = nil
        Task {
            let saved: Bool
            if let taskID = request.taskID {
                saved = await model.update(id: taskID, draft: draft)
            } else {
                saved = await model.create(draft)
            }
            isSaving = false
            if saved {
                dismiss()
            } else {
                saveErrorDescription = model.lastErrorDescription
                    ?? "The task could not be saved."
            }
        }
    }

    private var weekdayBinding: Binding<Int> {
        Binding(get: { draft.weekday ?? 1 }, set: { draft.weekday = $0 })
    }

    private var monthdayBinding: Binding<Int> {
        Binding(get: { draft.monthday ?? 1 }, set: { draft.monthday = $0 })
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(
                    bySettingHour: draft.hour, minute: draft.minute, second: 0, of: clockDay
                ) ?? clockDay
            },
            set: { newValue in
                let parts = Calendar.current.dateComponents(
                    [.hour, .minute], from: newValue
                )
                draft.hour = parts.hour ?? draft.hour
                draft.minute = parts.minute ?? draft.minute
            }
        )
    }
}

// MARK: - Schedule rendering

/// One place that turns a schedule into words and into its technical form, so a
/// task and an in-progress draft cannot describe the same cadence differently.
private enum TaskSchedule {
    static func words(for task: NativeScheduledTask) -> String {
        words(
            cadence: task.cadence,
            hour: task.hour,
            minute: task.minute,
            weekday: task.weekday,
            monthday: task.monthday,
            timezone: task.timezone
        )
    }

    static func words(for draft: NativeScheduledTaskDraft) -> String {
        words(
            cadence: draft.cadence,
            hour: draft.hour,
            minute: draft.minute,
            weekday: draft.weekday,
            monthday: draft.monthday,
            timezone: draft.timezone
        )
    }

    static func cron(for task: NativeScheduledTask) -> String {
        cron(
            cadence: task.cadence,
            hour: task.hour,
            minute: task.minute,
            weekday: task.weekday,
            monthday: task.monthday
        )
    }

    static func cron(for draft: NativeScheduledTaskDraft) -> String {
        cron(
            cadence: draft.cadence,
            hour: draft.hour,
            minute: draft.minute,
            weekday: draft.weekday,
            monthday: draft.monthday
        )
    }

    /// 0 = Sunday, matching the server and the web's `WEEKDAY_LABELS`.
    static func weekdayName(_ index: Int) -> String {
        let symbols = Calendar(identifier: .gregorian).standaloneWeekdaySymbols
        guard symbols.indices.contains(index) else { return symbols.first ?? "" }
        return symbols[index]
    }

    private static func words(
        cadence: NativeTaskCadence,
        hour: Int,
        minute: Int,
        weekday: Int?,
        monthday: Int?,
        timezone: String
    ) -> String {
        let time = String(format: "%02d:%02d", hour, minute)
        let sentence: String
        switch cadence {
        case .daily:
            sentence = "Every day at \(time)"
        case .weekdays:
            sentence = "Every weekday at \(time)"
        case .weekly:
            sentence = "Every \(weekdayName(weekday ?? 1)) at \(time)"
        case .monthly:
            sentence = "On the \(NativeScheduledTask.ordinal(monthday ?? 1)) of every month at \(time)"
        }
        return "\(sentence), \(timezone) time."
    }

    /// `minute hour day-of-month month day-of-week` — the same schedule the
    /// worker walks, written the way an engineer reads it. Not sent anywhere:
    /// the server stores the cadence fields, not an expression.
    private static func cron(
        cadence: NativeTaskCadence,
        hour: Int,
        minute: Int,
        weekday: Int?,
        monthday: Int?
    ) -> String {
        switch cadence {
        case .daily:
            return "\(minute) \(hour) * * *"
        case .weekdays:
            return "\(minute) \(hour) * * 1-5"
        case .weekly:
            return "\(minute) \(hour) * * \(weekday ?? 1)"
        case .monthly:
            return "\(minute) \(hour) \(monthday ?? 1) * *"
        }
    }
}

// MARK: - Run status

/// Where a task stands, in one line — the web's `StatusLine`, which merges
/// *when* the last run happened with *how it went* because they are one fact.
///
/// The server's own status vocabulary drives this, so a status it adds shows up
/// as itself rather than being flattened into a tick.
private struct TaskStatusLine {
    let text: String
    let symbol: String
    let tint: Color
    /// The full sentence, for the cell's tooltip, since the column truncates.
    let help: String
}

private extension NativeScheduledTask {
    var statusLine: TaskStatusLine {
        if let run = latestRun, run.isRunning {
            // Muted, not coral. The web's `StatusLine` sets every state but a
            // failure in `text-muted-foreground`, running included
            // (`task-card.tsx:38-40`) — the ellipsis is what says it is live.
            // Colouring it accent made a running task read as the page's primary
            // action rather than as a fact about a row.
            return TaskStatusLine(
                text: "Running now…",
                symbol: "circle.dotted",
                tint: .junoMutedForeground,
                help: "A run started \(run.startedAt.formatted(date: .abbreviated, time: .shortened))."
            )
        }
        guard enabled else {
            return TaskStatusLine(
                text: "Paused",
                symbol: "pause.circle",
                tint: .junoMutedForeground,
                help: "Paused — this task will not run."
            )
        }
        guard let run = latestRun else {
            let first = nextRunAt.formatted(
                .dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()
            )
            return TaskStatusLine(
                text: "First run \(first)",
                symbol: "clock",
                tint: .junoMutedForeground,
                help: "This task has not run yet."
            )
        }
        let when = (run.finishedAt ?? run.startedAt).formatted(.relative(presentation: .named))
        let exactly = (run.finishedAt ?? run.startedAt)
            .formatted(date: .abbreviated, time: .shortened)
        switch run.status {
        case "done":
            // Muted, not green. The web colours only failures; a column of ticks
            // is the decoration that made this page read as a dashboard rather
            // than a schedule.
            let cost = run.costMicroUSD > 0
                ? " · \(NativeScheduledTask.costText(run.costMicroUSD))" : ""
            return TaskStatusLine(
                text: "Ran \(when)\(cost)",
                symbol: "checkmark.circle",
                tint: .junoMutedForeground,
                help: "Completed \(exactly)."
            )
        case "error":
            let reason = run.errorDescription.map { " — \($0)" } ?? ""
            return TaskStatusLine(
                text: "Failed \(when)\(reason)",
                symbol: "exclamationmark.triangle.fill",
                tint: .junoDanger,
                help: run.errorDescription ?? "Failed \(exactly)."
            )
        case "budget":
            // Caution rather than danger: a budget skip is the account's ceiling
            // doing its job, not the task breaking. The web has one destructive
            // colour to spend; Juno's ramp has a step between.
            let reason = run.errorDescription.map { " — \($0)" } ?? ""
            return TaskStatusLine(
                text: "Skipped \(when)\(reason)",
                symbol: "exclamationmark.circle",
                tint: .junoCaution,
                help: run.errorDescription ?? "Skipped \(exactly)."
            )
        default:
            let reason = run.errorDescription.map { " — \($0)" } ?? ""
            return TaskStatusLine(
                text: "\(run.status) \(when)\(reason)",
                symbol: "questionmark.circle",
                tint: .junoMutedForeground,
                help: run.errorDescription ?? "\(run.status) \(exactly)."
            )
        }
    }

    /// `Optional` is not `Comparable`, so the never-run tasks sort as oldest.
    var lastRunSortKey: Date { lastRunAt ?? .distantPast }

    /// Sorting on the switch column: running tasks first, the way the web lists
    /// the live ones at the top of a plan's allowance.
    var enabledRank: Int { enabled ? 0 : 1 }

    /// The run cost, in the currency the server bills in.
    static func costText(_ microUSD: Int) -> String {
        (Decimal(microUSD) / 1_000_000).formatted(.currency(code: "USD"))
    }
}
