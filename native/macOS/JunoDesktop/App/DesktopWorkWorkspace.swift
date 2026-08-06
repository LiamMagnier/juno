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
    @Binding var product: DesktopProductMode
    /// Starts an ordinary Juno conversation. A task is not a chat: a chat with
    /// nobody to run it is still a chat, so the way back to one crosses the
    /// product boundary rather than composing an empty task.
    let newChat: () -> Void

    @SceneStorage("juno.desktop.work.selection") private var storedSessionID = ""
    @SceneStorage("juno.desktop.work.columns") private var storedColumnVisibility = ""
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
                sessions: visibleSessions,
                selection: selection,
                product: $product,
                compose: { isComposing = true },
                openDesign: openDesign
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
            if storedColumnVisibility == "detailOnly" {
                columnVisibility = .detailOnly
            }
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
        storedDestination = DesktopDestination.design.rawValue
        product = .chat
    }

    // MARK: - Detail column

    @ViewBuilder
    private var detail: some View {
        if let session = openSession {
            DesktopWorkThread(
                model: model,
                session: session,
                answerDraft: $answerDraft,
                instructionDraft: $instructionDraft
            )
        } else if model.phase == .loading {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            JunoEmptyState(
                title: "Nothing open",
                message: "Choose a task on the left to see its plan, what it has done and "
                    + "anything it is waiting on you for.",
                symbol: "sidebar.left"
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
    @ViewBuilder
    private var statusIndicator: some View {
        if let session = openSession {
            let style = DesktopWorkStatusStyle.of(model.displayStatus(of: session))
            Label(style.label, systemImage: style.symbol)
                .foregroundStyle(style.tint)
                .help(style.sentence)
                .accessibilityLabel(style.sentence)
        } else {
            Label("No task open", systemImage: "checklist")
                .foregroundStyle(.secondary)
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
    let sessions: [WorkSessionSummary]
    @Binding var selection: String?
    /// Which half of the app the window is showing, so the switch at the top of
    /// this column can move it. Read by nothing else here — it exists to give
    /// the header something to write through, exactly as Chat's and Code's do.
    @Binding var product: DesktopProductMode
    let compose: () -> Void
    /// Opens Juno Design. It is not a page this window can draw — see
    /// ``DesktopWorkWorkspace/openDesign()`` — so the column asks for it rather
    /// than navigating to it.
    let openDesign: () -> Void


    private var attention: [WorkSessionSummary] {
        let needing = Set(model.sessionsNeedingAttention.map(\.sessionID))
        return sessions.filter { needing.contains($0.sessionID) }
    }

    private var rest: [WorkSessionSummary] {
        let needing = Set(model.sessionsNeedingAttention.map(\.sessionID))
        return sessions
            .filter { !needing.contains($0.sessionID) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    var body: some View {
        List(selection: $selection) {
            if !attention.isEmpty {
                Section("Waiting on you") {
                    ForEach(attention) { row($0) }
                }
            }
            Section("Tasks") {
                if rest.isEmpty {
                    Text("Nothing here yet.")
                        .junoCaption()
                } else {
                    ForEach(rest) { row($0) }
                }
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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Opaque backing, not just an inset. Without it a scrolled source
            // list slides its rows under the footer, which is the same defect
            // Code documents on the other end of this column for the product
            // switch — an inset reserves space and paints nothing.
            VStack(spacing: 0) {
                footer
                    .padding(.horizontal, JunoSpace.regular)
                    .padding(.vertical, JunoSpace.snug)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // Last, because it is the bottom of the column: Chat and Code put
                // this row directly above their account block, and this column
                // has no account block for it to sit above.
                //
                // It carries its own inset rather than this footer's deeper one.
                // The row is the same control in all three columns and the point
                // of it is that a reader finds it in the same place, so it hangs
                // on Chat's and Code's left edge rather than on the one Work's
                // status lines use.
                DesktopSidebarDesignRow(open: openDesign)
                    .padding(.bottom, JunoSpace.snug)
            }
            .background(.bar)
        }
        .accessibilityIdentifier("juno.work.sidebar")
    }

    private func row(_ session: WorkSessionSummary) -> some View {
        let style = DesktopWorkStatusStyle.of(model.displayStatus(of: session))
        return Label {
            VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                Text(session.title)
                    .junoRowLabel()
                    .lineLimit(1)
                Text(
                    "\(style.label) · \(session.lastActivityAt.formatted(.relative(presentation: .named)))"
                )
                .junoCaption()
                .lineLimit(1)
            }
        } icon: {
            Image(systemName: style.symbol)
                .foregroundStyle(style.tint)
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

    /// One line about this Mac, and the way to start something.
    ///
    /// The host's own sentence is printed verbatim when it has one. A task
    /// dispatched to a Mac that will not serve it sits queued and looks like a
    /// slow start, and the sentence explaining that is a setting on this
    /// machine — so the column that lists the tasks is where it has to appear.
    @ViewBuilder
    private var footer: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let reason = hostModel?.unavailabilityReason {
                Label {
                    Text(reason)
                        .junoCaption()
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } icon: {
                    Image(systemName: "laptopcomputer.slash")
                        .foregroundStyle(Color.junoCaution)
                }
                .accessibilityIdentifier("juno.work.host-reason")
            }

            if let error = model.lastErrorDescription {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Button(action: compose) {
                Label("New task", systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("juno.work.sidebar.new-task")
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.vertical, JunoSpace.snug)
    }
}

// MARK: - Thread

/// One task, from the goal it was given to the last thing it did.
///
/// The order is the order somebody catching up asks in: what is it for, is it
/// waiting on me, what is it doing now, what is the plan, what has it touched,
/// what has it made, what has it cost, and what has happened. The things that
/// block — an approval, a question — are above the fold on purpose; a card the
/// reader has to scroll to find is a run that stays stopped.
private struct DesktopWorkThread: View {
    let model: NativeWorkModel
    let session: WorkSessionSummary
    @Binding var answerDraft: String
    @Binding var instructionDraft: String

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

    var body: some View {
        // `JunoDetailPage` and never a bare `ScrollView`: this page is the
        // longest surface in the app, and a detail column that reports its
        // content height resizes the window's split view rather than being
        // clipped by it.
        JunoDetailPage {
            VStack(alignment: .leading, spacing: JunoSpace.section) {
                header
                // Both cards act on the model's *open* task, so they are drawn
                // only while that is this one. An Allow button rendered under
                // one task's title and wired to another's approval is the worst
                // thing this window could do.
                if isFollowing, let approval = model.currentApproval {
                    DesktopWorkApprovalCard(model: model, approval: approval)
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
                currentAction
                plan
                changes
                artifacts
                budget
                activity
            }
        }
    }

    // MARK: Header

    private var header: some View {
        let style = DesktopWorkStatusStyle.of(status)
        return VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(session.title)
                    .font(JunoSerif.pageHeading())
                Spacer(minLength: JunoSpace.snug)
                Label(style.label, systemImage: style.symbol)
                    .junoCodeSmall()
                    .foregroundStyle(style.tint)
            }

            Text(session.goal)
                .junoBody()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            Text(style.sentence)
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)

            Text(runningWhere)
                .junoCodeSmall()
                .foregroundStyle(.secondary)

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

    /// Where the task ran, named from the run rather than from the request.
    ///
    /// The requested target is a *request*: the server picks the effective one
    /// from what the plan needs and what is actually reachable. Printing the
    /// request would tell somebody their task ran on their Mac, with their
    /// files, when it ran in the cloud without them.
    private var runningWhere: String {
        let effective = run?.effectiveTarget ?? session.effectiveTarget
        guard let effective, let target = JunoWorkTarget(rawValue: effective) else {
            return "Not started — Juno has not chosen where this runs yet."
        }
        switch target {
        case .cloud: return "Runs in the cloud"
        case .local: return "Runs on \(session.hostDisplayName ?? "a Mac of yours")"
        // `automatic` is a request and never an outcome; something has to
        // choose. Reaching this means the server sent one, which is worth
        // saying rather than rendering as a confident wrong answer.
        case .automatic: return "Where this runs has not been decided"
        }
    }

    /// Pause, resume, stop and try again — always all four.
    ///
    /// Disabled rather than hidden for the same reason the toolbar's are: the
    /// row is read while a run is moving between states, and controls that
    /// appear and disappear underneath the pointer get mis-clicked.
    private var controls: some View {
        HStack(spacing: JunoSpace.snug) {
            Button("Pause") { Task { await model.pauseOpenRun() } }
                .disabled(status.isTerminal || status == .paused || status == .draft)
            Button("Resume") { Task { await model.resumeOpenRun() } }
                .disabled(status != .paused)
            Button("Stop", role: .destructive) { Task { await model.stopOpenRun() } }
                .disabled(status.isTerminal || status == .draft)
            Spacer(minLength: JunoSpace.snug)
            if isFollowing, model.isStreaming {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Following this task live")
            }
        }
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
            HStack(alignment: .top, spacing: JunoSpace.snug) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                    Text(action.title)
                        .junoRowLabel()
                        .fontWeight(.medium)
                    if let detail = action.detail {
                        Text(detail)
                            .junoCodeSmall()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(JunoSpace.cozy)
            .junoPanel()
            .accessibilityIdentifier("juno.work.current-action")
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
                                    .junoCodeSmall()
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
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
                    HStack(spacing: JunoSpace.snug) {
                        Text(artifact.kind.fileExtension)
                            .junoCodeSmall()
                            .foregroundStyle(.secondary)
                            .frame(width: 34, alignment: .leading)
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            Text(artifact.title)
                                .junoRowLabel()
                                .lineLimit(1)
                            Text(artifact.subtitle)
                                .junoCodeSmall()
                                .foregroundStyle(.secondary)
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
                        .junoCodeSmall()
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

                // The model that ran, not the one that was asked for. A
                // substitution the reader is not told about is one they
                // discover in the output instead.
                if let answeredBy = run.effectiveModel {
                    Text("Answered by \(answeredBy)")
                        .junoCodeSmall()
                        .foregroundStyle(.secondary)
                }
                Text("Attempt \(run.attempt)")
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
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
        DesktopWorkSection("Activity") {
            let entries = DesktopWorkLog.entries(in: events)
            if entries.isEmpty {
                Text(
                    "Nothing has happened yet. Every step Juno takes appears here as it takes it."
                )
                .junoCaption()
                .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(entries) { entry in
                    Label {
                        VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                            Text(entry.title)
                                .junoRowLabel()
                                .foregroundStyle(entry.tint)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = entry.detail {
                                Text(detail)
                                    .junoCaption()
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    } icon: {
                        Image(systemName: entry.symbol)
                            .foregroundStyle(entry.tint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
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

    private var risk: JunoWorkRiskLevel? { JunoWorkRiskLevel(rawValue: approval.risk) }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Label {
                Text("Juno is waiting for you")
                    .junoRowLabel()
                    .fontWeight(.medium)
            } icon: {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(Color.junoCaution)
            }

            // The stored sentence, verbatim. It is what an audit can prove was
            // on screen, and re-describing the action from its identifier would
            // show the reader something the record does not contain.
            Text(approval.summary)
                .junoBody()
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            HStack(spacing: JunoSpace.snug) {
                if let risk {
                    Text(Self.riskLabel(risk))
                        .junoCodeSmall()
                        .foregroundStyle(risk.alwaysRequiresApproval ? Color.junoDanger : .secondary)
                }
                Text(approval.action)
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: JunoSpace.snug)
                // Stated rather than counted down. A live countdown would need a
                // timer running behind every thread, and the honest failure —
                // pressing Allow after the window closed — is already reported
                // by the client as a sentence saying the approval expired.
                Text("expires \(approval.expiresAt.formatted(.relative(presentation: .named)))")
                    .junoCodeSmall()
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: JunoSpace.snug) {
                Button("Allow once") { decide(.allowed) }
                    .accessibilityIdentifier("juno.work.approval.allow")
                Button("Allow for this task") { decide(.allowedAlways) }
                    .accessibilityIdentifier("juno.work.approval.allow-always")
                Spacer(minLength: JunoSpace.snug)
                Button("Refuse", role: .destructive) { decide(.denied) }
                    .accessibilityIdentifier("juno.work.approval.deny")
            }
            .disabled(model.isMutating)
        }
        .padding(JunoSpace.roomy)
        .junoCard()
        .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                .strokeBorder(Color.junoCaution.opacity(0.35), lineWidth: 1)
        )
        .accessibilityIdentifier("juno.work.approval")
    }

    private func decide(_ decision: JunoWorkApprovalDecision) {
        Task { await model.decide(approval, decision) }
    }

    private static func riskLabel(_ risk: JunoWorkRiskLevel) -> String {
        switch risk {
        case .safe: "Changes nothing"
        case .edit: "Juno can undo this"
        case .command: "Runs a program"
        case .sensitive: "Touches private data"
        case .irreversible: "Cannot be undone"
        }
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
                        .foregroundStyle(outcome.delivered ? Color.secondary : Color.junoCaution)
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
    @State private var goal = ""
    @State private var target = JunoWorkTarget.automatic
    @State private var preferredHostID: String?

    private static let width: CGFloat = 560
    private static let height: CGFloat = 420

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

            TextEditor(text: $goal)
                .font(.system(.body))
                // `TextEditor` paints its own opaque scroll background, which
                // sits on top of the panel fill and leaves the editor as a
                // white rectangle inside a rounded one.
                .scrollContentBackground(.hidden)
                .frame(minHeight: 132)
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
                Button("Start") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canStart)
                    .accessibilityIdentifier("juno.work.composer.start")
            }
        }
        .padding(JunoSpace.section)
        .frame(width: Self.width, height: Self.height)
    }

    private func start() {
        guard canStart else { return }
        let text = goal
        Task {
            guard let session = await model.startTask(
                goal: text,
                target: target,
                preferredHostID: target == .local ? preferredHostID : nil
            ) else { return }
            started(session)
            dismiss()
        }
    }
}

// MARK: - Section

/// A titled block in the thread.
///
/// A quiet monospaced eyebrow over its content, matching the settings tile's
/// eyebrow, so the thread's sections and the rest of the app agree about what a
/// section heading looks like.
private struct DesktopWorkSection<Content: View>: View {
    private let title: LocalizedStringKey
    private let content: Content

    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text(title)
                .junoCodeSmall()
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .accessibilityAddTraits(.isHeader)
            content
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

    private static func describeTool(_ tool: String?) -> String {
        guard let tool else { return "Working" }
        return tool.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: ".", with: " ")
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
                        detail: bytes.map { "\($0.formatted(.byteCount(style: .file)))" }
                            ?? string(record, "change", "action")
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
        let payload = event.payload
        switch kind {
        case .runStarted:
            return entry(event, "Started", string(payload, "target"), "play.circle", .quiet)
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
            return entry(
                event, string(payload, "summary") ?? describeTool(string(payload, "tool", "name")),
                string(payload, "result", "detail"), "checkmark", .quiet
            )
        case .toolDenied:
            return entry(
                event, "Refused: \(describeTool(string(payload, "tool", "name")))",
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
                string(payload, "action"), "shield.lefthalf.filled", .warning
            )
        case .approvalResolved:
            return entry(
                event,
                string(payload, "decision") == "denied"
                    ? "You refused an action" : "You allowed an action",
                string(payload, "summary", "action"), "shield.lefthalf.filled", .quiet
            )
        case .artifactCreated:
            return entry(
                event, "Created \(string(payload, "title") ?? "a file")",
                string(payload, "kind"), "doc.badge.plus", .good
            )
        case .artifactUpdated:
            return entry(
                event, "Updated \(string(payload, "title") ?? "a file")",
                string(payload, "kind"), "doc", .quiet
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
            return entry(
                event, string(payload, "title", "agentId") ?? "A sub-agent reported in",
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
            let reason = string(payload, "reason")
            return entry(
                event, "Finished — \(reason ?? "no reason recorded")", string(payload, "detail"),
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
        Entry(id: event.seq, title: title, detail: detail, symbol: symbol, tone: tone)
    }
}
