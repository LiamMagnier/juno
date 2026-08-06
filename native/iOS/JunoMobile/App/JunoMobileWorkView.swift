import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// **Juno Work on the phone** — the tasks you have handed Juno, and the one you
/// are reading.
///
/// A list that pushes to a thread, with the two things that *block* a run — a
/// question and an approval — raised to the top of that thread and answered in
/// a sheet. Deliberately not the Mac's window with narrower columns: on a phone
/// the reader arrives to decide something, so what a run is waiting on has to be
/// reachable without scrolling and answerable with the keyboard the sheet brings
/// with it.
///
/// Three rules are honoured here because breaking any of them tells the reader
/// something untrue about work happening on a machine they cannot see:
///
/// 1. **Status is always ``NativeWorkModel/displayStatus(of:)``, never
///    `session.status`.** A local run's status is written by its Mac, and a Mac
///    with a closed lid writes nothing — so the server's last word stays
///    `running` until the relay's reaper notices. The model corrects that, and
///    every reading on this screen goes through it.
/// 2. **A spinner means an executor.** The progress indicators here are gated on
///    ``NativeWorkModel/isRunning(_:)`` rather than on "the log has an unfinished
///    tool call", because a run whose Mac went away leaves exactly such a
///    dangling call and the honest rendering of it is the last thing that
///    happened, not an animation implying it is still happening.
/// 3. **No path is ever printed.** `WorkGrantSummary` and the file events carry
///    display names on purpose; anything arriving as a bare string is counted
///    rather than shown. A path on a phone screen is a path in a screenshot.
struct JunoMobileWorkView: View {
    let model: NativeWorkModel

