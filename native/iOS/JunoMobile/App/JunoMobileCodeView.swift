import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

/// **Juno Code** on the phone: start a coding task and watch it run.
///
/// Two targets, one composer. **Cloud** dispatches a runner against a GitHub
/// repository and opens a pull request; **Remote** hands the task to a Mac or
/// Windows machine signed in to Juno Code, working in a real local folder. They
/// share a screen because from here they are the same act — describe the work,
/// choose where it happens, watch the log — and the difference that matters
/// (where the code actually lives) is named on the control that selects it, not
/// buried in a setting.
struct JunoMobileCodeView: View {
    @Bindable var model: NativeCodeModel
    /// Starts a Juno Code conversation that has no project, sends the reader's
    /// first message into it, and opens it.
    ///
    /// Owned by the root view rather than here because it needs the
    /// conversation store as well as the code model, and because a conversation
    /// with no project is not a run: it has messages, not a task event log, and
    /// the screen that renders messages already exists. Handing it to the chat
    /// view is what keeps this feature from needing a second transcript
    /// renderer inside the Code section.
    let startConversation: (String) async -> Void
    /// The pull requests Juno Code opened. Nil where the app could not be
    /// configured, in which case the toolbar simply does not offer them.
    var pullsClient: NativeGitHubPullsClient?
    var accountID: AccountID?
    /// Opens the app's connected accounts, for the "connect GitHub" empty state.
    var openConnections: (() -> Void)?
    /// The signed-in account. Code shows who is signed in and what their plan
    /// has left, exactly as the website's Code mode keeps the user menu in its
    /// sidebar — see ``accountBar``. Nil on an unconfigured shell.
    var session: NativeAuthenticatedSession?
    /// The account photo's bytes, already fetched through the authenticated file
    /// route. Nil falls back to initials.
    var avatarData: Data?
    /// The authenticated transport, for the plan meters and the usage page.
    var requestSender: (any NativeAuthenticatedRequestSending)?
    /// Used only to render a model's product name on the usage page.
    var modelCatalog: [NativeChatModelOption] = []
    /// Opens the account's settings, which is where everything else about the
    /// profile lives. Nil where the shell has no settings model.
    var openSettings: (() -> Void)?

