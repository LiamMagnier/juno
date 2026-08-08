import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// The Juno Work window: a source list of tasks, and the thread of one of them.
///
/// The same shell Chat and Code use — a `NavigationSplitView` whose sidebar is
/// `.junoSidebarColumn()` and whose detail is `.junoReadingCanvas()` plus
/// `.navigationTitle`, `.toolbar` and `.searchable` — so Work reads as the third
/// face of one application rather than a third application.
///
/// Four constraints are honoured deliberately, each of them a documented failure
/// in this window rather than a preference:
///
/// 1. **Exactly one `NavigationSplitView` is alive at a time.**
///    ``JunoDesktopWorkspaceView`` instantiates one product and veils the swap;
///    two live split views negotiating against one window is the crash in
///    `docs/native/MACOS_CRASH_ROOT_CAUSE.md`.
/// 2. **The detail column reports no ideal height.** Everything goes through
///    ``JunoDetailPage``. A thread is the longest surface in the app and a page
///    that propagates its content height resizes the window's AppKit split view
///    and pushes the sidebar off-screen.
/// 3. **Every `ToolbarItem` is present in every state and disables rather than
///    vanishing.** A toolbar rebuilt under a live window is what drove the
///    split-view constraint loop, and a run's controls are precisely the items
///    that would otherwise come and go as it starts and stops.
/// 4. **There is no `.inspector` here.** The thread carries the plan, the files,
///    the artifacts and the budget inline, because they are the reading, not
///    reference material beside it. If one is ever added it goes on the
///    `NavigationSplitView` and never on the detail column.
struct DesktopWorkWorkspace: View {
    let model: NativeWorkModel
    /// This Mac's own hosting switches. Present so the column can say why a task
    /// aimed here would not run — the answer is a setting on this machine, and
    /// the window that shows the task is where somebody discovers the question.
    var hostModel: DesktopWorkHostModel?
    /// The window's dependencies, for the account block at the bottom of the
    /// column. Work is the only product that did not pin one; see
    /// ``leaveForChat(_:)``.
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    @Binding var product: DesktopProductMode
    /// Starts an ordinary Juno conversation. A task is not a chat: a chat with
    /// nobody to run it is still a chat, so the way back to one crosses the
    /// product boundary rather than composing an empty task.
    let newChat: () -> Void

    @SceneStorage("juno.desktop.work.selection") private var storedSessionID = ""
    @SceneStorage("juno.desktop.work.columns") private var storedColumnVisibility = ""
    @SceneStorage("juno.desktop.work.filter") private var storedFilter = DesktopWorkFilter.all.rawValue
    /// Chat's destination, which this window writes and never reads.
    ///
    /// The one thing Work's column can do that its window cannot serve is open
    /// Design. Chat and Code render that page in their own detail column, but
    /// this workspace is handed a Work transport and nothing else — no artifact
    /// store to list designs from, no request sender to start one with — so the
    /// footer row has to cross the product boundary, exactly as New Task's
    /// sibling ``newChat`` already does. The scene keeps one value per key, and
    /// ``DesktopChatWorkspace`` reads this same key on the way in, so setting it
    /// before the swap is what decides where Chat lands.
    ///
    /// This is also what the website does. `/design` is not a code route, so
    /// opening it from anywhere puts the shell back on Home — leaving the
    /// product you were in is the behaviour, not a compromise around it.
    @SceneStorage("juno.desktop.destination") private var storedDestination =
        DesktopDestination.chat.rawValue

    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var isComposing = false
    @State private var query = ""
    @State private var filter = DesktopWorkFilter.all
    /// The reply being typed to a question the run asked. Held here rather than
    /// in the thread view so switching tasks and coming back cannot resurrect a
    /// half-typed answer against a different question.
    @State private var answerDraft = ""
    /// The instruction being typed to a run that asked nothing. Held beside the
    /// answer, and separate from it, because the two are different requests to
    /// different preconditions: a run that starts asking a question mid-sentence
    /// swaps which box is on screen, and one shared string would carry half an
    /// instruction into the answer field and send it as the reply.
    @State private var instructionDraft = ""
    @FocusState private var searchFocused: Bool

    // MARK: - Selection

    /// Restored from scene storage rather than `@State`, so reopening a window
    /// returns the reader to the task they were reading.
    private var selection: Binding<String?> {
        Binding(
            get: { storedSessionID.isEmpty ? nil : storedSessionID },
            set: { storedSessionID = $0 ?? "" }
        )
    }

    private var selectedSession: WorkSessionSummary? {
        guard let id = selection.wrappedValue else { return nil }
        return model.sessions.first { $0.sessionID == id }
    }

    /// The task the thread is showing.
    ///
    /// The model's copy wins **only when it is the same task**. It is the fresher
    /// of the two — the stream writes it, while the list copy is whatever the
    /// thirty-second poll last saw — so preferring it is what stops the thread
    /// rendering a status that is half a minute stale. Requiring the identifiers
    /// to match is what stops the other failure: selecting a second task shows
    /// the first one's goal and plan for the frame between the selection landing
    /// and `followSelection` re-pointing the stream.
    private var openSession: WorkSessionSummary? {
        guard let selected = selectedSession else { return model.openSession }
        guard let open = model.openSession, open.sessionID == selected.sessionID else {
            return selected
        }
        return open
    }

    /// The tasks the column lists, filtered by the search field.
    ///
    /// Goal as well as title, because a task's title is generated from its goal
    /// and is often the part the reader does not remember writing.
    private var visibleSessions: [WorkSessionSummary] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let listed = model.sessions.filter { !$0.archived }
        guard !trimmed.isEmpty else { return listed }
        return listed.filter {
            $0.title.localizedCaseInsensitiveContains(trimmed)
                || $0.goal.localizedCaseInsensitiveContains(trimmed)
        }
    }

    private var windowTitle: String {
        openSession?.title ?? "Juno Work"
    }

    // MARK: - Body

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            DesktopWorkSidebar(
                model: model,
                hostModel: hostModel,
                configuration: configuration,
                session: session,
                sessions: visibleSessions,
                selection: selection,
                filter: $filter,
                product: $product,
                compose: { isComposing = true },
                openDesign: openDesign,
                openSettings: { leaveForChat(.settings) },
                openUsage: { leaveForChat(.usage) }
            )
            .junoSidebarColumn()
        } detail: {
            detail
                .junoReadingCanvas()
                .navigationTitle(windowTitle)
                .toolbar { detailToolbar }
                // On the detail column, never on the split view or the sidebar:
                // attached to either of those, macOS gives the search field the
                // leading column's titlebar safe area and the source list's
                // first rows draw behind the toolbar and under the traffic
                // lights. Code hit exactly this and fixed it the same way.
                .searchable(text: $query, placement: .toolbar, prompt: "Search tasks")
                .searchFocused($searchFocused)
        }
        .focusedSceneValue(\.junoWorkspaceActions, workspaceActions)
        .sheet(isPresented: $isComposing) {
            DesktopWorkComposer(model: model) { session in
                selection.wrappedValue = session.sessionID
            }
        }
        .task { await model.refresh() }
        // Following one task at a time is the model's contract: opening a second
        // closes the first one's stream. Driving it from the selection rather
        // than from the row's tap handler means a selection restored from scene
        // storage is followed too, instead of showing a thread that never
        // updates.
        .task(id: selection.wrappedValue) { followSelection() }
        // The model opens the task it has just created, and the column has to
        // agree with it — otherwise starting a task from the composer leaves the
        // thread showing the new run and the source list highlighting the old
        // one.
        .onChange(of: model.openSession?.sessionID) { _, sessionID in
            guard let sessionID else { return }
            selection.wrappedValue = sessionID
        }
        // A question belongs to the task that asked it, and so does an
        // instruction. Clearing both on every change of task is what stops
        // words typed for one run being sent to another.
        .onChange(of: selection.wrappedValue) { _, _ in
            answerDraft = ""
            instructionDraft = ""
        }
        // Deleting or archiving the selected task leaves the window pointing at
        // nothing. Without this the title stays on a task that no longer exists,
        // which reads as a failure rather than as "that task is gone".
        .onChange(of: model.sessions.count) { _, _ in
            guard let id = selection.wrappedValue,
                !model.sessions.contains(where: { $0.sessionID == id })
            else { return }
            selection.wrappedValue = nil
        }
        .onAppear {
            filter = DesktopWorkFilter(rawValue: storedFilter) ?? .all
            if storedColumnVisibility == "detailOnly" {
                columnVisibility = .detailOnly
            }
        }
        .onChange(of: filter) { _, newFilter in
            storedFilter = newFilter.rawValue
            guard let selected = selection.wrappedValue,
                let selectedSession = model.sessions.first(where: { $0.sessionID == selected }),
                !newFilter.includes(selectedSession, model: model)
            else { return }
            // A filter is a view, not a styling hint. Clear a selection that no
            // longer belongs to it so the reader cannot keep showing a task that
            // has disappeared from the source list.
            selection.wrappedValue = nil
        }
        .onChange(of: columnVisibility) { _, visibility in
            storedColumnVisibility = visibility == .detailOnly ? "detailOnly" : "all"
        }
        // Leaving Work has to take the stream with it.
        //
        // Switching product tears this view down — one workspace is alive at a
        // time — but the model is app-level and outlives it, so without this the
        // SSE connection for a thread nobody is looking at stays open for the
        // rest of the session. The poll continues either way, which is what
        // keeps the attention count honest while Work is closed.
        .onDisappear { model.closeOpenSession() }
    }

    // MARK: - Leaving for Design

    /// Open Juno Design, which lives in Chat's window.
    ///
    /// The destination is written *before* the product changes, so the Chat
    /// workspace this swap builds reads "design" on its first evaluation rather
    /// than opening on whatever it was last showing and then jumping. See
    /// ``storedDestination``.
    private func openDesign() {
        leaveForChat(.design)
    }

    /// Open Settings or Usage, which are Chat destinations.
    ///
    /// Work's column had neither, and no toolbar item for them either — so a
    /// reader sitting in Work who wanted to change anything about Work had to
    /// switch product, find Settings in Chat's column, and go looking. Chat and
    /// Code both pin the account block; the three products are meant to read as
    /// three faces of one application, and the window's furniture moving when
    /// you switch tabs is the clearest way to say they are not.
    private func leaveForChat(_ destination: DesktopDestination) {
        storedDestination = destination.rawValue
        product = .chat
    }

    // MARK: - Detail column

    @ViewBuilder
    private var detail: some View {
        if let session = openSession {
            DesktopWorkThread(
                model: model,
                hostModel: hostModel,
                session: session,
                answerDraft: $answerDraft,
                instructionDraft: $instructionDraft
            )
        } else if model.phase == .loading {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let hostModel, let blocker = hostModel.blocker, model.sessions.isEmpty {
            // Before "No tasks yet", and only while there are none. Somebody
            // opening Juno Work on a Mac that cannot serve it has two things to
            // learn, and they are not equally urgent: a task started here would
            // go nowhere, and there are no tasks yet. Offering "New Task" first
            // is offering the second answer to the first question.
            //
            // Once tasks exist the panel steps aside for them — a Mac that hosts
            // nothing still runs work in the cloud, and a setup screen in front
            // of a list of real tasks would be a wall between somebody and the
            // thing they came back for. The sidebar keeps saying so quietly.
            DesktopWorkStartPath(host: hostModel, blocker: blocker, compose: { isComposing = true })
        } else if model.sessions.isEmpty {
            JunoEmptyState(
                title: "No tasks yet",
                message: "A task is something you hand to Juno to go and do — sort a folder, "
                    + "pull a report together, work through an inbox. It runs on this Mac or in "
                    + "the cloud and tells you here what it did.",
                symbol: "checklist",
                actionLabel: "New Task",
                action: { isComposing = true }
            )
        } else {
            DesktopWorkOverview(
                model: model,
                sessions: visibleSessions.filter { filter.includes($0, model: model) },
                filter: filter,
                selection: selection,
                hostModel: hostModel,
                compose: { isComposing = true }
            )
        }
    }

    // MARK: - Toolbar

    /// A fixed set. Every item is present in every state and disables rather
    /// than vanishing — a rebuilt AppKit toolbar is the documented crash surface
    /// in this window, and a control that keeps its position is one the pointer
    /// does not have to re-find between a run starting and finishing.
    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        // The product switch is deliberately absent. It now sits at the top of
        // the navigation column, on the column it switches, in every product —
        // see ``DesktopSidebarProductHeader``. Chat and Code moved together and
        // this window has to move with them, because the one property that
        // control must have is that it does not travel across the window when
        // the product does.

        ToolbarItem(placement: .primaryAction) {
            Button {
                isComposing = true
            } label: {
                Label("New task", systemImage: "square.and.pencil")
            }
            .help("Describe something for Juno to go and do (⌘N)")
            .accessibilityIdentifier("juno.work.new-task")
        }

        ToolbarItem(placement: .status) {
            statusIndicator
        }

        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button {
                    Task { await model.pauseOpenRun() }
                } label: {
                    Label("Pause", systemImage: "pause")
                }
                .disabled(!canPause)
                .accessibilityIdentifier("juno.work.pause")

                Button {
                    Task { await model.resumeOpenRun() }
                } label: {
                    Label("Resume", systemImage: "play")
                }
                .disabled(!canResume)
                .accessibilityIdentifier("juno.work.resume")

                Button(role: .destructive) {
                    Task { await model.stopOpenRun() }
                } label: {
                    Label("Stop", systemImage: "stop")
                }
                .disabled(!canStop)
                .accessibilityIdentifier("juno.work.stop")

                Divider()

                // Named for what it does, not for what "retry" usually means.
                // This composes a second task with the same goal rather than a
                // second attempt at this one — see `retryOpenSession` — and a
                // menu item labelled "Try Again" would leave the reader looking
                // for their original task's second run.
                Button(action: retryOpenSession) {
                    Label("Try Again as a New Task", systemImage: "arrow.clockwise")
                }
                .disabled(!canRetry)
                .accessibilityIdentifier("juno.work.retry")

                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh Tasks", systemImage: "arrow.triangle.2.circlepath")
                }
                .keyboardShortcut("r", modifiers: .command)
                .accessibilityIdentifier("juno.work.refresh")
            } label: {
                Label("Task", systemImage: "ellipsis.circle")
            }
            .disabled(model.isMutating)
            .accessibilityIdentifier("juno.work.task-menu")
        }
    }

    /// What the open task is doing, in the titlebar.
    ///
    /// Present with a neutral reading when nothing is open, rather than absent:
    /// see the note on ``detailToolbar`` for why nothing here may come and go.
    ///
    /// **`.titleAndIcon` is required, not cosmetic.** A bare `Label` in a
    /// toolbar collapses to its glyph, and `.status` placement centres it — so
    /// this rendered as a lone unlabelled shield floating in the middle of the
    /// titlebar, touching nothing, meaning nothing to anyone who had not read
    /// this file. With the title shown it becomes what it was written to be: the
    /// answer to "what is this task doing" while the thread is scrolled past its
    /// own header.
    @ViewBuilder
    private var statusIndicator: some View {
        if let session = openSession {
            let style = DesktopWorkStatusStyle.of(model.displayStatus(of: session))
            Label(style.label, systemImage: style.symbol)
                .labelStyle(.titleAndIcon)
                .font(.system(.caption, design: .default, weight: .medium))
                .foregroundStyle(style.tint)
                .help(style.sentence)
                .accessibilityLabel(style.sentence)
        } else {
            Label("No task open", systemImage: "checklist")
                .labelStyle(.titleAndIcon)
                .font(.system(.caption, design: .default, weight: .medium))
                .junoSecondaryInk()
        }
    }

    // MARK: - Run controls

    private var openStatus: JunoWorkStatus? {
        openSession.map { model.displayStatus(of: $0) }
    }

    /// Whether the model's control verbs would act on the task this window is
    /// showing.
    ///
    /// `pauseOpenRun` and its siblings address the model's *open* run, and for
    /// the frame between a selection landing and `followSelection` re-pointing
    /// the stream that is still the previous task. A Stop enabled in that window
    /// stops the wrong run.
    private var isFollowing: Bool {
        guard let shown = openSession else { return false }
        return model.openSession?.sessionID == shown.sessionID
    }

    private var canPause: Bool {
        guard isFollowing, let status = openStatus else { return false }
        return !status.isTerminal && status != .paused && status != .draft
    }

    private var canResume: Bool { isFollowing && openStatus == .paused }

    private var canStop: Bool {
        guard isFollowing, let status = openStatus else { return false }
        return !status.isTerminal && status != .draft
    }

    /// Another attempt is offered only once this one is over.
    ///
    /// Anything else would mean two runs of the same goal in flight against the
    /// same folders at the same time.
    private var canRetry: Bool {
        openStatus?.isTerminal == true
    }

    /// Dispatches the same goal again.
    ///
    /// This composes a **new task** rather than a second attempt at the existing
    /// one, and the button says so, because that is the only retry the client
    /// can honestly perform: ``NativeWorkModel`` exposes `startTask` and the
    /// three control verbs, and nothing that starts another run against a
    /// session that already has one. The requested target and preferred Mac are
    /// carried over so "try again" does not silently move the work to the cloud
    /// after a Mac came back.
    private func retryOpenSession() {
        guard let session = openSession else { return }
        Task {
            await model.startTask(
                goal: session.goal,
                title: session.title,
                target: JunoWorkTarget(rawValue: session.requestedTarget) ?? .automatic,
                preferredHostID: session.hostID
            )
        }
    }

    private func followSelection() {
        guard let session = selectedSession else {
            model.closeOpenSession()
            return
        }
        model.open(session)
    }

    private var workspaceActions: DesktopWorkspaceActions {
        DesktopWorkspaceActions(
            newItem: { isComposing = true },
            newChat: newChat,
            openSearch: {
                columnVisibility = .all
                searchFocused = true
            },
            switchProduct: { product = $0 },
            currentProduct: product
        )
    }
}