    /// The task the stack is pushed onto, or nil at the list.
    ///
    /// One piece of state drives both directions: a row sets it to push, the
    /// back gesture clears it, and the model's own "I have just created and
    /// opened this task" is copied into it so the composer's Start lands the
    /// reader in the new task's thread rather than back on the list.
    @State private var openSessionID: String?
    @State private var isComposing = false

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .offline, .failed:
                // Whatever was already read stays on screen when the last
                // refresh reached nothing: a task list from a minute ago is more
                // use than an empty one, as long as the strip above it says so.
                if model.sessions.isEmpty { unreachable } else { content }
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
                Button { isComposing = true } label: { Image(systemName: "plus") }
                    .disabled(model.isMutating)
                    .accessibilityLabel("New task")
                    .accessibilityIdentifier("juno.mobile.work.new")
            }
        }
        // `item:` rather than a `NavigationLink` and `navigationDestination(for:)`.
        // Two things need it. The composer has to be able to push — it creates
        // a task and the reader should land in it — and the stack here belongs
        // to the shell's `detail(for:)`, so there is no path binding to append
        // to. And a destination bound to *this* state cannot be claimed by the
        // `navigationDestination(for: String.self)` that Projects and Artifacts
        // register on the same stack, which a bare `String` route could be.
        .navigationDestination(item: $openSessionID) { sessionID in
            JunoMobileWorkThread(model: model, sessionID: sessionID)
        }
        .sheet(isPresented: $isComposing) {
            JunoMobileWorkComposer(model: model)
        }
        .task { await model.refresh() }
        // The model opens the task it has just created. Copying that into the
        // route is what turns the composer's Start into a push; without it the
        // reader is left on the list watching a row appear.
        .onChange(of: model.openSession?.sessionID) { _, sessionID in
            guard let sessionID else { return }
            openSessionID = sessionID
        }
        // A task deleted from under the thread leaves the stack pushed onto
        // something that no longer exists, which renders as a failure rather
        // than as "that task is gone".
        .onChange(of: model.sessions.count) { _, _ in
            guard let id = openSessionID,
                !model.sessions.contains(where: { $0.sessionID == id })
            else { return }
            openSessionID = nil
        }
        // NOTE: the stream is opened and closed by the *thread*, and neither may
        // be done here. A `NavigationStack` calls `onDisappear` on its root as
        // soon as a push finishes, so a `closeOpenSession()` on this view would
        // tear the stream down in the same frame as the thread that needs it —
        // a task that renders its transcript once and never updates again.
        .accessibilityIdentifier("juno.mobile.work")
    }

    // MARK: - States

    /// Nothing to show and no way to fetch it. The model's own sentence is
    /// printed rather than a generic apology, because "no signal" and "this
    /// Mac's access was revoked" ask for different things from the reader.
    private var unreachable: some View {
        ContentUnavailableView {
            Label("Work unavailable", systemImage: "exclamationmark.triangle")
        } description: {
            Text(model.lastErrorDescription ?? "Check your connection and try again.")
        } actions: {
            Button("Retry") { Task { await model.refresh() } }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                JunoPageTitle(title: "Work", subtitle: "Things you have handed Juno to go and do.")
                    .padding(.top, 6)

                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) { Task { await model.refresh() } }
                }

                JunoMobileWorkHostCard(hosts: model.hosts)

                if model.sessions.isEmpty {
                    empty
                } else {
                    if !attention.isEmpty {
                        JunoGroupLabel(text: "Waiting on you")
                        ForEach(attention) { card($0) }
                    }
                    if !rest.isEmpty {
                        if !attention.isEmpty { JunoGroupLabel(text: "All tasks") }
                        ForEach(rest) { card($0) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .accessibilityIdentifier("juno.mobile.work.list")
    }

    /// The tasks whose next move is the reader's, split out rather than sorted
    /// to the top. A task that has stopped to ask something is not "in progress
    /// with an asterisk" — it is the only kind of task that will not move again
    /// on its own.
    private var attention: [WorkSessionSummary] {
        let needing = Set(model.sessionsNeedingAttention.map(\.sessionID))
        return listed.filter { needing.contains($0.sessionID) }
    }

    private var rest: [WorkSessionSummary] {
        let needing = Set(model.sessionsNeedingAttention.map(\.sessionID))
        return listed.filter { !needing.contains($0.sessionID) }
    }

    /// Everything not archived, most recently active first. Pinned tasks lead,
    /// exactly as they do in the conversation drawer.
    private var listed: [WorkSessionSummary] {
        model.sessions
            .filter { !$0.archived }
            .sorted {
                $0.pinned == $1.pinned
                    ? $0.lastActivityAt > $1.lastActivityAt
                    : ($0.pinned && !$1.pinned)
            }
    }

    private var empty: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("No tasks yet").font(.system(size: 17, weight: .semibold))
                Text(
                    "A task is something you hand to Juno to go and do — sort a folder, pull a report together, work through an inbox. It runs on one of your Macs or in the cloud, and tells you here what it did."
                )
                .font(.callout)
                .foregroundStyle(.secondary)
                Button { isComposing = true } label: {
                    Text("New task")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .modifier(JunoAccentGlassCapsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
        }
    }

    private func card(_ session: WorkSessionSummary) -> some View {
        JunoMobileWorkSessionCard(
            session: session,
            status: model.displayStatus(of: session),
            hostName: JunoMobileWorkHost.name(of: session.hostID, in: model.hosts),
            open: { openSessionID = session.sessionID },
            togglePin: { Task { await model.setPinned(!session.pinned, on: session) } },
            archive: { Task { await model.setArchived(true, on: session) } },
            delete: { Task { await model.delete(session) } }
        )
    }
}

// MARK: - Macs

/// Naming the Mac a task is on.
///
/// `WorkSessionSummary.hostDisplayName` decodes a `hostDisplayName` key that
/// `serializeSession` has never emitted, so it is always nil. That went
/// unnoticed for as long as no Mac could register: with an empty host list
/// every local task fell through to the same generic phrase, and the phrase was
/// right. Macs register now, this screen already holds the host list in order to
/// draw the card at the top of it, and a task that ran on a named machine should
/// say which one. "A Mac of yours" is the answer to a different question, and it
/// is kept only for the case it was written for — a task aimed at "any of mine"
/// that no Mac has claimed yet.
enum JunoMobileWorkHost {
    static func name(of hostID: String?, in hosts: [WorkHostSummary]) -> String? {
        guard let hostID else { return nil }
        return hosts.first { $0.hostID == hostID }?.displayName
    }
}

/// Which of the reader's Macs can take work, in the state each is actually in.
///
/// On the list rather than behind a settings page because a task aimed at a Mac
/// that will not serve it sits queued and looks like a slow start. `stale` is
/// named separately from `offline` for the same reason: a Mac that is
/// heartbeating but not claiming will accept a command into the queue and never
/// run it, and calling that "online" is how somebody waits an afternoon.
private struct JunoMobileWorkHostCard: View {
    let hosts: [WorkHostSummary]

    var body: some View {
        JunoCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your Macs")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)

                if hosts.isEmpty {
                    Text(
                        "No Mac is signed in to Juno Work, so only tasks that need nothing local can run. Juno Work is switched on at the Mac itself."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(hosts) { row($0) }
                }
            }
        }
        .accessibilityIdentifier("juno.mobile.work.hosts")
    }

    private func row(_ host: WorkHostSummary) -> some View {
        let style = JunoMobileWorkHostStyle.of(host)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: style.symbol)
                .font(.system(size: 15))
                .foregroundStyle(style.tint)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.displayName)
                    .font(.system(size: 15, weight: .medium))
                    .lineLimit(1)
                Text(style.sentence)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // The heartbeat itself, so "not answering" can be judged rather
                // than taken on trust.
                Text(
                    "Last heard from \(host.lastSeenAt.formatted(.relative(presentation: .named)))"
                )
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            }
            Spacer(minLength: 6)
            JunoStatusPill(text: style.label, tint: style.tint, filled: style.filled)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(host.displayName). \(style.sentence)")
    }
}

// MARK: - Session card

/// One task in the list: what it is, where it stands, and when it last moved.
private struct JunoMobileWorkSessionCard: View {
    let session: WorkSessionSummary
    /// Already corrected for a Mac this client knows is gone — see the note on
    /// ``JunoMobileWorkView``. Passed in rather than derived so the card cannot
    /// accidentally read the raw status.
    let status: JunoWorkStatus
    /// Resolved from the host list, for the same reason `status` is passed in:
    /// the card must not be able to reach the session's own always-nil copy.
    let hostName: String?
    let open: () -> Void
    let togglePin: () -> Void
    let archive: () -> Void
    let delete: () -> Void

    private var style: JunoMobileWorkStatusStyle { JunoMobileWorkStatusStyle.of(status) }