    @State private var prompt = ""
    @State private var showingPulls = false
    @State private var showingUsage = false
    /// The cheap half of the usage read: what plan this is and how much of each
    /// window is spent.
    @State private var plan: NativeUsagePlan?
    @FocusState private var composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch model.phase {
            case .idle, .loading:
                JunoMobileQuietLoading()
            case .failed:
                // A reader in No Project mode needs neither the device list nor
                // the repository list, so a failure to read them must not
                // replace the one screen they can still use. The inline error
                // inside `sessions` reports it instead.
                if model.isTargetless {
                    sessions
                } else {
                    ContentUnavailableView {
                        Label {
                            Text("code.unavailable")
                        } icon: {
                            JunoIconView(.error, size: 34)
                        }
                    } description: {
                        Text(model.lastErrorDescription ?? String(localized: "code.retry"))
                    } actions: {
                        Button("Retry") { Task { await model.refresh() } }
                            .buttonStyle(.borderedProminent)
                    }
                }
            case .ready:
                sessions
            }
        }
        .background(Color.junoCanvas)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        // A destination rather than a tab: a reader checks on pull requests
        // between sessions, not while they have one open, so it belongs beside
        // the session list and not inside it.
        .toolbar {
            if pullsClient != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingPulls = true
                    } label: {
                        Image(systemName: "arrow.trianglehead.pull")
                    }
                    .accessibilityLabel("Pull requests")
                    .accessibilityIdentifier("juno.mobile.code.pulls")
                }
            }
            // The account, reachable from Code itself. Before this the only way
            // to a profile or a usage figure from here was the drawer, then
            // Settings, then a row — three taps and two contexts away from the
            // screen that is spending the quota.
            if let session {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showingUsage = true } label: {
                            Label("Your usage", systemImage: "chart.line.uptrend.xyaxis")
                        }
                        if let openSettings {
                            Button(action: openSettings) {
                                JunoIconLabel("navigation.settings", icon: .settings)
                            }
                        }
                    } label: {
                        JunoAvatar(
                            imageData: avatarData,
                            imageURL: session.profile.imageURL,
                            name: session.profile.name ?? session.profile.email,
                            size: 26
                        )
                    }
                    .accessibilityLabel("Account")
                    .accessibilityIdentifier("juno.mobile.code.account")
                }
            }
        }
        .navigationDestination(isPresented: $showingPulls) {
            NativePullsView(
                client: pullsClient,
                accountID: accountID,
                openConnections: openConnections
            )
        }
        .navigationDestination(isPresented: $showingUsage) {
            if let session {
                JunoMobileUsageView(
                    session: session,
                    requestSender: requestSender,
                    modelCatalog: modelCatalog
                )
            }
        }
        // Read once per visit, and only the plan half is kept. The breakdown the
        // same call returns is the expensive one, so the shortest range is asked
        // for — the meters are what this screen shows, and the full ledger is one
        // tap away on the page that is actually about it.
        .task {
            guard plan == nil, let requestSender, let accountID else { return }
            plan = await NativeUsageClient(sender: requestSender)
                .load(range: .month, for: accountID)
                .plan
        }
        .navigationDestination(
            isPresented: Binding(
                get: { model.openTask != nil },
                set: { if !$0 { model.closeOpenTask() } }
            )
        ) {
            JunoMobileCodeSessionView(model: model)
        }
        .accessibilityIdentifier("juno.mobile.code")
    }

    // MARK: Session list + composer

    private var sessions: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                JunoPageTitle(
                    title: "navigation.code",
                    subtitle: model.isTargetless ? "code.subtitle.none" : "code.subtitle"
                )
                    .padding(.top, 6)

                if let error = model.lastErrorDescription {
                    JunoInlineError(message: error) { Task { await model.refresh() } }
                }

                accountBar

                if model.tasks.isEmpty {
                    JunoMobileCodeGreeting(targetless: model.isTargetless)
                        .containerRelativeFrame(.vertical) { height, _ in height * 0.68 }
                } else {
                    JunoGroupLabel(text: String(localized: "code.group.sessions"))
                    ForEach(model.tasks) { task in
                        Button { model.open(task) } label: {
                            JunoMobileCodeTaskRow(task: task)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom) { composer }
    }

    /// Who is signed in, what they are on, and how much of it is left.
    ///
    /// The website keeps its user menu in the sidebar in Code mode — avatar,
    /// name, plan badge, quota meter — so none of that is ever a navigation away
    /// while a run is costing money. This is that row, phone-shaped: identity on
    /// the left, plan on the right, and the session and weekly meters underneath
    /// once they have been read. Tapping it opens the full usage page; the
    /// avatar in the navigation bar does the same, for a reader who has scrolled
    /// past this.
    ///
    /// Nothing here is synthesised. Before the meters arrive the row shows the
    /// account and nothing else, rather than an empty gauge that implies a
    /// budget it has not read.
    @ViewBuilder
    private var accountBar: some View {
        if let session {
            Button { showingUsage = true } label: {
                JunoCard(padding: 12) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            JunoAvatar(
                                imageData: avatarData,
                                imageURL: session.profile.imageURL,
                                name: session.profile.name ?? session.profile.email,
                                size: 30
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text(session.profile.name ?? session.profile.email)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(session.profile.email)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            if let plan {
                                JunoStatusPill(text: plan.planName, tint: .junoAccent)
                            }
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.tertiary)
                        }

                        if let plan, !plan.isUnlimited, !plan.isBrowseOnly {
                            HStack(spacing: 12) {
                                meter("Session", plan.session)
                                meter("Weekly", plan.weekly)
                            }
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("juno.mobile.code.account-card")
        }
    }

    /// One window's share of the plan, as a label and a bar.
    private func meter(_ title: String, _ window: NativeUsagePlan.Window) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(window.fraction.formatted(.percent.precision(.fractionLength(0))))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            // Coral until it is nearly spent, then amber — the same rule the
            // usage page follows, so a meter means the same thing on both.
            JunoMobileUsageBar(
                fraction: window.fraction,
                tint: window.fraction >= 0.9 ? .orange : .junoAccent
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(title) window: \(window.fraction.formatted(.percent.precision(.fractionLength(0)))) used"
        )
    }

    /// The start composer: prompt, target toggle, target picker, go.
    private var composer: some View {
        VStack(spacing: 8) {
            if let blocked = model.startBlockedReason, !prompt.isEmpty {
                Label(blocked, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
            VStack(spacing: 8) {
                TextField(
                    model.isTargetless
                        ? "code.composer.placeholder.none"
                        : "code.composer.placeholder",
                    text: $prompt,
                    axis: .vertical
                )
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($composerFocused)
                    .padding(.horizontal, 8)
                    .padding(.top, 4)
                    .accessibilityIdentifier("juno.mobile.code-composer")

                HStack(spacing: 8) {
                    JunoMobileCodeTargetPicker(model: model)
                    Spacer(minLength: 4)
                    Button {
                        start()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .modifier(JunoComposerSendBackground(active: canStart))
                            .frame(width: 40, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canStart)
                    .accessibilityLabel("code.start")
                    .accessibilityIdentifier("juno.mobile.code-start")
                }
            }
            .padding(8)
            .background(JunoGlassBackground(cornerRadius: 26))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: canStart)
    }

    private var canStart: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.startBlockedReason == nil
            && !model.isMutating
    }

    private func start() {
        let text = prompt
        Task {
            if model.isTargetless {
                prompt = ""
                await startConversation(text)
                return
            }
            if await model.startTask(prompt: text) != nil { prompt = "" }
        }
    }
}

/// The Code home greeting, in the same editorial voice as the chat one so the
/// two destinations read as one product.
private struct JunoMobileCodeGreeting: View {
    /// The promise below is different without a target: there is no pull
    /// request coming and no folder being worked in.
    let targetless: Bool

    private static let phrases = [
        "code.greeting.building", "code.greeting.task", "code.greeting.next",
        "code.greeting.start", "code.greeting.ready",
    ]

    @State private var phrase: LocalizedStringKey = "code.greeting.ready"

    var body: some View {
        VStack(spacing: 12) {
            Text("code.brand")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
            HStack(spacing: 9) {
                JunoMark(size: 20)
                Text(phrase)
                    .font(JunoSerif.greeting(compact: true))
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.7)
                    .lineLimit(2)
            }
            Text(targetless ? "code.greeting.detail.none" : "code.greeting.detail")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity)
        .onAppear { phrase = LocalizedStringKey(Self.phrases.randomElement() ?? "code.greeting.ready") }
    }
}

/// "Where does this run" — the No project ⇄ Cloud ⇄ Remote toggle and the picker
/// for whichever is selected, folded into one chip row so the choice is always
/// visible without occupying a screen of its own.
private struct JunoMobileCodeTargetPicker: View {
    @Bindable var model: NativeCodeModel
    @State private var picking = false

    /// The three things the reader can aim the composer at.
    ///
    /// A local enum rather than a third `NativeCodeTarget` case: the wire
    /// target is a fact about `/api/code/tasks`, which has exactly two, and
    /// adding a third there would ripple into task decoding, the "where it
    /// runs" caption, and a server enum that has no executor for it.
    private enum Choice: Hashable {
        case none
        case cloud
        case device
    }

    private var choice: Binding<Choice> {
        Binding(
            get: {
                if model.isTargetless { return .none }
                return model.target == .cloud ? .cloud : .device
            },
            set: { next in
                switch next {
                case .none:
                    model.isTargetless = true
                case .cloud:
                    model.isTargetless = false
                    model.target = .cloud
                case .device:
                    model.isTargetless = false
                    model.target = .device
                }
            }
        )
    }

    var body: some View {
        HStack(spacing: 8) {
            // Juno's own switch, not `.pickerStyle(.segmented)`: the system
            // control fills its selected segment with the app tint, so "where
            // does this run" sat in the composer as a coral slab — louder than
            // the Send button beside it. The website's tabs are neutral.
            JunoMobileSegmented(
                options: [
                    JunoMobileSegmented<Choice>.Option(
                        Choice.none, String(localized: "code.target.none")
                    ),
                    JunoMobileSegmented<Choice>.Option(
                        Choice.cloud, String(localized: "code.target.cloud")
                    ),
                    JunoMobileSegmented<Choice>.Option(
                        Choice.device, String(localized: "code.target.remote")
                    ),
                ],
                selection: choice,
                accessibilityLabel: String(localized: "code.target")
            )
            .accessibilityIdentifier("juno.mobile.code-target")

            // Nothing to pick when there is no target: the chip would open a
            // sheet of repositories for a conversation that will not use one.
            if !model.isTargetless {
                Button {
                    picking = true
                } label: {
                    HStack(spacing: 5) {
                        JunoIconView(model.target == .cloud ? .cloud : .device, size: 13)
                        Text(label)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    }
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 11)
                    .frame(height: 32)
                    .modifier(JunoGlassCapsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(label))
                .sheet(isPresented: $picking) {
                    JunoMobileCodeTargetSheet(model: model)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                }
            }
        }
    }

    private var label: String {
        if model.isTargetless { return String(localized: "code.target.none.label") }
        switch model.target {
        case .cloud:
            return model.selectedRepository?.fullName
                ?? String(localized: "code.target.pick-repo")
        case .device:
            guard let device = model.selectedDevice else {
                return String(localized: "code.target.pick-device")
            }
            return model.selectedWorkspace.map { "\(device.name) · \($0.name)" } ?? device.name
        }
    }
}

/// The picker itself. Both halves are honest about their failure modes: an
/// unlinked GitHub sends the reader to Connections rather than offering a Retry
/// that cannot work, and a computer that is not running Juno Code says so.
private struct JunoMobileCodeTargetSheet: View {
    @Bindable var model: NativeCodeModel
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        NavigationStack {
            Group {
                switch model.target {
                case .cloud: repositories
                case .device: devices
                }
            }
            .navigationTitle(
                model.target == .cloud
                    ? Text("code.target.repository") : Text("code.target.computer")
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var repositories: some View {
        switch model.repositories {
        case .idle, .loading:
            JunoMobileQuietLoading()
                .task { model.loadRepositoriesIfNeeded() }
        case .ready(let repos):
            let filtered = search.isEmpty
                ? repos
                : repos.filter { $0.fullName.localizedCaseInsensitiveContains(search) }
            List {
                ForEach(filtered) { repo in
                    Button {
                        model.selectedRepository = repo
                        dismiss()
                    } label: {
                        HStack(spacing: 10) {
                            JunoIconView(repo.isPrivate ? .lock : .branch, size: 14)
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(repo.fullName).font(.system(size: 15, weight: .medium))
                                Text(repo.defaultBranch)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            if model.selectedRepository?.id == repo.id {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.junoAccent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .searchable(text: $search, prompt: Text("code.target.search-repos"))
        case .unavailable(let failure):
            ContentUnavailableView {
                Label {
                    Text("code.target.repos-unavailable")
                } icon: {
                    JunoIconView(.error, size: 34)
                }
            } description: {
                Text(NativeCodeError.repositories(failure).localizedDescription)
            } actions: {
                // Only the transient failure gets a Retry. The two connector
                // states need GitHub linked in Connections, and a button that
                // re-runs the same failing call is worse than none.
                if failure == .unreachable {
                    Button("Retry") { model.loadRepositoriesIfNeeded(force: true) }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    @ViewBuilder
    private var devices: some View {
        if model.devices.isEmpty {
            ContentUnavailableView {
                Label("code.target.no-devices", systemImage: "laptopcomputer.slash")
            } description: {
                Text("code.target.no-devices.detail")
            }
        } else {
            List {
                ForEach(model.devices) { device in
                    Section {
                        if device.workspaces.isEmpty {
                            Text("code.target.no-workspaces")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(device.workspaces) { workspace in
                            Button {
                                model.selectedDeviceID = device.id
                                model.selectedWorkspaceKey = workspace.id
                                dismiss()
                            } label: {
                                HStack(spacing: 10) {
                                    JunoIconView(.projects, size: 14)
                                        .foregroundStyle(.secondary)
                                        .frame(width: 20)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(workspace.name)
                                            .font(.system(size: 15, weight: .medium))
                                        Text(workspace.path)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.head)
                                    }
                                    Spacer(minLength: 0)
                                    if model.selectedDeviceID == device.id,
                                        model.selectedWorkspace?.id == workspace.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Color.junoAccent)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            // `canAcceptWork`, not `online`. A Mac can be
                            // signed in and heartbeating while claiming no
                            // queued work at all — tapping its workspace then
                            // queued a task that never started, with a spinner
                            // and no error anywhere.
                            .disabled(!device.canAcceptWork)
                        }
                        if device.online, !device.servesQueuedTasks {
                            Text("code.device.not-hosting.detail")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: device.platformSymbol)
                            Text(device.name)
                            Spacer(minLength: 4)
                            JunoStatusPill(
                                text: deviceStatusText(device),
                                tint: device.canAcceptWork ? .green : .secondary,
                                filled: device.canAcceptWork
                            )
                        }
                    }
                }
            }
        }
    }

    /// Three states, not two. "Online" used to be the only positive one, which
    /// made a signed-in Mac that serves nothing look ready.
    private func deviceStatusText(_ device: NativeCodeDevice) -> String {
        if !device.online { return String(localized: "code.device.offline") }
        if !device.servesQueuedTasks { return String(localized: "code.device.not-hosting") }
        return String(localized: "code.device.online")
    }
}

/// One session in the list.
private struct JunoMobileCodeTaskRow: View {
    let task: NativeCodeTask

    var body: some View {
        JunoCard(padding: 14) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    JunoIconView(task.target == .cloud ? .cloud : .device, size: 12)
                        .foregroundStyle(.secondary)
                    Text(task.whereItRuns)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 4)
                    JunoStatusPill(text: statusText, tint: statusTint)
                }
                Text(task.title)
                    .font(JunoSerif.cardTitle)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Text(task.updatedAt.formatted(.relative(presentation: .named)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if task.pullRequestURL != nil {
                        Text("·").foregroundStyle(.tertiary)
                        JunoIconLabel("code.pull-request", icon: .pulls, size: 12)
                            .font(.caption)
                            .foregroundStyle(Color.junoAccent)
                    }
                }
            }
        }
    }

    private var statusText: String {
        switch task.status {
        case .queued: String(localized: "code.status.queued")
        case .running: String(localized: "code.status.running")
        case .awaitingApproval: String(localized: "code.status.awaiting")
        case .done: String(localized: "code.status.done")
        case .failed: String(localized: "code.status.failed")
        case .cancelled: String(localized: "code.status.cancelled")
        }
    }

    /// Running is deliberately **not** the accent.
    ///
    /// The website marks an in-flight session with a neutral dot and lets the
    /// motion carry the meaning; painting every live row coral is what made the
    /// Code list read as a column of alerts, and it spent the accent on the most
    /// common state there is. The states that are genuinely exceptional — waiting
    /// on you, failed — keep their colour.
    private var statusTint: Color {
        switch task.status {
        case .queued: .secondary
        case .running: .secondary
        case .awaitingApproval: .orange
        case .done: .green
        case .failed: .red
        case .cancelled: .secondary
        }
    }
}

/// The live log of one session: what the agent is doing, what it wants
/// permission for, and how to stop it.
private struct JunoMobileCodeSessionView: View {
    @Bindable var model: NativeCodeModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isNearBottom = true

    private let bottomAnchor = "juno.code.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let task = model.openTask { summary(task) }
                    ForEach(model.events) { event in
                        JunoMobileCodeEventRow(event: event)
                    }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .junoScreenCanvas()
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.events.count) { _, _ in
                guard isNearBottom else { return }
                withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height <= geometry.containerSize.height
                    || geometry.contentSize.height - geometry.contentOffset.y
                        - geometry.containerSize.height < 120
            } action: { _, nearBottom in
                isNearBottom = nearBottom
            }
        }
        .navigationTitle(model.openTask?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { footer }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if model.openTask?.status.isActive == true {
                    Button(role: .destructive) {
                        Task { await model.cancelOpenTask() }
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                    .disabled(model.isMutating)
                    .accessibilityLabel("code.stop")
                }
            }
        }
        .accessibilityIdentifier("juno.mobile.code-session")
    }

    private func summary(_ task: NativeCodeTask) -> some View {
        JunoCard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    JunoIconView(task.target == .cloud ? .cloud : .device, size: 12)
                        .foregroundStyle(.secondary)
                    Text(task.whereItRuns)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if model.isStreaming {
                        ProgressView().controlSize(.mini)
                    }
                }
                if !task.prompt.isEmpty {
                    Text(task.prompt)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                }
                if let url = task.pullRequestURL {
                    Link(destination: url) {
                        Label("code.open-pull-request", systemImage: "arrow.triangle.pull")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Color.junoAccent)
                }
            }
        }
    }

    /// The approval card. It sits at the bottom, over the log, because the agent
    /// is *blocked* on it — an answer buried in the scrollback would leave a run
    /// stalled with no visible reason.
    @ViewBuilder
    private var footer: some View {
        if let approval = model.pendingApproval {
            VStack(alignment: .leading, spacing: 10) {
                Label("code.approval.title", systemImage: "hand.raised.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.orange)
                Text(approval.summary)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let detail = approval.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                HStack(spacing: 10) {
                    Button {
                        Task { await model.respondToApproval(approve: false) }
                    } label: {
                        Text("code.approval.deny")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .modifier(JunoGlassCapsule())
                    }
                    .buttonStyle(.plain)
                    Button {
                        Task { await model.respondToApproval(approve: true) }
                    } label: {
                        Text("code.approval.allow")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .modifier(JunoAccentGlassCapsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("juno.mobile.code-approve")
                }
            }
            .padding(14)
            .background(JunoGlassBackground(cornerRadius: 22))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// One line of the log, shaped by what it is: the agent's prose reads as prose,
/// a tool call and a file change read as machine output, and an error is orange.
private struct JunoMobileCodeEventRow: View {
    let event: NativeCodeEvent

    var body: some View {
        switch event.kind {
        case .text, .user:
            Text(event.title)
                .font(.callout)
                .foregroundStyle(event.kind == .user ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        case .error:
            Label {
                Text(event.title)
            } icon: {
                JunoIconView(.error, size: 15)
            }
                .font(.callout)
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .status, .done, .cancelRequest:
            Text(event.title)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:
            HStack(alignment: .top, spacing: 8) {
                Group {
                    if event.kind == .approvalRequest {
                        JunoIconView(.permission, size: 12)
                    } else {
                        Image(systemName: symbol).font(.caption2)
                    }
                }
                .foregroundStyle(.secondary)
                .frame(width: 14)
                .padding(.top, 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text(event.title)
                        .font(.system(size: 13, design: .monospaced))
                        .lineLimit(2)
                    if let detail = event.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var symbol: String {
        switch event.kind {
        case .tool: "wrench.and.screwdriver"
        case .fileChange: "doc.badge.gearshape"
        case .approvalRequest: "hand.raised"
        case .approvalResponse: "checkmark.seal"
        case .agent: "person.2"
        default: "circle"
        }
    }
}