// MARK: - Sidebar

/// The four questions the Work source list should answer before a task is
/// selected. A status badge on every row is not a navigation model; these views
/// give the reader a useful place to start and make the attention queue a real
/// workflow instead of a coloured heading.
enum DesktopWorkFilter: String, CaseIterable, Identifiable, Sendable {
    case attention
    case active
    case all
    case completed

    var id: Self { self }

    var title: String {
        switch self {
        case .attention: "Needs you"
        case .active: "In progress"
        case .all: "All tasks"
        case .completed: "Completed"
        }
    }

    var symbol: String {
        switch self {
        case .attention: "bell.badge"
        case .active: "bolt.horizontal.circle"
        case .all: "tray.full"
        case .completed: "checkmark.circle"
        }
    }

    var emptyMessage: String {
        switch self {
        case .attention: "Nothing is waiting on you."
        case .active: "No tasks are running right now."
        case .all: "Start a task to see it here."
        case .completed: "Finished tasks will stay here for reference."
        }
    }

    @MainActor
    func includes(_ session: WorkSessionSummary?, model: NativeWorkModel) -> Bool {
        guard let session else { return false }
        let status = model.displayStatus(of: session)
        switch self {
        case .attention:
            return session.needsAttention || status.needsAttention
        case .active:
            return !status.isTerminal
                && status != .draft
                && !session.needsAttention
                && !status.needsAttention
        case .all:
            return true
        case .completed:
            return status.isTerminal
        }
    }

    @MainActor
    func count(in sessions: [WorkSessionSummary], model: NativeWorkModel) -> Int {
        sessions.filter { includes($0, model: model) }.count
    }
}

/// The task list, and one line about this Mac underneath it.
///
/// Two sections, and the split is the point: a task that has stopped to ask
/// something is not "in progress with an asterisk", it is the only kind of task
/// whose next move is the reader's. Everything else is one recency-ordered list,
/// because a task's status already reads on its own row and grouping by status
/// as well would scatter one afternoon's work across four headings.
private struct DesktopWorkSidebar: View {
    let model: NativeWorkModel
    let hostModel: DesktopWorkHostModel?
    let configuration: JunoDesktopConfiguration
    let session: NativeAuthenticatedSession
    let sessions: [WorkSessionSummary]
    @Binding var selection: String?
    @Binding var filter: DesktopWorkFilter
    /// Which half of the app the window is showing, so the switch at the top of
    /// this column can move it. Read by nothing else here — it exists to give
    /// the header something to write through, exactly as Chat's and Code's do.
    @Binding var product: DesktopProductMode
    let compose: () -> Void
    /// Opens Juno Design. It is not a page this window can draw — see
    /// ``DesktopWorkWorkspace/openDesign()`` — so the column asks for it rather
    /// than navigating to it.
    let openDesign: () -> Void
    /// Settings and Usage, for the same reason: both are Chat destinations and
    /// this window has no route to them of its own.
    let openSettings: () -> Void
    let openUsage: () -> Void

    private var rest: [WorkSessionSummary] {
        sessions
            .filter { filter.includes($0, model: model) }
            .sorted { lhs, rhs in
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                return lhs.lastActivityAt > rhs.lastActivityAt
            }
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                Button(action: compose) {
                    Label("New task", systemImage: "plus")
                        .font(.system(.body, design: .default, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.work.sidebar.new-task")
            }

            Section("Views") {
                ForEach(DesktopWorkFilter.allCases) { view in
                    filterRow(view)
                }
            }

            Section {
                if rest.isEmpty {
                    Text(filter.emptyMessage)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(rest) { row($0) }
                }
            } header: {
                Text(filter.title)
            }
        }
        .listStyle(.sidebar)
        .junoSidebarSelectionTint()
        // The strip at the top of the column, which is the product switch and
        // not merely the space one would need. Laid out above the list rather
        // than inset into it, so "Waiting on you" — which a `.sidebar` List pins
        // to the top of its own bounds, where no inset reaches it — pins below
        // the strip instead of over the traffic lights.
        .junoSidebarProductHeader(product: $product)
        // `safeAreaBar`, not `safeAreaInset` with `.background(.bar)`.
        //
        // Work was the last column in the window still painting an opaque lid
        // over a vibrant source list — a grey slab on translucency, visible as a
        // hard-edged bar under the last row, which is the exact defect
        // `JunoDesktopChrome.junoSidebarScrollEdge()` was written to retire and
        // which Chat and Code were both migrated off. Switching products changed
        // the material at the bottom of the same column.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                footer
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DesktopSidebarDesignRow(open: openDesign)
                // The account block Work never had. Chat and Code both pin this
                // exact component, which is what stops the three columns
                // describing one account — or one waiting update — three ways.
                DesktopSidebarFooter(
                    session: session,
                    avatarModel: configuration.avatarModel,
                    syncModel: configuration.syncModel,
                    plan: nil,
                    openUsage: openUsage,
                    openSettings: openSettings
                )
            }
        }
        .junoSidebarScrollEdge()
        .accessibilityIdentifier("juno.work.sidebar")
    }

    private func filterRow(_ view: DesktopWorkFilter) -> some View {
        let count = view.count(in: sessions, model: model)
        return Button {
            filter = view
            if let selected = selection,
                let session = sessions.first(where: { $0.sessionID == selected }),
                !view.includes(session, model: model)
            {
                selection = nil
            }
        } label: {
            HStack(spacing: JunoSpace.cozy) {
                Image(systemName: view.symbol)
                    .junoSidebarMarkInk(selected: filter == view)
                    .frame(width: 18)
                Text(view.title)
                    .junoRowLabel()
                Spacer(minLength: JunoSpace.snug)
                if count > 0 {
                    Text(count.formatted())
                        .font(.system(.caption, design: .default, weight: .medium))
                        .monospacedDigit()
                        .junoMetaInk()
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.work.filter.\(view.rawValue)")
        .accessibilityValue(filter == view ? "Selected" : "")
    }

    /// One task in the source list.
    ///
    /// **Colour is spent on attention, and on nothing else.** Every row used to
    /// tint its glyph with the status colour, so a column of ten tasks was a
    /// column of coral, amber, green and red marks — a rainbow rather than a
    /// signal, and directly against `JunoDesktopChrome`'s rule that the rail is
    /// greyscale ("The web's rail is greyscale: the mark rests on
    /// `--sidebar-foreground` and lifts to `--foreground` with its label"). The
    /// mark is now the column's own ink like Chat's and Code's, and the only
    /// rows that carry colour are the ones asking for something: the section is
    /// already called "Waiting on you", and now it looks like it.
    ///
    /// The status word stays in the subtitle, where it was already, because that
    /// is where the answer is when somebody actually wants it.
    private func row(_ session: WorkSessionSummary) -> some View {
        let style = DesktopWorkStatusStyle.of(model.displayStatus(of: session))
        let wantsYou = session.needsAttention
        return Label {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title)
                    .junoRowLabel()
                    .fontWeight(wantsYou ? .medium : .regular)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(
                    "\(style.label) · \(session.lastActivityAt.formatted(.relative(presentation: .named)))"
                )
                .junoCaption()
                .lineLimit(1)
            }
        } icon: {
            Image(systemName: style.symbol)
                .junoSidebarMarkInk()
                // The one exception to the greyscale rail, and the reason the
                // rail is greyscale: a mark that means "this has stopped and is
                // waiting for you" can only read as urgent if its neighbours are
                // not also coloured.
                .foregroundStyle(wantsYou ? style.tint : Color.junoSidebarForeground)
        }
        .junoSidebarRowInk()
        .tag(session.sessionID)
        .contextMenu {
            Button(session.pinned ? "Unpin" : "Pin") {
                Task { await model.setPinned(!session.pinned, on: session) }
            }
            Button("Archive") {
                Task { await model.setArchived(true, on: session) }
            }
            Divider()
            Button("Delete", role: .destructive) {
                Task { await model.delete(session) }
            }
        }
        .accessibilityLabel("\(session.title). \(style.sentence)")
    }

    /// One line about this Mac, the way to answer it, and the way to start
    /// something.
    ///
    /// The host's own sentence is printed verbatim when it has one, and the
    /// control that clears it sits underneath. A task dispatched to a Mac that
    /// will not serve it sits queued and looks like a slow start, and the
    /// sentence explaining that is a setting on this machine — so the column that
    /// lists the tasks is where it has to appear, *and* where the fix has to be
    /// reachable. Printing the sentence alone is what left somebody reading
    /// "Juno Work is switched off on this Mac." with nowhere to go.
    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let hostModel {
                DesktopWorkBlockerRow(host: hostModel)
            }

            if let error = model.lastErrorDescription {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }
}