    var body: some View {
        Button(action: open) {
            JunoCard(padding: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: 8) {
                        if session.pinned {
                            JunoIconView(.pin, size: 12)
                                .foregroundStyle(Color.junoAccent)
                                .accessibilityLabel("Pinned")
                        }
                        Text(session.title)
                            .font(JunoSerif.cardTitle)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 6)
                        JunoStatusPill(text: style.label, tint: style.tint, filled: style.filled)
                    }

                    Text(session.goal)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: togglePin) {
                Label(session.pinned ? "Unpin" : "Pin", systemImage: "pin")
            }
            Button(action: archive) { Label("Archive", systemImage: "archivebox") }
            Divider()
            Button(role: .destructive, action: delete) { Label("Delete", systemImage: "trash") }
        }
        .accessibilityLabel("\(session.title). \(style.sentence)")
        .accessibilityIdentifier("juno.mobile.work.task")
    }

    /// Where it ran and when it last moved, on one line.
    ///
    /// The *effective* target, never the requested one: the request is a
    /// request, and printing it would tell somebody their task ran on their Mac
    /// with their files when it ran in the cloud without them.
    private var subtitle: String {
        let when = session.lastActivityAt.formatted(.relative(presentation: .named))
        guard let raw = session.effectiveTarget,
            let target = JunoWorkTarget(rawValue: raw)
        else { return when }
        switch target {
        case .cloud: return "Cloud · \(when)"
        case .local: return "\(hostName ?? "A Mac of yours") · \(when)"
        // `automatic` is a request and never an outcome; reaching this means the
        // server sent one, which is worth saying rather than guessing at.
        case .automatic: return "Not yet decided · \(when)"
        }
    }
}

// MARK: - Thread

/// One task, from the goal it was given to the last thing it did.
///
/// The order is the order somebody catching up asks in: what is it for, is it
/// waiting on me, what is it doing now, what is the plan, what has it touched,
/// what has it made, what has it cost, and what has happened. The blocking cards
/// are above the fold on purpose — a card the reader has to scroll to find is a
/// run that stays stopped.
private struct JunoMobileWorkThread: View {
    let model: NativeWorkModel
    let sessionID: String

    @State private var isAnswering = false
    @State private var confirmingStop = false
    @State private var confirmingRetry = false

    /// The task this thread is showing.
    ///
    /// The model's copy wins **only when it is the same task**: it is the
    /// fresher of the two, because the stream writes it while the list copy is
    /// whatever the thirty-second poll last saw. Requiring the identifiers to
    /// match is what stops the frame between a push landing and the stream being
    /// re-pointed from showing the previous task's plan under this one's title.
    private var session: WorkSessionSummary? {
        if let open = model.openSession, open.sessionID == sessionID { return open }
        return model.sessions.first { $0.sessionID == sessionID }
    }

    /// Whether the model's stream is pointed at *this* task. Everything that
    /// acts on the model's open run is gated on it, because an Allow button
    /// rendered under one task's title and wired to another task's approval is
    /// the worst thing this screen could do.
    private var isFollowing: Bool { model.openSession?.sessionID == sessionID }

    private var run: WorkRunSummary? { isFollowing ? model.openRun : nil }
    private var events: [WorkEvent] { isFollowing ? model.events : [] }

    var body: some View {
        Group {
            if let session {
                thread(session)
            } else {
                ContentUnavailableView {
                    Label("That task is gone", systemImage: "tray")
                } description: {
                    Text("It was deleted, either here or on another device.")
                }
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle(session?.title ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { controlMenu }
        }
        .sheet(isPresented: $isAnswering) {
            JunoMobileWorkAnswerSheet(model: model)
        }
        .confirmationDialog(
            "Stop this task?", isPresented: $confirmingStop, titleVisibility: .visible
        ) {
            Button("Stop", role: .destructive) { Task { await model.stopOpenRun() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Juno stops where it is. Anything it has already changed stays changed.")
        }
        .confirmationDialog(
            "Try this again?", isPresented: $confirmingRetry, titleVisibility: .visible
        ) {
            Button("Start a new task") { retry() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Juno starts a second task with the same goal, aimed at the same place. The one you are reading is kept as it is."
            )
        }
        // The thread owns the stream, opening it on appear and closing it on
        // disappear, and the pairing is what makes it self-healing: SwiftUI can
        // call `onDisappear` on a swipe-back that is then cancelled, and the
        // matching re-appear restarts this `task` and re-opens. A one-shot open
        // driven from the list's route would leave that reader on a thread that
        // had stopped updating and no way to tell.
        .task(id: sessionID) { open() }
        // Leaving the thread has to take the stream with it. The model is
        // app-level and outlives this screen, so without this the connection
        // for a task nobody is looking at stays open until sign-out. The
        // thirty-second poll continues either way, which is what keeps the
        // "waiting on you" count honest while Work is closed.
        .onDisappear { model.closeOpenSession() }
        .accessibilityIdentifier("juno.mobile.work.thread")
    }

    /// Points the model's single stream at this task.
    ///
    /// Following one at a time is the model's contract — opening a second
    /// closes the first one's stream — and `open(_:)` is itself idempotent for
    /// the task it is already following, so the re-appear above costs nothing.
    private func open() {
        guard let session else { return }
        model.open(session)
    }

    @ViewBuilder
    private func thread(_ session: WorkSessionSummary) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                header(session)
                // Both cards act on the model's *open* task, so they are drawn
                // only while that is this one.
                if isFollowing, let approval = model.currentApproval {
                    JunoMobileWorkApprovalCard(model: model, approval: approval)
                }
                if isFollowing, let question = model.pendingQuestion {
                    JunoMobileWorkQuestionCard(question: question) { isAnswering = true }
                }
                currentAction(session)
                plan
                changes
                artifacts
                budget
                activity
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
    }

    // MARK: Header

    @ViewBuilder
    private func header(_ session: WorkSessionSummary) -> some View {
        let style = JunoMobileWorkStatusStyle.of(model.displayStatus(of: session))
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(session.title)
                    .junoPageHeading(compact: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                JunoStatusPill(text: style.label, tint: style.tint, filled: style.filled)
            }
            .padding(.top, 6)

            Text(session.goal)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            Text(style.sentence)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Text(runningWhere(session))
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)

            degradations
        }
    }

    /// Every reason the run is not what was asked for, in the server's own
    /// words. A degradation this client cannot name shows the reader nothing,
    /// and nothing is indistinguishable from nothing having gone wrong.
    @ViewBuilder
    private var degradations: some View {
        if let notes = run?.degradation, !notes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                // Keyed by position, not by `kind`. One run can degrade twice
                // the same way — two connectors unavailable, two capabilities
                // missing — and a duplicate `ForEach` id silently drops every
                // note after the first.
                ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Color.junoCaution)
                        Text(note.explanation)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                    .fill(Color.junoCaution.opacity(0.10))
            )
        }
    }

    /// Where the task ran, named from the run rather than from the request.
    ///
    /// The Mac is named from the *run's* host where there is one: that is the
    /// machine that actually claimed the work, and the session carries only the
    /// one that was asked for. See ``JunoMobileWorkHost`` for why neither is
    /// read from the session's own display name.
    private func runningWhere(_ session: WorkSessionSummary) -> String {
        let effective = run?.effectiveTarget ?? session.effectiveTarget
        guard let effective, let target = JunoWorkTarget(rawValue: effective) else {
            return "Juno has not chosen where this runs yet"
        }
        switch target {
        case .cloud: return "Runs in the cloud"
        case .local:
            let name = JunoMobileWorkHost.name(of: run?.hostID ?? session.hostID, in: model.hosts)
            return "Runs on \(name ?? "a Mac of yours")"
        case .automatic: return "Where this runs has not been decided"
        }
    }

    // MARK: Controls

    /// Pause, resume, stop and try again — always all four, disabled rather than
    /// hidden. The menu is read while a run moves between states, and a control
    /// that appears and disappears under the thumb gets mis-tapped.
    private var controlMenu: some View {
        Menu {
            Button { Task { await model.pauseOpenRun() } } label: {
                Label("Pause", systemImage: "pause")
            }
            .disabled(!canPause)
            .accessibilityIdentifier("juno.mobile.work.pause")

            Button { Task { await model.resumeOpenRun() } } label: {
                Label("Resume", systemImage: "play")
            }
            .disabled(!canResume)
            .accessibilityIdentifier("juno.mobile.work.resume")

            Button(role: .destructive) { confirmingStop = true } label: {
                Label("Stop", systemImage: "stop")
            }
            .disabled(!canStop)
            .accessibilityIdentifier("juno.mobile.work.stop")

            Divider()

            // Named for what it does rather than for what "retry" usually means.
            // This composes a second task with the same goal — see `retry()` —
            // and an item labelled "Try again" alone would leave the reader
            // looking for a second run of the task they are reading.
            Button { confirmingRetry = true } label: {
                Label("Try again as a new task", systemImage: "arrow.clockwise")
            }
            .disabled(!canRetry)
            .accessibilityIdentifier("juno.mobile.work.retry")

            Button { Task { await model.refresh() } } label: {
                Label("Refresh", systemImage: "arrow.triangle.2.circlepath")
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .disabled(model.isMutating)
        .accessibilityLabel("Task actions")
        .accessibilityIdentifier("juno.mobile.work.menu")
    }

    private var status: JunoWorkStatus? {
        session.map { model.displayStatus(of: $0) }
    }

    private var canPause: Bool {
        guard isFollowing, let status else { return false }
        return !status.isTerminal && status != .paused && status != .draft
    }

    private var canResume: Bool { isFollowing && status == .paused }

    private var canStop: Bool {
        guard isFollowing, let status else { return false }
        return !status.isTerminal && status != .draft
    }

    /// Another attempt is offered only once this one is over. Anything else
    /// would put two runs of the same goal against the same folders in flight at
    /// the same time.
    private var canRetry: Bool { status?.isTerminal == true }

    /// Dispatches the same goal again, as a **new task**.
    ///
    /// That is the only re-run this client can honestly perform:
    /// ``NativeWorkModel`` exposes `startTask` and the three control verbs, and
    /// nothing that starts a second run against a session that already has one.
    /// The requested target and preferred Mac are carried over so "try again"
    /// does not quietly move the work to the cloud after a Mac came back.
    private func retry() {
        guard let session else { return }
        Task {
            await model.startTask(
                goal: session.goal,
                title: session.title,
                target: JunoWorkTarget(rawValue: session.requestedTarget) ?? .automatic,
                preferredHostID: session.hostID
            )
        }
    }

    // MARK: Current action

    /// What the run is doing right now.
    ///
    /// The spinner is gated on the model's corrected judgement rather than on
    /// the log having an unfinished tool call, because a run whose Mac closed
    /// its lid leaves exactly such a call dangling. In that case this still
    /// prints the last thing that happened — which is true and useful — but
    /// without the animation that would claim it is still happening.
    @ViewBuilder
    private func currentAction(_ session: WorkSessionSummary) -> some View {
        if let action = JunoMobileWorkLog.currentAction(in: events) {
            let live = model.isRunning(session)
            HStack(alignment: .top, spacing: 10) {
                if live {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "clock.badge.questionmark")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                        .font(.system(size: 15, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = action.detail {
                        Text(detail)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if !live {
                        Text("This is the last thing Juno reported. Nothing is running it now.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                    .fill(Color.junoMuted)
            )
            .accessibilityIdentifier("juno.mobile.work.current-action")
        }
    }

    // MARK: Sections

    private var plan: some View {
        JunoMobileWorkSection("Plan") {
            let steps = JunoMobileWorkLog.plan(from: events)
            if steps.isEmpty {
                quiet(
                    "Juno hasn't written a plan for this yet. One appears here as soon as it has decided how to approach the task."
                )
            } else {
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: step.symbol)
                            .font(.system(size: 14))
                            .foregroundStyle(step.tint)
                            .frame(width: 18)
                        Text(step.title)
                            .font(.callout)
                            .foregroundStyle(step.state == .active ? .primary : .secondary)
                            .strikethrough(step.state == .skipped)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    /// What the run read and what it wrote, by display name.
    ///
    /// A file appears here only when the executor gave it a name of its own. An
    /// entry that arrives as a bare string is counted and not printed, because a
    /// bare string in that field is overwhelmingly a path — and a path on a
    /// phone screen is a path in a screenshot, a support ticket and a
    /// prompt-injection payload. The count still tells the truth about how much
    /// changed.
    private var changes: some View {
        JunoMobileWorkSection("Read and written") {
            let references = JunoMobileWorkLog.references(in: events)
            if references.isEmpty {
                quiet(
                    "Nothing has been read or written yet. Every page Juno cites and every file it changes is listed here as it goes."
                )
            } else {
                ForEach(references) { reference in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: reference.direction == .read ? "link" : "doc")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.junoMutedForeground)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(reference.label)
                                .font(.callout)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let detail = reference.detail {
                                Text(detail)
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }

                // Said only where there is something an undo would apply to.
                //
                // There is no client-issued undo anywhere in this stack:
                // `NativeWorkClient.controlKinds` is pause, resume and stop, and
                // `undo` is a host-plane command the relay mints for the Mac
                // that made the change. A button here would be a control that
                // cannot work, and a control that cannot work is worse than the
                // sentence saying so.
                if JunoMobileWorkLog.hasAppliedBatch(in: events) {
                    quiet("Juno can't be asked to undo these from here yet.")
                }
            }
        }
    }

    private var artifacts: some View {
        JunoMobileWorkSection("Made") {
            let produced = JunoMobileWorkLog.artifacts(in: events)
            if produced.isEmpty {
                quiet(
                    "No documents yet. Anything Juno produces — a workbook, a report, a deck — is listed here as it is written."
                )
            } else {
                ForEach(produced) { artifact in
                    HStack(alignment: .top, spacing: 10) {
                        Text(artifact.kind.fileExtension)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 34, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(artifact.title)
                                .font(.callout)
                                .lineLimit(1)
                            Text(artifact.subtitle)
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    /// What the run has spent, against the ceiling it was given.
    ///
    /// A ceiling of zero means no ceiling was set, and the meter is omitted
    /// rather than drawn full — a bar pinned at 100% reads as a run about to be
    /// stopped.
    private var budget: some View {
        JunoMobileWorkSection("Cost") {
            if let run {
                let spent = Double(run.costMicroUsd) / 1_000_000
                if run.maxCostMicroUsd > 0 {
                    let ceiling = Double(run.maxCostMicroUsd) / 1_000_000
                    ProgressView(value: min(spent, ceiling), total: ceiling) {
                        Text(
                            "\(spent.formatted(.currency(code: "USD"))) of \(ceiling.formatted(.currency(code: "USD")))"
                        )
                        .font(.caption)
                        .monospacedDigit()
                    }
                    .tint(Color.junoAccent)
                    .accessibilityIdentifier("juno.mobile.work.budget")
                } else {
                    quiet(
                        "Spent \(spent.formatted(.currency(code: "USD"))). No ceiling was set for this run."
                    )
                }
                // The model that answered, not the one that was asked for. A
                // substitution the reader is not told about is one they
                // discover in the output instead.
                if let answeredBy = run.effectiveModel {
                    quiet("Answered by \(answeredBy) · attempt \(run.attempt)")
                } else {
                    quiet("Attempt \(run.attempt)")
                }
            } else {
                quiet(
                    "This task has not been started, so there is nothing to describe yet — no target, no model, nothing spent."
                )
            }
        }
    }

    private var activity: some View {
        JunoMobileWorkSection("Activity") {
            let entries = JunoMobileWorkLog.entries(in: events)
            if entries.isEmpty {
                quiet(
                    "Nothing has happened yet. Every step Juno takes appears here as it takes it."
                )
            } else {
                ForEach(entries) { entry in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: entry.symbol)
                            .font(.system(size: 13))
                            .foregroundStyle(entry.tint)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.title)
                                .font(.callout)
                                .foregroundStyle(entry.tint)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = entry.detail {
                                Text(detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    /// The recurring "there is nothing here yet, and this is what will be"
    /// sentence. One helper because an empty section that says nothing is a
    /// section the reader assumes is broken.
    private func quiet(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Blocking cards

/// The one action the run has stopped to ask permission for.
///
/// The whole request is handed back to the model rather than an identifier,
/// because two things have to travel with the answer: the digest of the exact
/// action that was on screen, which the executor recomputes immediately before
/// acting and refuses on a mismatch, and the expiry, so a card left open on a
/// locked phone since this morning cannot authorise a send this evening.
private struct JunoMobileWorkApprovalCard: View {
    let model: NativeWorkModel
    let approval: WorkApprovalRequest

    private var risk: JunoWorkRiskLevel? { JunoWorkRiskLevel(rawValue: approval.risk) }

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 12) {
                Label {
                    Text("Juno is waiting for you")
                        .font(.system(size: 15, weight: .semibold))
                } icon: {
                    Image(systemName: "shield.lefthalf.filled")
                        .foregroundStyle(Color.junoCaution)
                }

                // The stored sentence, verbatim. It is what an audit can prove
                // was on screen, and re-describing the action from its
                // identifier would show the reader something the record does
                // not contain.
                Text(approval.summary)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                HStack(spacing: 8) {
                    if let risk {
                        Text(Self.riskLabel(risk))
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(
                                risk.alwaysRequiresApproval ? Color.junoDanger : Color.secondary
                            )
                    }
                    Spacer(minLength: 4)
                    // Stated rather than counted down. A live countdown would
                    // need a timer running behind every thread, and the honest
                    // failure — pressing Allow after the window closed — is
                    // already reported by the client as a sentence saying the
                    // approval expired.
                    Text("expires \(approval.expiresAt.formatted(.relative(presentation: .named)))")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                Text(approval.action)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                VStack(spacing: 8) {
                    Button { decide(.allowed) } label: {
                        Text("Allow once")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .modifier(JunoAccentGlassCapsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("juno.mobile.work.approval.allow")

                    HStack(spacing: 8) {
                        Button("Allow for this task") { decide(.allowedAlways) }
                            .font(.system(size: 14, weight: .medium))
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.junoAccent)
                            .accessibilityIdentifier("juno.mobile.work.approval.allow-always")
                        Spacer(minLength: 8)
                        Button("Refuse") { decide(.denied) }
                            .font(.system(size: 14, weight: .medium))
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.junoDanger)
                            .accessibilityIdentifier("juno.mobile.work.approval.deny")
                    }
                }
                .disabled(model.isMutating)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                .strokeBorder(Color.junoCaution.opacity(0.35), lineWidth: 1)
        )
        .accessibilityIdentifier("juno.mobile.work.approval")
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

/// The question the run stopped to ask. The reply is typed in a sheet rather
/// than inline: a text field halfway down a scrolling thread fights the keyboard
/// for the answer's own words.
private struct JunoMobileWorkQuestionCard: View {
    let question: WorkQuestionPrompt
    let answer: () -> Void

    var body: some View {
        JunoCard {
            VStack(alignment: .leading, spacing: 12) {
                Label {
                    Text(question.text)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } icon: {
                    Image(systemName: "questionmark.bubble")
                        .foregroundStyle(Color.junoAccent)
                }

                Button(action: answer) {
                    Text("Answer")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 42)
                        .modifier(JunoAccentGlassCapsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.work.answer")
            }
        }
        .accessibilityIdentifier("juno.mobile.work.question")
    }
}

/// Typing the reply, with the keyboard up and nothing else on screen.
///
/// The question is read from the model rather than captured when the sheet
/// opens, because the log is the only authority on whether it is still being
/// asked: an answer given on the Mac or on the web arrives as a
/// `question_answered` event, and a sheet holding its own copy would take a
/// second reply for a question the run had already moved past.
private struct JunoMobileWorkAnswerSheet: View {
    let model: NativeWorkModel

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isMutating
    }

    var body: some View {
        NavigationStack {
            Group {
                if let question = model.pendingQuestion {
                    field(question)
                } else {
                    ContentUnavailableView {
                        Label("Already answered", systemImage: "checkmark.bubble")
                    } description: {
                        Text("This was answered somewhere else, and Juno has carried on.")
                    }
                }
            }
            .navigationTitle("Answer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { send() }
                        .disabled(!canSend || model.pendingQuestion == nil)
                        .accessibilityIdentifier("juno.mobile.work.answer-send")
                }
            }
            .junoScreenCanvas()
        }
        .presentationDetents([.medium])
        .tint(Color.junoAccent)
        .onAppear { focused = true }
    }

    private func field(_ question: WorkQuestionPrompt) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(question.text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

            TextField("Your answer", text: $draft, axis: .vertical)
                .lineLimit(3...8)
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: JunoCornerRadius.control, style: .continuous)
                        .fill(Color.junoMuted)
                )
                .focused($focused)
                .accessibilityIdentifier("juno.mobile.work.answer-field")

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        // Dismissed before the round trip rather than after it, so a slow relay
        // cannot be answered twice by an impatient second tap.
        dismiss()
        Task { await model.answer(text) }
    }
}

// MARK: - Composer

/// Describing something for Juno to go and do.
private struct JunoMobileWorkComposer: View {
    let model: NativeWorkModel

    @Environment(\.dismiss) private var dismiss
    @State private var goal = ""
    @State private var target = JunoWorkTarget.automatic
    @State private var preferredHostID: String?
    @FocusState private var focused: Bool

    private var canStart: Bool {
        !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isMutating
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should Juno do?", text: $goal, axis: .vertical)
                        .lineLimit(4...10)
                        .focused($focused)
                        .accessibilityIdentifier("juno.mobile.work.composer-goal")
                } footer: {
                    Text(
                        "Describe the outcome, not the steps. Juno writes the plan and asks before anything it cannot undo."
                    )
                }

                Section {
                    Picker("Where", selection: $target) {
                        Text("Wherever it fits").tag(JunoWorkTarget.automatic)
                        Text("In the cloud").tag(JunoWorkTarget.cloud)
                        Text("On a Mac of mine").tag(JunoWorkTarget.local)
                    }
                    .accessibilityIdentifier("juno.mobile.work.composer-target")

                    if target == .local { hostPicker }
                } footer: {
                    Text(targetFooter)
                }
            }
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { start() }
                        .disabled(!canStart)
                        .accessibilityIdentifier("juno.mobile.work.composer-start")
                }
            }
        }
        .tint(Color.junoAccent)
        .onAppear { focused = true }
    }

    /// Only the Macs that would actually claim the work. A picker offering a Mac
    /// that is asleep is how a task sits queued for ever while its owner watches
    /// a spinner.
    @ViewBuilder
    private var hostPicker: some View {
        if model.availableHosts.isEmpty {
            Text("None of your Macs can take work right now.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Picker("Mac", selection: $preferredHostID) {
                Text("Any of mine").tag(String?.none)
                ForEach(model.availableHosts) { host in
                    Text(host.displayName).tag(String?.some(host.hostID))
                }
            }
            .accessibilityIdentifier("juno.mobile.work.composer-host")
        }
    }

    private var targetFooter: String {
        switch target {
        case .automatic:
            "Juno picks from what the task needs and what is reachable. Only a Mac can open your files, your apps and your signed-in browser."
        case .cloud:
            "Runs on Juno's own executor, which keeps going while every device of yours is offline. It cannot reach anything local."
        case .local:
            "Runs on a Mac of yours, which is the only place your files, apps and signed-in browser exist."
        }
    }

    private func start() {
        guard canStart else { return }
        let text = goal
        Task {
            // The model opens the task it creates, and the list copies that
            // into its route, so dismissing here lands the reader in the new
            // thread rather than back on the list.
            await model.startTask(
                goal: text,
                target: target,
                preferredHostID: target == .local ? preferredHostID : nil
            )
            dismiss()
        }
    }
}

// MARK: - Section

/// A titled block in the thread: a quiet monospaced eyebrow over its content,
/// matching the eyebrow the settings tiles use.
private struct JunoMobileWorkSection<Content: View>: View {
    private let title: String
    private let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Status vocabulary

/// How Work says a status on the phone.
///
/// A lookup rather than an extension on ``JunoWorkStatus``, because the label,
/// the sentence and the tint are this app's business and the contract enum is
/// shared with the Mac and the relay. The copy matches
/// `DesktopWorkStatusStyle` and `src/components/work/work-vocabulary.tsx`
/// deliberately: the same status must not be called three things by the web,
/// the phone and the Mac.
private struct JunoMobileWorkStatusStyle {
    let label: String
    /// Sentence form, for the thread header and for accessibility. Never a
    /// fragment — this is what a reader who cannot see the pill is told.
    let sentence: String
    let symbol: String
    let tint: Color
    /// Whether the pill is tinted. Only the states that mean something is
    /// happening or something is wrong carry colour; a list where every row is
    /// coloured is a list where colour means nothing.
    let filled: Bool

    static func of(_ status: JunoWorkStatus) -> JunoMobileWorkStatusStyle {
        switch status {
        case .draft:
            JunoMobileWorkStatusStyle(
                label: "Draft",
                sentence: "This task has been written but never started, so nothing is running and nothing is queued.",
                symbol: "square.and.pencil", tint: .secondary, filled: false
            )
        case .queued:
            JunoMobileWorkStatusStyle(
                label: "Queued",
                sentence: "Waiting for an executor to pick this up.",
                symbol: "clock", tint: .secondary, filled: false
            )
        case .preparing:
            JunoMobileWorkStatusStyle(
                label: "Preparing",
                sentence: "Fetching inputs, resolving permissions and starting up.",
                symbol: "hourglass", tint: Color.junoAccent, filled: true
            )
        case .running:
            JunoMobileWorkStatusStyle(
                label: "Running",
                sentence: "Juno is working on this now.",
                symbol: "bolt.horizontal", tint: Color.junoAccent, filled: true
            )
        case .waitingInput:
            JunoMobileWorkStatusStyle(
                label: "Needs an answer",
                sentence: "Juno has asked you something and cannot continue until you answer.",
                symbol: "questionmark.bubble", tint: Color.junoCaution, filled: true
            )
        case .waitingApproval:
            JunoMobileWorkStatusStyle(
                label: "Needs approval",
                sentence: "Juno is waiting for you to allow or refuse an action.",
                symbol: "shield.lefthalf.filled", tint: Color.junoCaution, filled: true
            )
        case .paused:
            JunoMobileWorkStatusStyle(
                label: "Paused",
                sentence: "You stopped this. It can be resumed.",
                symbol: "pause.circle", tint: .secondary, filled: false
            )
        case .completed:
            JunoMobileWorkStatusStyle(
                label: "Done",
                sentence: "This finished.",
                symbol: "checkmark.circle", tint: Color.junoSuccess, filled: true
            )
        case .failed:
            JunoMobileWorkStatusStyle(
                label: "Failed",
                sentence: "The run itself reported that it could not finish.",
                symbol: "xmark.circle", tint: Color.junoDanger, filled: true
            )
        case .cancelled:
            JunoMobileWorkStatusStyle(
                label: "Cancelled",
                sentence: "This was cancelled before it finished.",
                symbol: "slash.circle", tint: .secondary, filled: false
            )
        case .interrupted:
            JunoMobileWorkStatusStyle(
                label: "Interrupted",
                sentence: "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.",
                symbol: "exclamationmark.triangle", tint: Color.junoCaution, filled: true
            )
        case .hostOffline:
            JunoMobileWorkStatusStyle(
                label: "Mac unreachable",
                sentence: "The Mac this needed went away mid-run. Wake it and try again, or start the task again in the cloud.",
                symbol: "laptopcomputer.slash", tint: Color.junoCaution, filled: true
            )
        case .budgetExceeded:
            JunoMobileWorkStatusStyle(
                label: "Hit its limit",
                sentence: "This stopped because it reached the ceiling set for it.",
                symbol: "gauge.with.dots.needle.100percent", tint: Color.junoCaution, filled: true
            )
        case .timedOut:
            JunoMobileWorkStatusStyle(
                label: "Timed out",
                sentence: "This ran for longer than its time limit allowed and was stopped.",
                symbol: "clock.badge.exclamationmark", tint: Color.junoCaution, filled: true
            )
        }
    }
}

/// How Work describes one of the reader's Macs.
///
/// Revocation and being switched off are checked before the heartbeat, because
/// both are permanent facts about whether the Mac will take work and neither is
/// improved by also being told it is online.
private struct JunoMobileWorkHostStyle {
    let label: String
    let sentence: String
    let symbol: String
    let tint: Color
    let filled: Bool

    static func of(_ host: WorkHostSummary) -> JunoMobileWorkHostStyle {
        if host.revokedAt != nil {
            return JunoMobileWorkHostStyle(
                label: "Revoked",
                sentence: "This Mac's access to Juno Work was revoked. It has to be paired again before it can take anything.",
                symbol: "xmark.shield", tint: Color.junoDanger, filled: true
            )
        }
        if !host.enabled {
            return JunoMobileWorkHostStyle(
                label: "Switched off",
                sentence: "Juno Work is switched off on this Mac. Turn it back on at the Mac itself.",
                symbol: "power", tint: .secondary, filled: false
            )
        }
        switch JunoWorkHostState(rawValue: host.state) {
        case .online:
            return JunoMobileWorkHostStyle(
                label: "Online",
                sentence: Self.busy(host, "Awake and working"),
                symbol: "laptopcomputer", tint: Color.junoSuccess, filled: true
            )
        case .idle:
            return JunoMobileWorkHostStyle(
                label: "Idle",
                sentence: Self.busy(host, "Awake with nothing to do"),
                symbol: "laptopcomputer", tint: Color.junoSuccess, filled: false
            )
        case .stale:
            return JunoMobileWorkHostStyle(
                label: "Not answering",
                sentence: "The last heartbeat from this Mac is old enough to doubt. Juno will not send it anything new until it answers again.",
                symbol: "laptopcomputer.trianglebadge.exclamationmark",
                tint: Color.junoCaution, filled: true
            )
        case .offline:
            return JunoMobileWorkHostStyle(
                label: "Offline",
                sentence: "Asleep or signed out. Nothing that needs this Mac can run.",
                symbol: "laptopcomputer.slash", tint: .secondary, filled: false
            )
        // A state this build does not know is treated as unusable rather than
        // as online: the relay may be a release ahead, and guessing "online" is
        // how work gets queued at a Mac that cannot take it.
        case nil:
            return JunoMobileWorkHostStyle(
                label: "Unknown",
                sentence: "This build does not recognise the state this Mac reported, so it is not offered for local work.",
                symbol: "questionmark.circle", tint: .secondary, filled: false
            )
        }
    }

    private static func busy(_ host: WorkHostSummary, _ lead: String) -> String {
        let active = host.activeRunCount
        let queued = host.queuedRunCount
        guard active > 0 || queued > 0 else { return "\(lead)." }
        let running = active == 1 ? "1 task running" : "\(active) tasks running"
        guard queued > 0 else { return "\(lead) — \(running)." }
        let waiting = queued == 1 ? "1 waiting" : "\(queued) waiting"
        return "\(lead) — \(running), \(waiting)."
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
/// The key names are the ones `src/components/work/work-timeline.tsx` reads,
/// because the executor writing them is the same executor for every surface and
/// a phone reading different keys would render an empty thread for a task the
/// web shows in full.
///
/// This is deliberately a second copy of the Mac app's `DesktopWorkLog`, and the
/// duplication is a target boundary rather than a preference: that type is
/// internal to the JunoDesktop application target, which the phone cannot link
/// against. If a third surface ever needs it, the copy to keep is one lifted
/// into JunoWorkKit alongside the contracts it reads.
private enum JunoMobileWorkLog {
    // MARK: Payload readers

    private static func string(_ payload: [String: JunoJSONValue], _ keys: String...) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue else { continue }
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return value }
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
    /// That markup only resolves when the string reaches a `LocalizedStringKey`,
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
    /// "Reading your Downloads folder" long after the run died.
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
    /// somebody actually has — what did it touch — and splitting them in two
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
                    // print one.
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
            // "spreadsheet" invites a tap that ends in an error.
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
                event, changed.map(fileCount) ?? "Changed files",
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