// MARK: - Work overview

/// The landing page when no task is selected.
///
/// A source list with a blank reader is technically navigable but gives Work no
/// centre of gravity. This page answers three things immediately: what needs a
/// decision, what is still running, and how to start the next piece of work.
/// The rows are the same rows as the sidebar, so the overview is a useful
/// launchpad rather than a second, stale representation of the task list.
private struct DesktopWorkOverview: View {
    let model: NativeWorkModel
    let sessions: [WorkSessionSummary]
    let filter: DesktopWorkFilter
    @Binding var selection: String?
    let hostModel: DesktopWorkHostModel?
    let compose: () -> Void

    private var allSessions: [WorkSessionSummary] {
        // The source list has already applied both the current view and the
        // search query. The reader must use that same set, otherwise searching
        // for one task leaves the overview quietly showing unrelated work.
        sessions
    }

    private var attention: [WorkSessionSummary] {
        allSessions
            .filter { DesktopWorkFilter.attention.includes($0, model: model) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    private var active: [WorkSessionSummary] {
        allSessions
            .filter { DesktopWorkFilter.active.includes($0, model: model) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    private var completed: [WorkSessionSummary] {
        allSessions
            .filter { DesktopWorkFilter.completed.includes($0, model: model) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    private var primaryTasks: [WorkSessionSummary] {
        switch filter {
        case .attention: attention
        case .active: active
        case .completed: completed
        case .all: []
        }
    }

    private var headingTitle: String {
        switch filter {
        case .attention: "Needs your attention"
        case .active: "In progress"
        case .completed: "Completed work"
        case .all: "Your work"
        }
    }

    private var headingSubtitle: String {
        switch filter {
        case .attention: "Decisions and answers that will let Juno continue."
        case .active: "Tasks Juno is carrying out in the background."
        case .completed: "A record of what Juno has already finished or stopped."
        case .all: "Tasks Juno can carry out while you focus on something else."
        }
    }

    private var primarySubtitle: String {
        switch filter {
        case .attention: "These tasks need your next decision."
        case .active: "Juno will keep working while you do something else."
        case .completed: "Open a task to review its result and activity."
        case .all: ""
        }
    }

    var body: some View {
        if sessions.isEmpty, !model.sessions.isEmpty {
            JunoEmptyState(
                title: "No matching tasks",
                message: "Try a different search, or start a new task.",
                symbol: "magnifyingglass",
                actionLabel: "New Task",
                action: compose
            )
        } else {
            JunoDetailPage(maxWidth: 920) {
                VStack(alignment: .leading, spacing: JunoSpace.section) {
                    heading
                    metrics

                    if filter == .all, !attention.isEmpty {
                        DesktopWorkOverviewSection(
                            title: "Needs your attention",
                            subtitle: "These tasks cannot continue without you."
                        ) {
                            ForEach(attention.prefix(4)) { task in
                                taskRow(task)
                            }
                        }
                    }

                    if filter == .all, !active.isEmpty {
                        DesktopWorkOverviewSection(
                            title: "In progress",
                            subtitle: "Juno is handling these in the background."
                        ) {
                            ForEach(active.prefix(4)) { task in
                                taskRow(task)
                            }
                        }
                    }

                    if filter != .all, !primaryTasks.isEmpty {
                        DesktopWorkOverviewSection(
                            title: filter.title,
                            subtitle: primarySubtitle
                        ) {
                            ForEach(primaryTasks.prefix(8)) { task in
                                taskRow(task)
                            }
                        }
                    }

                    if let hostModel {
                        DesktopWorkOverviewSection(
                            title: "This Mac",
                            subtitle: "Local work uses the permissions you choose in Settings."
                        ) {
                            DesktopWorkBlockerRow(
                                host: hostModel,
                                confirmsReady: true,
                                identifier: "juno.work.overview.host"
                            )
                        }
                    }

                    startSection
                }
            }
        }
    }

    private var heading: some View {
        HStack(alignment: .bottom, spacing: JunoSpace.roomy) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text(headingTitle)
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                Text(headingSubtitle)
                    .junoBody()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: JunoSpace.regular)
            Button(action: compose) {
                Label("New task", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.junoAccent)
            .accessibilityIdentifier("juno.work.overview.new-task")
        }
    }

    private var metrics: some View {
        HStack(spacing: 0) {
            metric(
                value: DesktopWorkFilter.attention.count(in: allSessions, model: model),
                label: "Need you",
                symbol: DesktopWorkFilter.attention.symbol,
                tint: Color.junoCaution
            )
            Divider().frame(height: 34)
            metric(
                value: DesktopWorkFilter.active.count(in: allSessions, model: model),
                label: "In progress",
                symbol: DesktopWorkFilter.active.symbol,
                tint: Color.junoAccent
            )
            Divider().frame(height: 34)
            metric(
                value: DesktopWorkFilter.completed.count(in: allSessions, model: model),
                label: "Completed",
                symbol: DesktopWorkFilter.completed.symbol,
                tint: Color.junoSuccess
            )
        }
        .padding(.horizontal, JunoSpace.roomy)
        .padding(.vertical, JunoSpace.regular)
        .junoCard()
        .accessibilityIdentifier("juno.work.overview.metrics")
    }

    private func metric(value: Int, label: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: JunoSpace.snug) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(value.formatted())
                    .font(.system(.title3, design: .default, weight: .semibold))
                    .monospacedDigit()
                Text(label)
                    .junoCaption()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var startSection: some View {
        DesktopWorkOverviewSection(
            title: "Start something",
            subtitle: "Describe the outcome. Juno will make the plan and ask before sensitive actions."
        ) {
            Button(action: compose) {
                HStack(spacing: JunoSpace.cozy) {
                    Image(systemName: "square.and.pencil")
                        .foregroundStyle(Color.junoAccent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Describe a task")
                            .junoRowLabel()
                        Text("Research, organise, compare, or prepare a deliverable.")
                            .junoCaption()
                    }
                    Spacer(minLength: JunoSpace.snug)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .junoMetaInk()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("juno.work.overview.start")
        }
    }

    private func taskRow(_ task: WorkSessionSummary) -> some View {
        let status = model.displayStatus(of: task)
        let style = DesktopWorkStatusStyle.of(status)
        return Button {
            selection = task.sessionID
        } label: {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                Image(systemName: style.symbol)
                    .foregroundStyle(style.tint)
                    .frame(width: 18, alignment: .center)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text(task.goal)
                        .junoCaption()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(
                        "\(style.label)  ·  "
                            + DesktopWorkVocabulary.target(
                                task.effectiveTarget ?? task.requestedTarget,
                                hostName: task.hostDisplayName
                            )
                            + "  ·  "
                            + task.lastActivityAt.formatted(.relative(presentation: .named))
                    )
                    .junoCaption()
                }
                Spacer(minLength: JunoSpace.snug)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .junoMetaInk()
                    .padding(.top, 3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.work.overview.task.\(task.sessionID)")
        .accessibilityLabel("\(task.title). \(style.sentence)")
    }
}

private struct DesktopWorkOverviewSection<Content: View>: View {
    let title: String
    let subtitle: String
    let content: Content

    init(title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .junoSidebarSection()
                Text(subtitle)
                    .junoCaption()
            }
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.snug)
            .junoCard()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - This Mac

/// The one sentence about this Mac, with the control that answers it.
///
/// Lives here rather than with the settings card because it belongs to the
/// window somebody is actually looking at when they discover the problem — but
/// the settings card draws the identical row, from the identical model, so the
/// two surfaces cannot come to describe one state in two vocabularies. That had
/// already started: settings printed the sentence under a caution mark and the
/// task column printed it under a different one.
///
/// When the host has nothing to report the row draws the ready line instead. A
/// row that vanishes on success is a row whose absence has to be interpreted,
/// and "did it work?" is exactly the question somebody has after pressing the
/// button above it.
struct DesktopWorkBlockerRow: View {
    let host: DesktopWorkHostModel
    /// Whether to draw the ready line when there is no blocker. The task column
    /// says nothing when all is well — its job is the list — while the settings
    /// card, which exists to be read, confirms it.
    var confirmsReady = false
    /// The accessibility namespace of the surface drawing this. Passed in rather
    /// than fixed, because the two callers live in namespaces that already exist
    /// and the identifiers under them are what a UI test addresses.
    var identifier = "juno.work.host"

    var body: some View {
        if let blocker = host.blocker {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Label {
                    Text(blocker.sentence)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } icon: {
                    // A spinner for what is settling by itself, a caution mark
                    // only for what is waiting on the reader. A Mac finishing
                    // pairing under a warning triangle sends somebody looking for
                    // a fault that will be gone before they find it.
                    if blocker.isSettling {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: blocker.symbol)
                            .foregroundStyle(Color.junoCaution)
                    }
                }

                if let title = blocker.actionTitle, host.canTake(blocker) {
                    Button(title) { host.take(blocker) }
                        .junoProminentGlassButton()
                        .accessibilityIdentifier("\(identifier)-action")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(JunoMotion.standard, value: blocker)
            .accessibilityIdentifier("\(identifier)-reason")
        } else if confirmsReady {
            Label {
                Text("A task sent to this Mac now would run here.")
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(Color.junoSuccess)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("\(identifier)-ready")
        }
    }
}

/// The path from "Juno Work is switched off on this Mac" to a Mac that serves.
///
/// Three rows, in the order they have to happen, all of them visible from the
/// first: hand over the machine, hand over something on it, and then the Mac is
/// ready. Showing the whole path rather than only the current step is the point.
/// The sentence on its own answered "why can nothing run here" and left "what
/// would it take" unanswered, and the honest answer to the second is two
/// decisions and no more — which is worth knowing *before* making the first one.
///
/// What it is not: a wizard. Nothing here advances on its own, nothing is
/// skippable-with-consequences, and the reader can close the window at any row
/// and have changed exactly what they pressed.
struct DesktopWorkStartPath: View {
    let host: DesktopWorkHostModel
    let blocker: DesktopWorkBlocker
    /// The way past this panel. A Mac that will not host work can still dispatch
    /// it to the cloud, so refusing to offer a new task here would be refusing
    /// the product to somebody who has simply decided not to lend their machine.
    let compose: () -> Void

    /// The reading width. The same measure the rest of the window's centred
    /// content uses; a card that grows with a 1600pt window is a card whose
    /// third line the eye cannot find its way back to.
    private static let measure: CGFloat = 460

    var body: some View {
        VStack(spacing: JunoSpace.roomy) {
            Spacer(minLength: JunoSpace.section)

            JunoDesktopGlass(spacing: JunoSpace.snug) {
                VStack(alignment: .leading, spacing: JunoSpace.roomy) {
                    heading
                    VStack(alignment: .leading, spacing: JunoSpace.regular) {
                        step(
                            1,
                            title: "Allow Juno Work on this Mac",
                            detail: DesktopWorkBlocker.switchedOff.actionDetail ?? "",
                            isDone: host.allowWorkOnThisMac,
                            blocker: .switchedOff
                        )
                        step(
                            2,
                            title: "Give it something to work with",
                            detail: DesktopWorkBlocker.nothingAllowed.actionDetail ?? "",
                            isDone: !host.policy.advertisedCapabilities.isEmpty,
                            blocker: .nothingAllowed
                        )
                        readyStep
                    }
                }
                .padding(JunoSpace.roomy)
                .frame(maxWidth: Self.measure, alignment: .leading)
                .junoGlass(
                    in: RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                )
            }

            Button("New Task", action: compose)
                .junoGlassButton()
                .accessibilityIdentifier("juno.work.start-path.new-task")

            Spacer(minLength: JunoSpace.section)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, JunoSpace.region)
        .animation(JunoMotion.standard, value: blocker)
        .accessibilityIdentifier("juno.work.start-path")
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Image(systemName: "laptopcomputer.and.arrow.down")
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(Color.junoAccent)
                .accessibilityHidden(true)
            Text("Set up Juno Work on this Mac")
                .junoEmptyTitle()
            Text(
                "Juno Work runs tasks in the cloud already. Two decisions let it run them "
                    + "here, where your files and your signed-in apps are."
            )
            .junoCaption()
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One consent: what it is, what it costs, and the button that gives it.
    ///
    /// The button is drawn only on the step that is actually next. Both consents
    /// on screen at once would let somebody grant a folder to a Mac that is not
    /// hosting anything — which succeeds, changes nothing they can see, and
    /// teaches them the panel is decorative.
    @ViewBuilder
    private func step(
        _ number: Int,
        title: String,
        detail: String,
        isDone: Bool,
        blocker stepBlocker: DesktopWorkBlocker
    ) -> some View {
        let isCurrent = self.blocker == stepBlocker
        HStack(alignment: .top, spacing: JunoSpace.cozy) {
            marker(number: number, isDone: isDone, isCurrent: isCurrent)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(title)
                    .junoRowLabel()
                    .foregroundStyle(isDone || isCurrent ? .primary : .secondary)
                Text(detail)
                    .junoCaption()
                    .fixedSize(horizontal: false, vertical: true)

                if isCurrent, let actionTitle = stepBlocker.actionTitle, host.canTake(stepBlocker) {
                    Button(actionTitle) { host.take(stepBlocker) }
                        .junoProminentGlassButton()
                        .padding(.top, JunoSpace.tight)
                        .accessibilityIdentifier(
                            "juno.work.start-path.step-\(number)-action"
                        )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The third row is the outcome, not a third thing to do.
    ///
    /// It carries whichever of the states nobody at this Mac can press their way
    /// out of — signed out, pairing, starting — so that a reader who has done
    /// both their parts is told what is now being waited on rather than left in
    /// front of two ticks and no result.
    private var readyStep: some View {
        let isReady = host.willServeDispatchedWork
        return HStack(alignment: .top, spacing: JunoSpace.cozy) {
            marker(number: 3, isDone: isReady, isCurrent: blocker.isSettling)
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(isReady ? "This Mac is serving Juno Work" : "This Mac starts serving")
                    .junoRowLabel()
                    .foregroundStyle(isReady ? .primary : .secondary)
                Text(
                    isReady
                        ? "A task sent here now runs on this Mac."
                        : blocker.isSettling || blocker == .signedOut
                            ? blocker.sentence
                            : "Once both are done, tasks sent here run on this Mac."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The step's own mark: done, in progress, or still ahead.
    ///
    /// A fixed 22pt square in every state. The three marks are different glyphs
    /// with different intrinsic widths, and letting them size themselves put the
    /// three titles at three different x positions — the ragged left edge this
    /// repo has a recorded incident about, one column over.
    @ViewBuilder
    private func marker(number: Int, isDone: Bool, isCurrent: Bool) -> some View {
        Group {
            if isDone {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.junoSuccess)
            } else if isCurrent, blocker.isSettling {
                ProgressView().controlSize(.small)
            } else {
                Text("\(number)")
                    .junoCodeSmall()
                    .foregroundStyle(isCurrent ? Color.junoAccent : Color.junoMutedForeground)
                    .frame(width: 20, height: 20)
                    .overlay(
                        Circle().strokeBorder(
                            isCurrent ? Color.junoAccent : Color.junoBorder,
                            lineWidth: 1
                        )
                    )
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}

// MARK: - Thread

/// The three surfaces of a task. The first answers "what do I need to know?";
/// the other two keep the audit trail available without making every reader
/// wade through it before reaching the result.
private enum DesktopWorkSurface: String, CaseIterable, Identifiable {
    case overview
    case activity
    case files

    var id: Self { self }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .activity: "Activity"
        case .files: "Files & cost"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "rectangle.topthird.inset.filled"
        case .activity: "clock.arrow.circlepath"
        case .files: "folder"
        }
    }
}

/// One task, from the goal it was given to the last thing it did.
///
/// The header and blocking cards stay fixed at the top of the reading surface.
/// Everything below them is deliberately split into three modes so the result
/// and plan are a short catch-up view, while the activity log and file ledger
/// remain available as first-class surfaces rather than as an endless appendix.
private struct DesktopWorkThread: View {
    let model: NativeWorkModel
    /// This Mac's hosting model, for approvals raised by a run executing here.
    var hostModel: DesktopWorkHostModel?
    let session: WorkSessionSummary
    @Binding var answerDraft: String
    @Binding var instructionDraft: String
    @State private var surface: DesktopWorkSurface = .overview

    private var status: JunoWorkStatus { model.displayStatus(of: session) }

    /// Whether the model's stream is pointed at *this* task.
    ///
    /// The model holds one open task at a time, and for the frame between a new
    /// selection landing and `followSelection` re-pointing the stream, its run,
    /// its events and its pending approval still describe the previous one.
    /// Rendering those under this task's title would show somebody another run's
    /// plan, files and spend — briefly, and convincingly enough to act on.
    private var isFollowing: Bool { model.openSession?.sessionID == session.sessionID }

    private var run: WorkRunSummary? { isFollowing ? model.openRun : nil }
    private var events: [WorkEvent] { isFollowing ? model.events : [] }

    /// The decision this thread is blocked on, from whichever side raised it.
    ///
    /// Two sources, because there are two executors and only one of them writes
    /// a `WorkApproval` row. A cloud run's question arrives through the relay in
    /// `model.pendingApprovals`; a run executing on this Mac suspends inside
    /// `WorkApprovalCoordinator` in this process and reaches the window through
    /// ``DesktopWorkHostModel/localApprovals``. Reading only the first is why
    /// the approval card never appeared for the runs that touch local files.
    ///
    /// The local one wins a tie. If both somehow name a question for this run,
    /// the local coordinator is the one actually holding a suspended tool, and
    /// answering the relay's copy would leave it suspended.
    private var blockingApproval: (request: WorkApprovalRequest, isLocal: Bool)? {
        guard isFollowing else { return nil }
        if let local = hostModel?.localApprovals(forRun: run?.runID ?? session.currentRunID).first {
            return (local, true)
        }
        if let remote = model.currentApproval { return (remote, false) }
        return nil
    }

    var body: some View {
        // `JunoDetailPage` and never a bare `ScrollView`: this page is the
        // longest surface in the app, and a detail column that reports its
        // content height resizes the window's split view rather than being
        // clipped by it.
        JunoDetailPage(maxWidth: 980) {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                // Both cards act on the model's *open* task, so they are drawn
                // only while that is this one. An Allow button rendered under
                // one task's title and wired to another's approval is the worst
                // thing this window could do.
                if let blocking = blockingApproval {
                    DesktopWorkApprovalCard(
                        model: model,
                        approval: blocking.request,
                        decideLocally: blocking.isLocal
                            ? { [hostModel] decision in
                                hostModel?.localApprovalDecider?(
                                    blocking.request.id,
                                    decision,
                                    blocking.request.actionDigest
                                )
                            }
                            : nil
                    )
                    .id(blocking.request.id)
                }
                // One slot, two boxes, and never both. `composerMode` is the
                // model's single answer to what this task can be told right now,
                // shared with the phone and mirroring the web's own rule; asking
                // it here rather than re-deriving "is there a question" locally
                // is what keeps the answer path exactly as it was while the
                // instruction path appears beside it.
                //
                // A `.closed` task draws nothing. The web's box is always
                // present so it has to render its own reason; this thread's
                // header already carries the status sentence — "This task has
                // finished", "Not started" — and a second greyed panel below it
                // would be the same fact twice in two voices.
                if isFollowing {
                    switch model.composerMode {
                    case .answer(let question):
                        DesktopWorkQuestionCard(
                            model: model,
                            question: question,
                            draft: $answerDraft
                        )
                    case .instruction:
                        DesktopWorkInstructionCard(model: model, draft: $instructionDraft)
                    case .closed:
                        EmptyView()
                    }
                }
                surfacePicker
                selectedSurface
            }
        }
        .onChange(of: session.sessionID) { _, _ in
            surface = .overview
        }
    }

    private var surfacePicker: some View {
        HStack(spacing: JunoSpace.regular) {
            Label("Task details", systemImage: surface.symbol)
                .junoSidebarSection()
                .labelStyle(.titleAndIcon)
            Spacer(minLength: JunoSpace.snug)
            Picker("Task details", selection: $surface) {
                ForEach(DesktopWorkSurface.allCases) { surface in
                    Text(surface.title).tag(surface)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 390)
            .labelsHidden()
            .accessibilityIdentifier("juno.work.surface")
        }
        .padding(.horizontal, JunoSpace.hairline)
    }

    @ViewBuilder
    private var selectedSurface: some View {
        switch surface {
        case .overview:
            currentAction
            result
            plan
        case .activity:
            activity
        case .files:
            changes
            artifacts
            budget
        }
    }

    // MARK: Header

    private var header: some View {
        let style = DesktopWorkStatusStyle.of(status)
        return VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
                Text(session.title)
                    .font(.system(size: 28, weight: .semibold, design: .rounded))
                    .lineLimit(2)
                    .textSelection(.enabled)
                Spacer(minLength: JunoSpace.snug)
                DesktopWorkStatusPill(status: status)
                    // Nudged onto the title's cap height. A capsule aligned on
                    // its own text baseline sits low beside a serif heading,
                    // because the pill's padding is part of its box and the
                    // baseline is not where its centre is.
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 5 }
            }

            Text(session.goal)
                .junoBody()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            // The status sentence is kept as prose. The structured run facts
            // below carry provenance and cost in a scannable row, so this line
            // can stay human rather than becoming a wall of metadata.
            Text(metadataLine(style: style))
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            runFacts

            // Every reason the run is not what was asked for, in the server's
            // own words. A degradation the client cannot name shows the user
            // nothing, and nothing is indistinguishable from nothing having gone
            // wrong.
            if let degradation = run?.degradation, !degradation.isEmpty {
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    // Keyed by position, not by `kind`. One run can degrade
                    // twice the same way — two connectors unavailable, two
                    // capabilities missing — and a duplicate `ForEach` id
                    // silently drops every note after the first.
                    ForEach(Array(degradation.enumerated()), id: \.offset) { _, note in
                        Label {
                            Text(note.explanation)
                                .junoCaption()
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(Color.junoCaution)
                        }
                    }
                }
                .padding(JunoSpace.cozy)
                .junoPanel()
            }

            controls
        }
    }

    /// The header's sentence is the status in the user's vocabulary. Where the
    /// task ran, which model answered and what it cost are rendered as labelled
    /// facts beside it, not buried in one long interpuncted line.
    private func metadataLine(style: DesktopWorkStatusStyle) -> String {
        style.sentence
    }

    private var runFacts: some View {
        HStack(spacing: 0) {
            fact("Where", value: runningWhere, symbol: "location")
            Divider().frame(height: 38)
            fact("Model", value: effectiveModelLabel, symbol: "cpu")
            Divider().frame(height: 38)
            fact("Spent", value: spentLabel, symbol: "dollarsign.circle")
            Divider().frame(height: 38)
            fact("Attempt", value: run.map { $0.attempt.formatted() } ?? "Not started", symbol: "arrow.counterclockwise")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
        .junoCard()
        .accessibilityIdentifier("juno.work.run-facts")
    }

    private var effectiveModelLabel: String {
        guard let model = run?.effectiveModel, !model.isEmpty else { return "Not chosen" }
        return model
    }

    private var spentLabel: String {
        guard let run else { return "Not started" }
        let spent = Double(run.costMicroUsd) / 1_000_000
        return spent.formatted(.currency(code: "USD"))
    }

    private func fact(_ label: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: JunoSpace.snug) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.junoAccent)
                .frame(width: 16, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .junoCaption()
                Text(value)
                    .font(.system(.callout, design: .default, weight: .medium))
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Where the task ran, named from the run rather than from the request.
    ///
    /// The requested target is a *request*: the server picks the effective one
    /// from what the plan needs and what is actually reachable. Printing the
    /// request would tell somebody their task ran on their Mac, with their
    /// files, when it ran in the cloud without them.
    private var runningWhere: String {
        DesktopWorkVocabulary.target(
            run?.effectiveTarget ?? session.effectiveTarget,
            hostName: session.hostDisplayName
        )
    }

    /// Pause, resume, stop and try again — always all four.
    ///
    /// Disabled rather than hidden for the same reason the toolbar's are: the
    /// row is read while a run is moving between states, and controls that
    /// appear and disappear underneath the pointer get mis-clicked.
    private var controls: some View {
        HStack(spacing: JunoSpace.snug) {
            // Pause and Resume are one control, not two.
            //
            // They are mutually exclusive by construction — `canPause` and
            // `canResume` can never both be true — so drawing both always left
            // one greyed slab beside one live button, and the eye had to read
            // two labels to find the one verb available. Swapping the label on a
            // single button keeps the target in the same place (which is the
            // reason the old row gave for disabling rather than hiding) without
            // spending a control on a state that cannot happen.
            Button {
                Task {
                    if status == .paused {
                        await model.resumeOpenRun()
                    } else {
                        await model.pauseOpenRun()
                    }
                }
            } label: {
                Label(
                    status == .paused ? "Resume" : "Pause",
                    systemImage: status == .paused ? "play.fill" : "pause.fill"
                )
            }
            .disabled(status.isTerminal || status == .draft)

            Button(role: .destructive) {
                Task { await model.stopOpenRun() }
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .disabled(status.isTerminal || status == .draft)

            Spacer(minLength: JunoSpace.snug)

            // The live indicator, with a word beside it.
            //
            // This was a bare `ProgressView` floating at the end of the row: a
            // spinner with no label, which reads as something loading rather
            // than as a stream being followed. It is the only thing in the
            // header that says the page is live, so it says it.
            if isFollowing, model.isStreaming {
                HStack(spacing: JunoSpace.tight) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Live")
                        .junoCaption()
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Following this task live")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .labelStyle(.titleAndIcon)
        // `isFollowing` gates the whole row for the same reason it gates the
        // approval card: these three verbs address the model's open run, not
        // this view's session.
        .disabled(model.isMutating || !isFollowing)
        .accessibilityIdentifier("juno.work.controls")
    }

    // MARK: Current action

    @ViewBuilder
    private var currentAction: some View {
        if let action = DesktopWorkLog.currentAction(in: events) {
            HStack(alignment: .center, spacing: JunoSpace.cozy) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(action.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = action.detail {
                        Text(detail)
                            .junoCaption()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.regular)
            .padding(.vertical, JunoSpace.cozy)
            // A card on the canvas, like every other block in the thread.
            // `junoPanel` is reserved for fills nested inside an already-raised
            // surface (`JunoDesktopChrome`), and this sits directly on the
            // canvas beside siblings that are cards — so it was the one block
            // drawn at the wrong elevation for where it is.
            .junoCard()
            .accessibilityIdentifier("juno.work.current-action")
        }
    }

    // MARK: Result

    /// What the run actually said — the answer, not the account of the work.
    ///
    /// **This is the thing the thread did not have.** The agent's prose reply
    /// arrives as an `assistant_message` event, and the only place it was
    /// rendered was as a *timeline row title*: one line of `junoRowLabel` beside
    /// a speech-bubble glyph, unformatted, unselectable as a unit, at the bottom
    /// of the Activity list — which is itself the last of six sections. So "pull
    /// the report together" produced a report the reader had to scroll past
    /// Plan, Read and written, Made and Budget to find, wedged into a log.
    /// `JunoMarkdownText` has been in the design system the whole time and this
    /// surface never used it.
    ///
    /// Placed directly under the blocking cards and above the plan, because the
    /// order of this page is the order somebody catching up asks in — and once a
    /// run has answered, "what did I get" is the first question, ahead of "how
    /// did it go about it".
    ///
    /// Only the **last** message is shown. A long run narrates as it goes, and
    /// every intermediate remark is still in Activity; promoting all of them
    /// would rebuild the log in a second place. The last one is the conclusion.
    @ViewBuilder
    private var result: some View {
        if let answer = DesktopWorkLog.finalAnswer(in: events) {
            DesktopWorkSection("Result") {
                JunoMarkdownText(answer)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                // Copy is the one action this block owes the reader. The text is
                // selectable, but a reader who wants the whole answer wants it
                // whole, and dragging across a scrolling page to get it is the
                // reason "copy" exists as a button everywhere else in the app.
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(answer, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier("juno.work.result.copy")
            }
            .accessibilityIdentifier("juno.work.result")
        }
    }

    // MARK: Plan

    private var plan: some View {
        DesktopWorkSection("Plan") {
            let steps = DesktopWorkLog.plan(from: events)
            if steps.isEmpty {
                Text(
                    "Juno hasn't written a plan for this yet. One appears here as soon as it has decided how to approach the task."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(steps) { step in
                    Label {
                        Text(step.title)
                            .junoRowLabel()
                            .foregroundStyle(step.state == .active ? .primary : .secondary)
                            .strikethrough(step.state == .skipped)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: step.symbol)
                            .foregroundStyle(step.tint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: Changes

    /// What the run read and what it wrote, by display name.
    ///
    /// A file appears here only when the executor gave it a name of its own. An
    /// entry that arrives as a bare string is counted and not printed, because a
    /// bare string in that field is overwhelmingly a path — and a path on screen
    /// is a path in a screenshot, a support ticket and a prompt-injection
    /// payload. The count still tells the truth about how much changed.
    private var changes: some View {
        DesktopWorkSection("Read and written") {
            let references = DesktopWorkLog.references(in: events)
            if references.isEmpty {
                Text(
                    "Nothing has been read or written yet. Every page Juno cites and every file it changes is listed here as it goes."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(references) { reference in
                    Label {
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            Text(reference.label)
                                .junoRowLabel()
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let detail = reference.detail {
                                Text(detail)
                                    .junoCaption()
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    } icon: {
                        Image(systemName: reference.direction == .read ? "link" : "doc")
                            .foregroundStyle(Color.junoMutedForeground)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                // Said only when there is something an undo would apply to.
                //
                // There is no client-issued undo anywhere in this stack:
                // `NativeWorkClient.controlKinds` is pause/resume/stop, and the
                // route behind it accepts pause/resume/cancel. `undo` is a
                // host-plane command the relay mints. A button here would be a
                // control that cannot work, and a control that cannot work is
                // worse than the sentence saying so.
                if DesktopWorkLog.hasAppliedBatch(in: events) {
                    Text("Juno can't be asked to undo these from here yet.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Artifacts

    private var artifacts: some View {
        DesktopWorkSection("Made") {
            let produced = DesktopWorkLog.artifacts(in: events)
            if produced.isEmpty {
                Text(
                    "No documents yet. Anything Juno produces — a workbook, a report, a deck — is listed here as it is written."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(produced) { artifact in
                    HStack(spacing: JunoSpace.cozy) {
                        // A glyph, not a bare file extension in a 34pt slot.
                        // A column of "xlsx" / "docx" / "pdf" set in monospace
                        // is a directory listing; this section is meant to read
                        // as the things Juno made for you.
                        Image(systemName: DesktopWorkVocabulary.artifactSymbol(artifact.kind))
                            .font(.system(size: 15))
                            .foregroundStyle(Color.junoAccent)
                            .frame(width: 22, alignment: .center)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(artifact.title)
                                .junoRowLabel()
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(
                                "\(DesktopWorkVocabulary.artifactKind(artifact.kind))  ·  "
                                    + artifact.subtitle
                            )
                            .junoCaption()
                            .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: Budget

    /// What the run has spent, against the ceiling it was given.
    ///
    /// A ceiling of zero means no ceiling was set, and the meter is omitted
    /// rather than drawn full — a bar pinned at 100% would read as a run about
    /// to be stopped.
    private var budget: some View {
        DesktopWorkSection("Budget") {
            if let run {
                let spent = Double(run.costMicroUsd) / 1_000_000
                if run.maxCostMicroUsd > 0 {
                    let ceiling = Double(run.maxCostMicroUsd) / 1_000_000
                    ProgressView(value: min(spent, ceiling), total: ceiling) {
                        Text("Spent")
                            .junoCaption()
                    } currentValueLabel: {
                        Text(
                            "\(spent.formatted(.currency(code: "USD"))) of \(ceiling.formatted(.currency(code: "USD")))"
                        )
                        .junoCaption()
                        .monospacedDigit()
                    }
                    .tint(Color.junoAccent)
                    .accessibilityIdentifier("juno.work.budget")
                } else {
                    Text("Spent \(spent.formatted(.currency(code: "USD"))). No ceiling was set for this run.")
                        .junoCaption()
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Which attempt this is. The model that answered used to be
                // repeated here too; it is in the header's metadata line now,
                // and a fact stated twice on one page is a fact the reader has
                // to check against itself.
                Text("Attempt \(run.attempt)")
                    .junoCaption()
                    .monospacedDigit()
            } else {
                Text(
                    "This task has not been started, so there is nothing to describe yet — no target, no model, no budget spent."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Activity

    private var activity: some View {
        let entries = DesktopWorkLog.entries(in: events)
        return DesktopWorkSection("Activity", count: entries.count) {
            if entries.isEmpty {
                Text(
                    "Nothing has happened yet. Every step Juno takes appears here as it takes it."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            } else {
                // A timed, gutter-aligned log rather than a list of labels.
                //
                // Three things were wrong with the `Label` version: there was no
                // time on any row, so a finished run could not be read for how
                // long anything took; the icon and the text were laid out by
                // `Label`, which puts the glyph on the first line's baseline and
                // leaves multi-line rows hanging; and the whole entry was tinted
                // by tone, so a warning row set its *body* in amber. Tone now
                // colours the glyph only, and the row's own text stays readable.
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    ForEach(entries) { entry in
                        HStack(alignment: .top, spacing: JunoSpace.cozy) {
                            Image(systemName: entry.symbol)
                                .font(.system(size: 12))
                                .foregroundStyle(entry.tint)
                                .frame(width: 16, height: 16, alignment: .center)
                                // Sits on the title's cap height rather than
                                // floating at the top of a two-line row.
                                .padding(.top, 2)

                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.title)
                                    .junoRowLabel()
                                    .fixedSize(horizontal: false, vertical: true)
                                if let detail = entry.detail {
                                    Text(detail)
                                        .junoCaption()
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }

                            Spacer(minLength: JunoSpace.cozy)

                            Text(entry.at.formatted(date: .omitted, time: .shortened))
                                .junoCaption()
                                .monospacedDigit()
                                .padding(.top, 1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

// MARK: - Blocking cards

/// The one action the run has stopped to ask permission for.
///
/// The whole request is handed to the model rather than an identifier, because
/// the digest of the exact action and its expiry both have to travel with the
/// answer — the executor recomputes the digest immediately before acting and
/// refuses on a mismatch, which is what stops an approval shown for one action
/// authorising a different one.
private struct DesktopWorkApprovalCard: View {
    let model: NativeWorkModel
    let approval: WorkApprovalRequest
    /// Set when the question was raised by a run executing on this Mac, in which
    /// case the answer goes to the in-process coordinator holding the suspended
    /// tool rather than to the relay — there is no `WorkApproval` row for the
    /// relay to update. Nil for a cloud run, which takes the relay path.
    var decideLocally: ((JunoWorkApprovalDecision) -> Void)?

    private var risk: JunoWorkRiskLevel? { JunoWorkRiskLevel(rawValue: approval.risk) }

    /// The colour the card is edged and headed in. Irreversible actions are the
    /// only ones that get danger; everything else that reaches a person is
    /// caution. See ``DesktopWorkVocabulary/riskTint(_:)``.
    private var tint: Color { DesktopWorkVocabulary.riskTint(approval.risk) }

    /// Whether this action could be covered by a standing "always allow".
    /// The shared rule checks both risk and always-confirm action identity.
    private var allowsStandingGrant: Bool {
        approval.allowsStandingGrant
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A tinted header band rather than a tinted hairline.
            //
            // The card used to be a plain `junoCard()` with a second 1pt stroke
            // laid over the border it already draws, at the same radius — two
            // concentric hairlines that read as one muddy 2pt edge rather than
            // as a cautioned card. A band states the same thing with one edge:
            // it gives the card a head, it carries the risk colour at a size
            // that can actually be seen, and it puts the risk label and the
            // expiry on a ground of their own instead of loose under the prose.
            HStack(spacing: JunoSpace.snug) {
                Image(systemName: risk?.alwaysRequiresApproval == true
                    ? "exclamationmark.shield.fill" : "shield.lefthalf.filled")
                    .foregroundStyle(tint)
                Text(DesktopWorkVocabulary.risk(approval.risk))
                    .font(.system(.caption, design: .default, weight: .semibold))
                    .foregroundStyle(tint)
                Text(DesktopWorkVocabulary.action(approval.action))
                    .junoCaption()
                    .lineLimit(1)
                Spacer(minLength: JunoSpace.snug)
                // Stated rather than counted down. A live countdown would need a
                // timer running behind every thread, and the honest failure —
                // pressing Allow after the window closed — is already reported
                // by the client as a sentence saying the approval expired.
                Text("Expires \(approval.expiresAt.formatted(.relative(presentation: .named)))")
                    .junoCaption()
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.cozy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.10))

            VStack(alignment: .leading, spacing: JunoSpace.regular) {
                Text("Juno needs your decision")
                    .junoRowLabel()
                    .fontWeight(.semibold)

                // The stored sentence, verbatim. It is what an audit can prove
                // was on screen, and re-describing the action from its
                // identifier would show the reader something the record does not
                // contain.
                Text(approval.summary)
                    .junoBody()
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                // Refuse is separated from the two allows by a spacer, and it is
                // the plain button while allowing is the bordered one.
                //
                // The old row had all three as identical bordered slabs, with
                // the *escalating* option ("Allow for this task", which grants a
                // standing permission) sitting immediately beside the one-time
                // one and looking exactly like it. Weight now matches
                // consequence: one prominent action, one ordinary one, and a
                // refusal that is easy to hit and impossible to hit by accident.
                HStack(spacing: JunoSpace.snug) {
                    Button("Allow once") { decide(.allowed) }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.junoAccent)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("juno.work.approval.allow")
                    // Offered only where a standing yes is actually possible.
                    //
                    // `WorkAlwaysAllowance` has a failable initialiser that
                    // refuses anything above `command`, and decoding re-applies
                    // the rule — so a sensitive or irreversible action can never
                    // be covered by one. The button was drawn regardless, which
                    // promised a permission the model is built to refuse: the
                    // reader would press it, get a one-time approval, and be
                    // asked again on the next identical action with no
                    // explanation. Hiding it is how that guarantee becomes
                    // something a person can see rather than something the
                    // codebase merely honours.
                    if allowsStandingGrant {
                        Button("work.approval.allow-always") { decide(.allowedAlways) }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("juno.work.approval.allow-always")
                    }
                    Spacer(minLength: JunoSpace.regular)
                    Button("Refuse", role: .destructive) { decide(.denied) }
                        .buttonStyle(.bordered)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("juno.work.approval.deny")
                }
                .controlSize(.regular)
                .disabled(model.isMutating)
            }
            .padding(JunoSpace.roomy)
        }
        .background(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .fill(Color.junoRaised)
                .shadow(
                    color: .junoCardShadow,
                    radius: JunoElevation.cardBlur,
                    y: JunoElevation.cardOffsetY
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(tint.opacity(0.45), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
        .accessibilityIdentifier("juno.work.approval")
    }

    private func decide(_ decision: JunoWorkApprovalDecision) {
        if let decideLocally {
            decideLocally(decision)
            return
        }
        Task { await model.decide(approval, decision) }
    }
}

/// The question the run stopped to ask, and the reply.
private struct DesktopWorkQuestionCard: View {
    let model: NativeWorkModel
    let question: WorkQuestionPrompt
    @Binding var draft: String

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isMutating
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        // Cleared before the send rather than after it, so a slow round trip
        // cannot be answered twice by an impatient second press.
        draft = ""
        Task { await model.answer(text) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Label {
                Text(question.text)
                    .junoBody()
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } icon: {
                Image(systemName: "questionmark.bubble")
                    .foregroundStyle(Color.junoAccent)
            }

            HStack(spacing: JunoSpace.snug) {
                TextField("Your answer", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .onSubmit(send)
                    .accessibilityIdentifier("juno.work.answer.field")
                Button("Send", action: send)
                    .disabled(!canSend)
                    .accessibilityIdentifier("juno.work.answer.send")
            }
        }
        .padding(JunoSpace.roomy)
        .junoCard()
        .accessibilityIdentifier("juno.work.question")
    }
}

/// Saying something to a run that has not asked anything.
///
/// It sits in the same place as the question card and looks like it on purpose.
/// The reader's question is the same either way — "can I say something to this?"
/// — and the difference between a reply and an unprompted instruction is a
/// distinction the route cares about, not one worth making somebody learn.
///
/// The line under the field is the server's, never this window's. The route
/// writes one sentence for each outcome and it is the same sentence the web
/// shows; composing a local "Sent" here would mean a Mac that is switched off
/// produced a cheerful confirmation on the Mac beside it and an honest warning
/// in the browser, for the identical event.
private struct DesktopWorkInstructionCard: View {
    let model: NativeWorkModel
    @Binding var draft: String

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isMutating
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        // Cleared before the send rather than after it, so a slow round trip
        // cannot be sent twice by an impatient second press. The model holds the
        // idempotency key for the retry that a genuine failure invites, which is
        // why clearing here costs nothing: retyping the same sentence after a
        // failure lands under the same key.
        draft = ""
        Task { await model.sendInstruction(text) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Label {
                Text("Add something for Juno to take into account")
                    .junoBody()
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "text.bubble")
                    .foregroundStyle(Color.junoAccent)
            }

            HStack(spacing: JunoSpace.snug) {
                TextField("Say something to this task", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .onSubmit(send)
                    .accessibilityIdentifier("juno.work.instruction.field")
                Button("Send", action: send)
                    .disabled(!canSend)
                    .accessibilityIdentifier("juno.work.instruction.send")
            }

            if let outcome = model.lastInstructionOutcome {
                Label {
                    Text(outcome.explanation)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: outcome.delivered
                        ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(outcome.delivered ? Color.junoMutedForeground : Color.junoCaution)
                }
                .accessibilityIdentifier("juno.work.instruction.outcome")
            }
        }
        .padding(JunoSpace.roomy)
        .junoCard()
        .accessibilityIdentifier("juno.work.instruction")
    }
}

// MARK: - Composer

/// Describing something for Juno to go and do.
///
/// A sheet at an explicit size, like every other presented surface in this app:
/// a sheet that negotiates its own size re-lays out the window underneath it as
/// it appears, and this shell has fallen into a constraint loop over exactly
/// that.
private struct DesktopWorkComposer: View {
    let model: NativeWorkModel
    let started: (WorkSessionSummary) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var taskTitle = ""
    @State private var goal = ""
    @State private var target = JunoWorkTarget.automatic
    @State private var preferredHostID: String?

    private static let width: CGFloat = 560
    private static let height: CGFloat = 480

    private var canStart: Bool {
        !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isMutating
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
            Text("New task")
                .junoTitle()

            Text("Describe the outcome, not the steps. Juno writes the plan and asks before anything it cannot undo.")
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            TextField("Task name (optional)", text: $taskTitle)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("juno.work.composer.title")

            ZStack(alignment: .topLeading) {
                TextEditor(text: $goal)
                    .font(.system(.body))
                    // `TextEditor` paints its own opaque scroll background,
                    // which sits on top of the panel fill and leaves the editor
                    // as a white rectangle inside a rounded one.
                    .scrollContentBackground(.hidden)

                if goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Describe what you want Juno to accomplish…")
                        .junoCaption()
                        .padding(.horizontal, JunoSpace.snug)
                        .padding(.vertical, JunoSpace.cozy)
                        .allowsHitTesting(false)
                }
            }
                .frame(height: 136)
                .padding(JunoSpace.snug)
                .junoPanel()
                .accessibilityIdentifier("juno.work.composer.goal")

            Picker("Where", selection: $target) {
                Text("Wherever it fits").tag(JunoWorkTarget.automatic)
                Text("In the cloud").tag(JunoWorkTarget.cloud)
                Text("On a Mac of mine").tag(JunoWorkTarget.local)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("juno.work.composer.target")

            // Only the Macs that would actually claim the work. A picker
            // offering a Mac that is asleep is how a task sits queued for ever
            // while its owner watches a spinner.
            if target == .local {
                if model.availableHosts.isEmpty {
                    Text("None of your Macs can take work right now. Juno Work has to be switched on at the Mac itself.")
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Picker("Mac", selection: $preferredHostID) {
                        Text("Any of mine").tag(String?.none)
                        ForEach(model.availableHosts) { host in
                            Text(host.displayName).tag(String?.some(host.hostID))
                        }
                    }
                    .accessibilityIdentifier("juno.work.composer.host")
                }
            }

            Spacer(minLength: 0)

            HStack {
                Spacer(minLength: JunoSpace.regular)
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Start task") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canStart)
                    .accessibilityIdentifier("juno.work.composer.start")
            }
        }
        .padding(JunoSpace.section)
        .frame(width: Self.width, height: Self.height)
        // Sheet contract: the warm ground inside the content, the platter left to
        // the system. `.fitted` honours the explicit frame above.
        .junoSheetSurface(.fitted)
    }

    private func start() {
        guard canStart else { return }
        let title = taskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = goal
        Task {
            guard let session = await model.startTask(
                goal: text,
                title: title.isEmpty ? nil : title,
                target: target,
                preferredHostID: target == .local ? preferredHostID : nil
            ) else { return }
            started(session)
            dismiss()
        }
    }
}

// MARK: - Section

/// A titled block in the thread: a sentence-case heading over a raised card.
///
/// **Two things changed here, and both were documented failures.**
///
/// The heading was `junoCodeSmall()` in `.textCase(.uppercase)`, and its own
/// comment claimed that matched the settings tile's eyebrow —
/// `JunoSettingsTile` sets `.textCase(nil)`, so the one place the file said it
/// was following the shared component was the place it did the opposite. Five
/// UPPERCASE MONOSPACED headings ran down a thread whose every sibling surface
/// uses sentence case. It is now ``SwiftUI/View/junoSidebarSection()``, which is
/// the app's actual section-heading style.
///
/// The content sat *directly on the canvas*. `JunoSurfaces` states the rule it
/// was breaking by name: "the Mac app painted content straight onto the warm
/// canvas, so the whole window read as one flat cream field… Anything a reader
/// actually reads sits on `junoRaised` above it." Plan, Read and written, Made,
/// Budget and Activity are the largest reading surface in the product and were
/// the largest violation of it — nine blocks at one elevation, separated by one
/// gap, reading as a single undifferentiated column. They are cards now, which
/// is also what gives the eye somewhere to stop between them.
///
/// `count` is drawn on the heading's trailing edge rather than in the body,
/// because "how many" is the question a collapsed reader asks of a section and
/// answering it in the header means not having to open it.
private struct DesktopWorkSection<Content: View>: View {
    private let title: LocalizedStringKey
    private let count: Int?
    private let content: Content

    init(_ title: LocalizedStringKey, count: Int? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.count = count
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(title)
                    .junoSidebarSection()
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: JunoSpace.snug)
                if let count, count > 0 {
                    Text(count.formatted())
                        .font(.system(.caption, design: .default, weight: .medium))
                        .monospacedDigit()
                        .junoMetaInk()
                }
            }
            .padding(.horizontal, JunoSpace.hairline)

            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(JunoSpace.regular)
            .junoCard()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Status vocabulary

/// How Work says a status on this platform.
///
/// A lookup rather than an extension on ``JunoWorkStatus``, because the label,
/// the sentence and the tint are this window's business and the contract enum is
/// shared with the phone and the relay. The copy matches
/// `src/components/work/work-vocabulary.tsx` deliberately: the same status must
/// not be called three things by the web, the phone and the Mac.
struct DesktopWorkStatusStyle {
    let label: String
    /// Sentence form, for empty states and accessibility. Never a fragment.
    let sentence: String
    let symbol: String
    let tint: Color

    static func of(_ status: JunoWorkStatus) -> DesktopWorkStatusStyle {
        switch status {
        case .draft:
            DesktopWorkStatusStyle(
                label: "Draft",
                sentence: "This task has been written but never started, so nothing is running and nothing is queued.",
                symbol: "square.and.pencil",
                tint: .secondary
            )
        case .queued:
            DesktopWorkStatusStyle(
                label: "Queued",
                sentence: "Waiting for an executor to pick this up.",
                symbol: "clock",
                tint: .secondary
            )
        case .preparing:
            DesktopWorkStatusStyle(
                label: "Preparing",
                sentence: "Fetching inputs, resolving permissions and starting up.",
                symbol: "hourglass",
                tint: Color.junoAccent
            )
        case .running:
            DesktopWorkStatusStyle(
                label: "Running",
                sentence: "Juno is working on this now.",
                symbol: "bolt.horizontal",
                tint: Color.junoAccent
            )
        case .waitingInput:
            DesktopWorkStatusStyle(
                label: "Needs an answer",
                sentence: "Juno has asked you something and cannot continue until you answer.",
                symbol: "questionmark.bubble",
                tint: Color.junoCaution
            )
        case .waitingApproval:
            DesktopWorkStatusStyle(
                label: "Needs approval",
                sentence: "Juno is waiting for you to allow or refuse an action.",
                symbol: "shield.lefthalf.filled",
                tint: Color.junoCaution
            )
        case .paused:
            DesktopWorkStatusStyle(
                label: "Paused",
                sentence: "You stopped this. It can be resumed.",
                symbol: "pause.circle",
                tint: .secondary
            )
        case .completed:
            DesktopWorkStatusStyle(
                label: "Done",
                sentence: "This finished.",
                symbol: "checkmark.circle",
                tint: Color.junoSuccess
            )
        case .failed:
            DesktopWorkStatusStyle(
                label: "Failed",
                sentence: "The run itself reported that it could not finish.",
                symbol: "xmark.circle",
                tint: Color.junoDanger
            )
        case .cancelled:
            DesktopWorkStatusStyle(
                label: "Cancelled",
                sentence: "This was cancelled before it finished.",
                symbol: "slash.circle",
                tint: .secondary
            )
        case .interrupted:
            DesktopWorkStatusStyle(
                label: "Interrupted",
                sentence: "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.",
                symbol: "exclamationmark.triangle",
                tint: Color.junoCaution
            )
        case .hostOffline:
            DesktopWorkStatusStyle(
                label: "Mac unreachable",
                sentence: "The Mac this needed went away mid-run. Wake it and try again, or move the task to the cloud.",
                symbol: "laptopcomputer.slash",
                tint: Color.junoCaution
            )
        case .budgetExceeded:
            DesktopWorkStatusStyle(
                label: "Hit its limit",
                sentence: "This stopped because it reached the ceiling set for it.",
                symbol: "gauge.with.dots.needle.100percent",
                tint: Color.junoCaution
            )
        case .timedOut:
            DesktopWorkStatusStyle(
                label: "Timed out",
                sentence: "This ran for longer than its time limit allowed and was stopped.",
                symbol: "clock.badge.exclamationmark",
                tint: Color.junoCaution
            )
        }
    }
}

// MARK: - Reading the log

/// Everything the thread shows about a run, derived from its event stream.
///
/// Derived rather than read from a second server-side projection, so the thread
/// and the resume cursor can never disagree about what has happened. That makes
/// every reader here defensive: `WorkEvent.payload` is JSON written by an
/// executor which may be a release ahead of this build, and a field that is
/// missing or the wrong type has to degrade to "no detail" rather than produce
/// nothing. One unreadable event costs one line, never the whole page.
///
/// The key names are the ones `src/components/work/work-timeline.tsx` and
/// `work-detail-panels.tsx` read, because the executor writing them is the same
/// executor for both surfaces and a Mac reading different keys would render an
/// empty thread for a task the web shows in full.
enum DesktopWorkLog {
    // MARK: Payload readers

    private static func string(_ payload: [String: JunoJSONValue], _ keys: String...) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue else { continue }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return value }
        }
        return nil
    }

    private static func number(_ payload: [String: JunoJSONValue], _ keys: String...) -> Int? {
        for key in keys {
            if let value = payload[key]?.numberValue { return Int(value) }
        }
        return nil
    }

    /// A count that may have been written either as a number or as the array it
    /// counts.
    private static func count(_ payload: [String: JunoJSONValue], _ key: String) -> Int? {
        if let value = payload[key]?.numberValue { return Int(value) }
        if case .array(let items)? = payload[key] { return items.count }
        return nil
    }

    private static func fields(_ value: JunoJSONValue) -> [String: JunoJSONValue] {
        if case .object(let object) = value { return object }
        return [:]
    }

    /// Plural forms written out rather than left to `^[…](inflect: true)`.
    ///
    /// The markup only resolves when the string reaches a `LocalizedStringKey`,
    /// and these are `String`s assembled here and rendered by `Text(String)`,
    /// which is verbatim. A run that changed two files would have said
    /// "^[2 file](inflect: true) changed" on screen.
    private static func fileCount(_ count: Int) -> String {
        count == 1 ? "1 file changed" : "\(count) files changed"
    }

    private static func changeCount(_ count: Int) -> String {
        count == 1 ? "1 change" : "\(count) changes"
    }

    /// The events a person is meant to see.
    ///
    /// `visibility` is the contract's own classification and the only correct
    /// filter: an operator or internal event is withheld not because it is
    /// uninteresting but because it may carry a raw tool payload. A kind this
    /// build does not know is dropped for the same reason — it cannot be
    /// classified, and the contract's rule is that an unclassified kind hides
    /// rather than leaks.
    private static func visible(_ events: [WorkEvent]) -> [(WorkEvent, JunoWorkEventKind)] {
        events.compactMap { event in
            guard let kind = JunoWorkEventKind(rawValue: event.kind),
                kind.visibility == "user"
            else { return nil }
            return (event, kind)
        }
    }

    // MARK: Plan

    enum StepState: Equatable, Sendable {
        case pending
        case active
        case done
        case skipped
        case failed

        init?(rawValue: String) {
            switch rawValue {
            case "pending": self = .pending
            case "active": self = .active
            case "done": self = .done
            case "skipped": self = .skipped
            case "failed": self = .failed
            default: return nil
            }
        }
    }

    struct PlanStep: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let state: StepState

        var symbol: String {
            switch state {
            case .pending: "circle.dashed"
            case .active: "circle.dotted"
            case .done: "checkmark.circle"
            case .skipped: "minus.circle"
            case .failed: "xmark.circle"
            }
        }

        var tint: Color {
            switch state {
            case .pending, .skipped: .secondary
            case .active: Color.junoAccent
            case .done: Color.junoSuccess
            case .failed: Color.junoDanger
            }
        }
    }

    /// The current plan, rebuilt from the newest plan event and then advanced by
    /// the step events that followed it.
    ///
    /// Rebuilt rather than patched into the previous version: a re-plan can
    /// drop, reorder or rename steps, and merging two versions produces a list
    /// that was never anybody's plan.
    static func plan(from events: [WorkEvent]) -> [PlanStep] {
        var steps: [PlanStep] = []
        var planSeq = -1

        for (event, kind) in visible(events) {
            guard kind == .planCreated || kind == .planUpdated else { continue }
            guard case .array(let raw)? = event.payload["steps"] else { continue }
            planSeq = event.seq
            steps = raw.enumerated().compactMap { index, entry in
                let step = fields(entry)
                guard let title = string(step, "title", "label", "summary") else { return nil }
                let state = string(step, "state", "status").flatMap(StepState.init(rawValue:))
                return PlanStep(
                    id: string(step, "id", "stepId") ?? "\(index)",
                    title: title,
                    state: state ?? .pending
                )
            }
        }

        guard !steps.isEmpty else { return steps }

        var byID = Dictionary(steps.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (event, kind) in visible(events) where event.seq > planSeq {
            guard let id = string(event.payload, "stepId", "id"), let step = byID[id] else {
                continue
            }
            switch kind {
            case .stepStarted:
                byID[id] = PlanStep(id: step.id, title: step.title, state: .active)
            case .stepFinished:
                let state = string(event.payload, "state", "status")
                    .flatMap(StepState.init(rawValue:)) ?? .done
                byID[id] = PlanStep(id: step.id, title: step.title, state: state)
            default:
                continue
            }
        }
        // Rebuilt in the plan's own order rather than the dictionary's, which
        // has none — a plan whose steps reorder themselves between frames is
        // unreadable.
        return steps.compactMap { byID[$0.id] }
    }

    // MARK: The answer

    /// The last thing the run said in prose, for the Result section.
    ///
    /// The last rather than all of them: a run narrates as it works, and the
    /// concluding message is the one that answers the goal. The earlier ones
    /// stay in the timeline, where a running commentary belongs.
    ///
    /// Read through ``WorkEventPayload/fields(of:)`` for the same reason every
    /// other reader here is — the cloud runner nests its facts one level down
    /// and this Mac's run host writes them flat, and a reader that knew only one
    /// shape would find no answer at all for half the runs in the product.
    static func finalAnswer(in events: [WorkEvent]) -> String? {
        var answer: String?
        for (event, kind) in visible(events) where kind == .assistantMessage {
            let payload = WorkEventPayload.fields(of: event)
            guard let text = string(payload, "text", "message") else { continue }
            answer = text
        }
        return answer
    }

    // MARK: Current action

    struct CurrentAction: Equatable, Sendable {
        let title: String
        let detail: String?
    }

    /// The action in flight, or nil when nothing is.
    ///
    /// Cleared by the matching finish event and by every terminal or blocking
    /// event, because the failure this guards against is the banner still saying
    /// "Reading your Downloads folder" long after the run died — an endless
    /// spinner in a different costume.
    static func currentAction(in events: [WorkEvent]) -> CurrentAction? {
        var current: CurrentAction?
        for (event, kind) in visible(events) {
            switch kind {
            case .toolStarted:
                current = CurrentAction(
                    title: string(event.payload, "summary", "title")
                        ?? describeTool(string(event.payload, "tool", "name")),
                    detail: string(event.payload, "detail", "target")
                )
            case .stepStarted:
                current = CurrentAction(
                    title: string(event.payload, "title", "label") ?? "Working",
                    detail: nil
                )
            case .toolFinished, .toolDenied, .stepFinished, .runFinished, .paused, .error,
                .questionAsked, .approvalRequested:
                current = nil
            default:
                continue
            }
        }
        return current
    }

    /// What a tool call is doing, in English.
    ///
    /// This was `tool.replacingOccurrences(of: "_", with: " ")`, which put
    /// "apply changes" and "screen control" in the largest line of the window —
    /// the live action banner — and made the most-looked-at text in Juno Work
    /// read as a log. ``DesktopWorkVocabulary`` names the tools the executors
    /// actually register and sentence-cases anything it has not met.
    private static func describeTool(_ tool: String?) -> String {
        DesktopWorkVocabulary.toolPresent(tool)
    }

    // MARK: References

    enum ReferenceDirection: Equatable, Sendable {
        case read
        case written
    }

    struct Reference: Identifiable, Equatable, Sendable {
        let id: String
        let direction: ReferenceDirection
        let label: String
        let detail: String?
    }

    /// Everything the run read or wrote, as far as the stream reported it.
    ///
    /// Sources and file changes are one list because that is the question
    /// somebody actually has — what did it touch — and splitting them into two
    /// makes the answer something the reader has to assemble.
    static func references(in events: [WorkEvent]) -> [Reference] {
        var references: [Reference] = []

        for (event, kind) in visible(events) {
            switch kind {
            case .sourceCited:
                let url = string(event.payload, "url", "href")
                guard let label = string(event.payload, "title", "label") ?? url else { continue }
                references.append(
                    Reference(
                        id: "\(event.seq)",
                        direction: .read,
                        label: label,
                        detail: string(event.payload, "publisher", "site") ?? url
                    )
                )

            case .filesChanged, .batchApplied:
                var entries: [JunoJSONValue] = []
                if case .array(let files)? = event.payload["files"] {
                    entries = files
                } else if case .array(let items)? = event.payload["items"] {
                    entries = items
                }

                let named = entries.enumerated().compactMap { index, entry -> Reference? in
                    let record = fields(entry)
                    // A named entry only. Anything that arrives as a bare string
                    // is overwhelmingly a path, and this surface must never
                    // print one — see the note on `DesktopWorkThread.changes`.
                    guard let label = string(record, "label", "name", "displayName", "title")
                    else { return nil }
                    let bytes = number(record, "bytes", "size")
                    return Reference(
                        id: "\(event.seq)-\(index)",
                        direction: .written,
                        label: label,
                        // The change verb sentence-cased, not the raw `created`
                        // / `moved` / `renamed` token the executor writes. It
                        // sits under a filename in the reader's own list of what
                        // Juno touched, which is prose, not a field value.
                        detail: bytes.map { "\($0.formatted(.byteCount(style: .file)))" }
                            ?? string(record, "change", "action")
                                .map(DesktopWorkVocabulary.sentenceCased)
                    )
                }

                if !named.isEmpty {
                    references.append(contentsOf: named)
                    continue
                }

                // Nothing could be named without printing a path, so the row
                // states the size of the change instead of inventing a filename.
                let changed = count(event.payload, "count") ?? entries.count
                guard changed > 0 else { continue }
                references.append(
                    Reference(
                        id: "\(event.seq)",
                        direction: .written,
                        label: Self.fileCount(changed),
                        detail: string(event.payload, "summary")
                    )
                )

            default:
                continue
            }
        }

        return references
    }

    /// Whether the run has applied a batch of changes that was not later undone.
    ///
    /// Read only to decide whether to say that undo is not available from here;
    /// saying it on a task that changed nothing would be noise.
    static func hasAppliedBatch(in events: [WorkEvent]) -> Bool {
        var applied = 0
        var undone = 0
        for (_, kind) in visible(events) {
            if kind == .batchApplied { applied += 1 }
            if kind == .batchUndone { undone += 1 }
        }
        return applied > undone
    }

    // MARK: Artifacts

    struct Artifact: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let kind: JunoWorkArtifactKind
        let version: Int?
        let updatedAt: Date

        var fileExtension: String { kind.fileExtension }

        var subtitle: String {
            let stamp = updatedAt.formatted(.relative(presentation: .named))
            guard let version else { return "written \(stamp)" }
            return "v\(version) · \(stamp)"
        }
    }

    /// The documents this run has produced, newest state per artifact.
    ///
    /// An update replaces the row rather than adding one: the section answers
    /// "what has Juno made", and five rows for five saves of the same workbook
    /// answers a question nobody asked.
    static func artifacts(in events: [WorkEvent]) -> [Artifact] {
        var artifacts: [String: Artifact] = [:]
        var order: [String] = []
        for (event, kind) in visible(events) {
            guard kind == .artifactCreated || kind == .artifactUpdated else { continue }
            guard let id = string(event.payload, "artifactId", "id", "identifier") else { continue }
            // `bundle` is the fallback because it is the kind that promises
            // least about what will open: labelling an unknown export
            // "spreadsheet" invites a click that ends in an error.
            let artifactKind = string(event.payload, "kind")
                .flatMap(JunoWorkArtifactKind.init(rawValue:)) ?? .bundle
            if artifacts[id] == nil { order.append(id) }
            artifacts[id] = Artifact(
                id: id,
                title: string(event.payload, "title", "name") ?? "Untitled document",
                kind: artifactKind,
                version: number(event.payload, "version", "currentVersion"),
                updatedAt: event.createdAt
            )
        }
        return order.compactMap { artifacts[$0] }
    }

    // MARK: Timeline

    struct Entry: Identifiable, Equatable, Sendable {
        let id: Int
        let title: String
        let detail: String?
        let symbol: String
        let tone: Tone
        /// When it happened.
        ///
        /// The log carried no time at all, which meant a finished run could not
        /// be read for how long anything took, and a live one gave no sense of
        /// pace. `WorkEvent.createdAt` was already on every event and was only
        /// being used for artifact subtitles.
        let at: Date

        enum Tone: Equatable, Sendable {
            case quiet
            case normal
            case warning
            case bad
            case good
        }

        var tint: Color {
            switch tone {
            case .quiet: .secondary
            case .normal: .primary
            case .warning: Color.junoCaution
            case .bad: Color.junoDanger
            case .good: Color.junoSuccess
            }
        }
    }

    /// Kinds whose whole content is already shown by a section of its own.
    private static let renderedElsewhere: Set<JunoWorkEventKind> = [.planCreated, .planUpdated]

    static func entries(in events: [WorkEvent]) -> [Entry] {
        visible(events)
            .filter { !renderedElsewhere.contains($0.1) }
            .map { describe($0.0, $0.1) }
    }

    /// One event as a sentence a person can read.
    ///
    /// An exhaustive switch, not a lookup with a fallback: a kind added to the
    /// contract and forgotten here is a compile error rather than a blank row in
    /// somebody's thread.
    private static func describe(_ event: WorkEvent, _ kind: JunoWorkEventKind) -> Entry {
        // Lifted, not read raw. The cloud runner wraps each kind's facts in one
        // sub-object — an approval's summary and action live under `request`,
        // a question's text under `question` — so every accessor below returned
        // nil for a cloud run and the thread filled with bare verbs: "Asked for
        // approval" with nothing saying what for. `WorkEventPayload.fields`
        // flattens the envelope this Mac's own run host does not write, which
        // makes one reader correct for both executors.
        let payload = WorkEventPayload.fields(of: event)
        switch kind {
        case .runStarted:
            // The target as a phrase, not the raw `local` / `cloud` token the
            // payload carries.
            return entry(
                event, "Started",
                string(payload, "target").map {
                    DesktopWorkVocabulary.target($0, hostName: nil)
                },
                "play.circle", .quiet
            )
        case .planCreated:
            return entry(event, "Wrote a plan", nil, "sparkles", .quiet)
        case .planUpdated:
            return entry(event, "Revised the plan", string(payload, "reason"), "sparkles", .quiet)
        case .stepStarted:
            return entry(
                event, string(payload, "title", "label") ?? "Started a step", nil,
                "play.circle", .normal
            )
        case .stepFinished:
            return entry(
                event, string(payload, "title", "label") ?? "Finished a step",
                string(payload, "summary"), "checkmark", .quiet
            )
        case .assistantMessage:
            return entry(
                event, string(payload, "text", "message") ?? "Said something", nil,
                "text.bubble", .normal
            )
        case .toolStarted:
            return entry(
                event, string(payload, "summary") ?? describeTool(string(payload, "tool", "name")),
                string(payload, "target", "detail"), "wrench.and.screwdriver", .normal
            )
        case .toolFinished:
            // Past tense here, present tense on `toolStarted`. One vocabulary
            // read two ways, because a log that says "Reading a file" under a
            // finished run is describing something that is not happening.
            return entry(
                event,
                string(payload, "summary")
                    ?? DesktopWorkVocabulary.toolPast(string(payload, "tool", "name")),
                string(payload, "result", "detail"), "checkmark", .quiet
            )
        case .toolDenied:
            return entry(
                event,
                "Refused: \(DesktopWorkVocabulary.action(string(payload, "tool", "name")))",
                string(payload, "reason", "explanation"), "hand.raised", .warning
            )
        case .questionAsked:
            return entry(
                event, string(payload, "question", "text") ?? "Asked you a question", nil,
                "questionmark.bubble", .warning
            )
        case .questionAnswered:
            return entry(
                event, "You answered", string(payload, "text", "answer"), "text.bubble", .quiet
            )
        // Said without being asked, which is why it does not read as an answer.
        // The payload keeps `question_answered`'s field names so a row written
        // by an older build — where a steer had to ride that kind — renders
        // through the same accessor.
        case .userMessage:
            return entry(
                event, "You added an instruction", string(payload, "text"), "text.bubble", .quiet
            )
        case .approvalRequested:
            return entry(
                event, string(payload, "summary") ?? "Asked for approval",
                string(payload, "action").map(DesktopWorkVocabulary.action),
                "shield.lefthalf.filled", .warning
            )
        case .approvalResolved:
            return entry(
                event,
                string(payload, "decision") == "denied"
                    ? "You refused an action" : "You allowed an action",
                string(payload, "summary")
                    ?? string(payload, "action").map(DesktopWorkVocabulary.action),
                "shield.lefthalf.filled", .quiet
            )
        case .artifactCreated:
            return entry(
                event, "Created \(string(payload, "title") ?? "a file")",
                artifactKindPhrase(payload), "doc.badge.plus", .good
            )
        case .artifactUpdated:
            return entry(
                event, "Updated \(string(payload, "title") ?? "a file")",
                artifactKindPhrase(payload), "doc", .quiet
            )
        case .sourceCited:
            return entry(
                event, string(payload, "title", "url") ?? "Cited a source",
                string(payload, "url"), "link", .quiet
            )
        case .filesChanged:
            let changed = count(payload, "files") ?? count(payload, "count")
            return entry(
                event,
                changed.map(fileCount) ?? "Changed files",
                string(payload, "summary"), "doc", .normal
            )
        case .batchPreview:
            let size = count(payload, "items") ?? count(payload, "count")
            return entry(
                event,
                size.map { "Prepared \(changeCount($0)) for review" }
                    ?? "Prepared a batch of changes",
                string(payload, "summary"), "list.bullet.rectangle", .normal
            )
        case .batchApplied:
            let size = count(payload, "items") ?? count(payload, "count")
            return entry(
                event,
                size.map { "Applied \(changeCount($0))" } ?? "Applied a batch of changes",
                string(payload, "summary"), "checkmark", .good
            )
        case .batchUndone:
            let size = count(payload, "reversedCount") ?? count(payload, "count")
            return entry(
                event,
                size.map { "Undid \(changeCount($0))" } ?? "Undid a batch of changes",
                string(payload, "summary"), "arrow.uturn.backward", .quiet
            )
        case .subagentUpdate:
            // Never the bare `agentId`. An identifier in the title slot is the
            // one row in the log that is unreadable to the person it is for.
            return entry(
                event, string(payload, "title") ?? "A sub-agent reported in",
                string(payload, "status", "summary"), "sparkles", .quiet
            )
        case .degraded:
            return entry(
                event, "Ran with less than you asked for", string(payload, "explanation"),
                "exclamationmark.triangle", .warning
            )
        case .budgetWarning:
            return entry(
                event, "Approaching a limit", string(payload, "detail", "explanation"),
                "gauge.with.dots.needle.67percent", .warning
            )
        case .hostDisconnected:
            return entry(
                event, "\(string(payload, "hostName") ?? "The Mac") disconnected",
                string(payload, "detail"), "laptopcomputer.slash", .warning
            )
        case .hostReconnected:
            return entry(
                event, "\(string(payload, "hostName") ?? "The Mac") reconnected", nil,
                "laptopcomputer", .good
            )
        case .paused:
            return entry(event, "Paused", string(payload, "reason"), "pause.circle", .quiet)
        case .resumed:
            return entry(event, "Resumed", nil, "play.circle", .quiet)
        case .validationResult:
            let passed = payload["ok"]?.boolValue != false
            return entry(
                event, passed ? "Checked its own work" : "A check did not pass",
                string(payload, "detail", "summary"),
                passed ? "checkmark.seal" : "exclamationmark.triangle",
                passed ? .quiet : .warning
            )
        case .runFinished:
            // "Finished — completed" was the status said twice, and "Finished —
            // truncated" was a wire token in the middle of a sentence.
            // ``DesktopWorkVocabulary/terminalReason(_:)`` returns nil where the
            // reason adds nothing, so a clean finish is just "Finished".
            let reason = string(payload, "reason")
            let because = DesktopWorkVocabulary.terminalReason(reason)
            return entry(
                event, because.map { "Finished because \($0)" } ?? "Finished",
                string(payload, "detail", "summary"),
                "flag.checkered", reason == "completed" ? .good : .warning
            )
        case .error:
            return entry(
                event, "Something went wrong", string(payload, "message", "detail"),
                "exclamationmark.triangle", .bad
            )
        }
    }

    private static func entry(
        _ event: WorkEvent,
        _ title: String,
        _ detail: String?,
        _ symbol: String,
        _ tone: Entry.Tone
    ) -> Entry {
        Entry(
            id: event.seq, title: title, detail: detail, symbol: symbol, tone: tone,
            at: event.createdAt
        )
    }

    /// An artifact event's kind as a noun, never the raw `spreadsheet` token.
    private static func artifactKindPhrase(_ payload: [String: JunoJSONValue]) -> String? {
        string(payload, "kind")
            .flatMap(JunoWorkArtifactKind.init(rawValue:))
            .map(DesktopWorkVocabulary.artifactKind)
    }
}
