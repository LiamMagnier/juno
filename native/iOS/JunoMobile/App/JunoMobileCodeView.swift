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
              .contentShape(.rect)
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
            JunoIconView(.pulls, size: 17)
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
            Button {
              showingUsage = true
            } label: {
              JunoIconLabel("Your usage", icon: .usage)
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
    VStack(spacing: 0) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          JunoPageTitle(
            title: "navigation.code",
            subtitle: model.isTargetless ? "code.subtitle.none" : "code.subtitle"
          )
          .padding(.top, 6)

          codeOverview

          if let error = model.lastErrorDescription {
            JunoInlineError(message: error) { Task { await model.refresh() } }
          }

          if model.tasks.isEmpty {
            JunoMobileCodeGreeting(
              targetless: model.isTargetless,
              onSelectIntent: { selected in
                prompt = selected
                composerFocused = true
              }
            )
            .containerRelativeFrame(.vertical) { height, _ in height * 0.68 }
          } else {
            // Triage is the first job of Code. A run that is waiting on the
            // reader must stay above ordinary activity, just like the website's
            // Needs you bucket; grouping everything under "Active" hid that
            // distinction in a list that otherwise looked like a generic feed.
            if !attentionTasks.isEmpty {
              codeTaskSection(
                title: "Needs you", icon: .permission,
                tint: Color.junoCaution, tasks: attentionTasks
              )
            }
            if !inFlightTasks.isEmpty {
              codeTaskSection(
                title: "In progress", icon: .refresh,
                tint: Color.junoMutedForeground, tasks: inFlightTasks
              )
            }
            if !recentTasks.isEmpty {
              codeTaskSection(
                title: "Recently finished", icon: .check,
                tint: Color.junoSuccess, tasks: recentTasks
              )
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }

      // A layout sibling, rather than a safe-area overlay. The compact drawer
      // uses a device-contour plate that intentionally ignores the container's
      // safe area; keeping the composer in the vertical layout guarantees the
      // last Code card can never render underneath it on iOS 26/27.
      composer
    }
  }

  private var activeTasks: [NativeCodeTask] {
    model.tasks.filter { $0.status.isActive }
  }

  private var attentionTasks: [NativeCodeTask] {
    model.tasks.filter {
      $0.status == .awaitingApproval || $0.status == .failed
    }
  }

  private var inFlightTasks: [NativeCodeTask] {
    model.tasks.filter { $0.status == .queued || $0.status == .running }
  }

  private var recentTasks: [NativeCodeTask] {
    model.tasks.filter { $0.status == .done || $0.status == .cancelled }
  }

  /// A compact command-center readout: the Code home should answer “what is
  /// happening?” before asking somebody to read a list of sessions. These are
  /// live model facts, not decorative badges, and the same status vocabulary is
  /// used by the session rows and remote picker below.
  private var codeOverview: some View {
    JunoCard(padding: 14) {
      VStack(alignment: .leading, spacing: 11) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          JunoIconView(.code, size: 16)
            .foregroundStyle(Color.junoAccent)
          Text("Build queue")
            .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
          Spacer(minLength: 4)
          JunoStatusPill(
            text: model.isTargetless
              ? "No project"
              : (model.startBlockedReason == nil ? "Ready" : "Needs setup"),
            tint: model.isTargetless || model.startBlockedReason == nil
              ? Color.junoSuccess : Color.junoCaution,
            filled: false
          )
        }
        HStack(spacing: 0) {
          codeMetric("Active", value: activeTasks.count, icon: .refresh)
          Divider().frame(height: 28)
          codeMetric("Finished", value: finishedTasks.count, icon: .check)
          Divider().frame(height: 28)
          codeMetric("Remote ready", value: readyDeviceCount, icon: .device)
        }
        Text(overviewDetail)
          .junoFont(size: 12, relativeTo: .caption)
          .junoSecondaryInk()
          .lineLimit(2)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.code-overview")
  }

  private var finishedTasks: [NativeCodeTask] {
    recentTasks.filter { $0.status == .done }
  }

  private var readyDeviceCount: Int {
    model.devices.filter(\.canAcceptWork).count
  }

  private var overviewDetail: String {
    if model.isTargetless {
      return "Start a conversation without a repository, or choose Cloud or Remote below."
    }
    if let blocked = model.startBlockedReason {
      return blocked
    }
    if model.target == .device {
      return readyDeviceCount == 0
        ? "Remote is selected. Connect a Juno Code host to run work locally."
        : "Remote is ready. Work will run in the selected local workspace."
    }
    return "Cloud runs against the selected repository and returns a pull request."
  }

  private func codeMetric(_ title: String, value: Int, icon: JunoIcon) -> some View {
    HStack(spacing: 6) {
      JunoIconView(icon, size: 13)
        .foregroundStyle(Color.junoMutedForeground)
      VStack(alignment: .leading, spacing: 1) {
        Text("\(value)")
          .junoFont(size: 16, relativeTo: .body, weight: .semibold)
          .monospacedDigit()
        Text(title)
          .junoFont(size: 10, relativeTo: .caption2, weight: .medium)
          .junoMetaInk()
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func taskGroup(_ tasks: [NativeCodeTask]) -> some View {
    VStack(spacing: JunoSpace.snug) {
      ForEach(tasks) { task in
        Button {
          model.open(task)
        } label: {
          JunoCard(padding: 0) {
            JunoMobileCodeTaskRow(task: task)
          }
        }
        .buttonStyle(.plain)
        .contentShape(.rect)
      }
    }
  }

  private func codeTaskSection(
    title: String,
    icon: JunoIcon,
    tint: Color,
    tasks: [NativeCodeTask]
  ) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(spacing: JunoSpace.tight) {
        JunoIconView(icon, size: 14)
          .foregroundStyle(tint)
        Text(title)
          .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
          .junoSecondaryInk()
        Spacer(minLength: JunoSpace.hairline)
        Text("\(tasks.count)")
          .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
          .monospacedDigit()
          .foregroundStyle(tint)
          .padding(.horizontal, 8)
          .frame(minHeight: 22)
          .background(Capsule().fill(tint.opacity(0.12)))
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(title), \(tasks.count)")
      taskGroup(tasks)
    }
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
      Button {
        showingUsage = true
      } label: {
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
                  .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                  .foregroundStyle(.primary)
                  .lineLimit(1)
                Text(session.profile.email)
                  .junoFont(size: 11, relativeTo: .caption2)
                  .junoSecondaryInk()
                  .lineLimit(1)
              }
              Spacer(minLength: 6)
              if let plan {
                JunoStatusPill(text: plan.planName, tint: .junoAccent)
              }
              JunoIconView(.chevronRight, size: 11)
                .junoMetaInk()
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
      .contentShape(.rect)
    }
  }

  /// One window's share of the plan, as a label and a bar.
  private func meter(_ title: String, _ window: NativeUsagePlan.Window) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(title)
          .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
          .junoSecondaryInk()
        Spacer(minLength: 4)
        // Not monospaced. A percentage beside its own label is a UI
        // label, not machine output, and setting it in the code face was
        // what made a plan meter read as instrumentation.
        Text(window.fraction.formatted(.percent.precision(.fractionLength(0))))
          .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
          .monospacedDigit()
          .junoSecondaryInk()
      }
      // Coral until it is nearly spent, then amber — the same rule the
      // usage page follows, so a meter means the same thing on both.
      JunoMobileUsageBar(
        fraction: window.fraction,
        tint: window.fraction >= 0.9 ? .junoCaution : .junoAccent
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
        Label {
          Text(blocked)
        } icon: {
          JunoIconView(.error, size: 13)
        }
          .font(.caption2)
          .junoSecondaryInk()
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
        .lineLimit(1...3)
        .textFieldStyle(.plain)
        .focused($composerFocused)
        .padding(.horizontal, 8)
        .frame(minHeight: 38, alignment: .top)
        .accessibilityIdentifier("juno.mobile.code-composer")

        // Target context, the three-way destination switch and Send share one
        // compact control row. The old stacked arrangement made the composer
        // cover the last run on a phone and made the destination feel like a
        // settings form instead of a launch control.
        HStack(alignment: .center, spacing: 6) {
          if !model.isTargetless {
            JunoMobileCodeTargetChip(model: model)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          JunoMobileCodeTargetSwitch(model: model)
            .fixedSize(horizontal: true, vertical: false)
          Button {
            start()
          } label: {
            JunoIconView(.send, size: 16)
              .foregroundStyle(
                canStart ? Color.junoOnAccent : Color.junoMutedForeground
              )
              .frame(width: 34, height: 34)
              .modifier(JunoComposerSendBackground(active: canStart))
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(!canStart)
          .accessibilityLabel("code.start")
          .accessibilityIdentifier("juno.mobile.code-start")
        }
      }
      .padding(7)
      .background(JunoGlassBackground(cornerRadius: 26))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
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
  var onSelectIntent: ((String) -> Void)? = nil

  private struct MobilePreset: Identifiable {
    let id: String
    let title: String
    let prompt: String
    let icon: JunoIcon
  }

  private static let presets: [MobilePreset] = [
    MobilePreset(
      id: "scaffold", title: "Scaffold Feature",
      prompt: "Scaffold a new feature with clean architecture, types, and unit tests.",
      icon: .plus),
    MobilePreset(
      id: "survey", title: "Codebase Audit",
      prompt:
        "Audit this codebase for architectural patterns, performance bottlenecks, and security.",
      icon: .research),
    MobilePreset(
      id: "refactor", title: "Refactor",
      prompt: "Refactor and modernize code to reduce technical debt and improve type safety.",
      icon: .tools),
    MobilePreset(
      id: "tests", title: "Generate Tests",
      prompt: "Write comprehensive unit and integration tests covering core workflows.",
      icon: .check),
    MobilePreset(
      id: "fix", title: "Fix Bug",
      prompt: "Diagnose and fix the root cause of this error. Propose the most reliable patch.",
      icon: .error),
    MobilePreset(
      id: "plan", title: "API & Schema",
      prompt: "Design the data models, database migration schema, and API contracts.",
      icon: .branch),
  ]

  private static let phrases = [
    "code.greeting.building", "code.greeting.task", "code.greeting.next",
    "code.greeting.start", "code.greeting.ready",
  ]

  @State private var phrase: LocalizedStringKey = "code.greeting.ready"

  var body: some View {
    VStack(spacing: 12) {
      // The wordmark, in the UI face. It was set in the code face, which
      // is the one thing the house rule reserves for code, paths and
      // terminal output — a product name in monospace is the single
      // clearest tell that a screen was drawn by a developer.
      Text("code.brand")
        .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
        .tracking(0.6)
        .junoMetaInk()
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
        .junoSecondaryInk()
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)

      if let onSelectIntent {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Self.presets) { preset in
              Button {
                onSelectIntent(preset.prompt)
              } label: {
                HStack(spacing: 6) {
                  JunoIconView(preset.icon, size: 12)
                    .foregroundStyle(Color.junoAccent)
                  Text(preset.title)
                    .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(.primary)
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .modifier(JunoGlassCapsule())
                .contentShape(Capsule())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Preset: \(preset.title)")
            }
          }
          .padding(.horizontal, 16)
        }
        .padding(.top, 6)
      }
    }
    .frame(maxWidth: .infinity)
    .onAppear { phrase = LocalizedStringKey(Self.phrases.randomElement() ?? "code.greeting.ready") }
  }
}

/// "Where does this run" — the No project ⇄ Cloud ⇄ Remote switch.
///
/// One of a pair: this half chooses the *kind* of target and
/// ``JunoMobileCodeTargetChip`` names the particular one. They were a single
/// row until the switch started truncating under the chip on a phone; splitting
/// them is what let each keep its full width without either becoming a screen
/// of its own.
private struct JunoMobileCodeTargetSwitch: View {
  @Bindable var model: NativeCodeModel

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
      accessibilityLabel: String(localized: "code.target"),
      compact: true
    )
    .accessibilityIdentifier("juno.mobile.code-target")
  }
}

/// Which repository, or which folder on which computer. Opens the picker.
private struct JunoMobileCodeTargetChip: View {
  @Bindable var model: NativeCodeModel
  @State private var picking = false

  @ViewBuilder
  var body: some View {
    // Nothing to pick when there is no target: the chip would open a sheet
    // of repositories for a conversation that will not use one.
    if !model.isTargetless {
      Button {
        picking = true
      } label: {
        HStack(spacing: 6) {
          JunoIconView(model.target == .cloud ? .cloud : .device, size: 13)
          Text(displayLabel)
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 4)
          JunoIconView(.chevronDown, size: 9)
            .junoSecondaryInk()
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        // A 36pt visual chip keeps the launch bar calm while the button's
        // surrounding row still meets the 44pt touch target. The previous
        // full-height chip stacked above the destination switch and made the
        // composer feel like a settings form.
        .frame(height: 36)
        .modifier(JunoGlassCapsule())
        .contentShape(Capsule())
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

  private var label: String {
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

  /// A short visual label leaves room for the target switch and Send. The full
  /// repository or host/workspace identity remains the accessibility label and
  /// is visible in the picker, so compactness never hides the selected target.
  private var displayLabel: String {
    switch model.target {
    case .cloud:
      return model.selectedRepository?.name
        ?? String(localized: "code.target.pick-repo")
    case .device:
      guard let device = model.selectedDevice else {
        return String(localized: "code.target.pick-device")
      }
      return model.selectedWorkspace?.name ?? device.name
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
      let filtered =
        search.isEmpty
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
                .junoSecondaryInk()
                .frame(width: 20)
              VStack(alignment: .leading, spacing: 1) {
                Text(repo.fullName)
                  .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
                Text(repo.defaultBranch)
                  .font(.caption)
                  .junoSecondaryInk()
              }
              Spacer(minLength: 0)
              if model.selectedRepository?.id == repo.id {
                JunoIconView(.check, size: 15)
                  .foregroundStyle(Color.junoAccent)
              }
            }
          }
          .buttonStyle(.plain)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
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
            .contentShape(.rect)
        }
      }
    }
  }

  @ViewBuilder
  private var devices: some View {
    if model.devices.isEmpty {
      ContentUnavailableView {
        Label {
          Text("code.target.no-devices")
        } icon: {
          JunoIconView(.device, size: 34)
        }
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
                .junoSecondaryInk()
            }
            ForEach(device.workspaces) { workspace in
              Button {
                model.selectedDeviceID = device.id
                model.selectedWorkspaceKey = workspace.id
                dismiss()
              } label: {
                HStack(spacing: 10) {
                  JunoIconView(.projects, size: 14)
                    .junoSecondaryInk()
                    .frame(width: 20)
                  VStack(alignment: .leading, spacing: 1) {
                    Text(workspace.name)
                      .junoFont(
                        size: 15, relativeTo: .subheadline, weight: .medium
                      )
                    Text(workspace.path)
                      .font(.caption)
                      .junoSecondaryInk()
                      .lineLimit(1)
                      .truncationMode(.head)
                  }
                  Spacer(minLength: 0)
                  if model.selectedDeviceID == device.id,
                    model.selectedWorkspace?.id == workspace.id
                  {
                    JunoIconView(.check, size: 15)
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
                .junoSecondaryInk()
            }
          } header: {
            HStack(spacing: 6) {
              JunoIconView(.device, size: 14)
              Text(device.name)
              Spacer(minLength: 4)
              JunoStatusPill(
                text: deviceStatusText(device),
                tint: device.canAcceptWork
                  ? Color.junoSuccess : Color.junoMutedForeground,
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
    HStack(alignment: .top, spacing: JunoSpace.cozy) {
      // A status-led rail gives the row a single scan point. The old list had
      // three equal-weight text rows and asked the reader to hunt for what was
      // actionable; the rail makes Needs you, Running and finished work read
      // differently without turning every row into an alert.
      RoundedRectangle(cornerRadius: 2, style: .continuous)
        .fill(junoCodeStatusTint(task.status))
        .frame(width: 4)

      ZStack {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Color.junoAccent.opacity(0.10))
        JunoIconView(task.target == .cloud ? .cloud : .device, size: 15)
          .foregroundStyle(Color.junoAccent)
      }
      .frame(width: 34, height: 34)

      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(task.title)
            .font(JunoSerif.cardTitle)
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          Spacer(minLength: 0)
          JunoIconView(.chevronRight, size: 11)
            .junoMetaInk()
        }

        HStack(spacing: 6) {
          Text(task.whereItRuns)
            .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
            .junoMetaInk()
            .lineLimit(1)
            .truncationMode(.head)
          Text("·").junoMetaInk()
          Text(task.updatedAt.formatted(.relative(presentation: .named)))
            .junoFont(size: 11, relativeTo: .caption2)
            .junoSecondaryInk()
            .lineLimit(1)
          if task.pullRequestURL != nil {
            JunoIconView(.pulls, size: 12)
              .foregroundStyle(Color.junoAccent)
              .accessibilityLabel("Pull request")
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      JunoStatusPill(
        text: junoCodeStatusText(task.status),
        tint: junoCodeStatusTint(task.status)
      )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 13)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A run's status as a word, shared by the list row and the session header.
///
/// Hoisted out of the row because the header used to say nothing at all: it drew
/// a bare spinner, which reads identically whether a run is healthy or wedged.
/// One function so a status cannot come to mean two different things on two
/// screens of the same product.
private func junoCodeStatusText(_ status: NativeCodeTaskStatus) -> String {
  switch status {
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
/// The ramp, not the system palette. `.orange`, `.green` and `.red` are
/// Apple's colours, tuned for a neutral grey background; on the warm canvas
/// they read as three foreign hues, and none of them had ever been checked
/// for contrast as *text*, which is how this pill draws them.
/// `junoCaution` / `junoSuccess` / `junoDanger` are the tokens Juno Code and
/// Juno Chat already share, so the same run status is the same colour on the
/// Mac, on the web and here.
private func junoCodeStatusTint(_ status: NativeCodeTaskStatus) -> Color {
  switch status {
  case .queued: Color.junoMutedForeground
  case .running: Color.junoMutedForeground
  case .awaitingApproval: Color.junoCaution
  case .done: Color.junoSuccess
  case .failed: Color.junoDanger
  case .cancelled: Color.junoMutedForeground
  }
}

private enum CodeSessionSurface: String, CaseIterable, Identifiable, Hashable {
  case activity
  case changes
  case terminal
  case tests
  case preview
  case agents
  case git

  var id: String { rawValue }

  var title: String {
    switch self {
    case .activity: "Activity"
    case .changes: "Changes"
    case .terminal: "Terminal"
    case .tests: "Tests"
    case .preview: "Preview"
    case .agents: "Agents"
    case .git: "Git / PR"
    }
  }
}

/// The live log of one session: what the agent is doing, what it wants
/// permission for, and how to stop it.
private struct JunoMobileCodeSessionView: View {
  @Bindable var model: NativeCodeModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var selectedSurface: CodeSessionSurface = .activity
  @State private var isNearBottom = true
  @State private var followUp = ""
  @FocusState private var followUpFocused: Bool

  private let bottomAnchor = "juno.code.bottom"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if let task = model.openTask { summary(task) }
          surfaceSwitcher
          switch selectedSurface {
          case .activity:
            activityContent
          case .changes:
            changesContent
          case .terminal:
            terminalContent
          case .tests:
            testsContent
          case .preview:
            previewContent
          case .agents:
            agentsContent
          case .git:
            gitContent
          }
          Color.clear.frame(height: 1).id(bottomAnchor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
      }
      .junoScreenCanvas()
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .onChange(of: model.events.count) { _, _ in
        guard isNearBottom, selectedSurface == .activity else { return }
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
            JunoIconView(.stop, size: 17)
          }
          .disabled(model.isMutating)
          .accessibilityLabel("code.stop")
        }
      }
    }
    .accessibilityIdentifier("juno.mobile.code-session")
  }

  private var surfaceSwitcher: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      JunoMobileSegmented(
        options: CodeSessionSurface.allCases.map {
          JunoMobileSegmented<CodeSessionSurface>.Option($0, $0.title)
        },
        selection: $selectedSurface,
        accessibilityLabel: "Code surface"
      )
    }
  }

  private var activityContent: some View {
    ForEach(model.events) { event in
      JunoMobileCodeEventRow(event: event)
    }
  }

  private var changesContent: some View {
    let fileEvents = model.events.filter {
      $0.kind == .fileChange || $0.fileChangeInfo != nil || $0.kind == .acceptChange
        || $0.kind == .rejectChange || $0.kind == .undoChange
    }
    return Group {
      if fileEvents.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Changes Recorded")
          } icon: {
            JunoIconView(.file, size: 30)
          }
        } description: {
          Text("Modified, created, and deleted files will appear here as the agent works.")
        }
        .padding(.vertical, 24)
      } else {
        VStack(alignment: .leading, spacing: 8) {
          Text("\(fileEvents.count) file change\(fileEvents.count == 1 ? "" : "s")")
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .junoSecondaryInk()
          ForEach(fileEvents) { event in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                  if let info = event.fileChangeInfo {
                    JunoStatusPill(
                      text: info.changeKind.prefix(1).uppercased(),
                      tint: info.changeKind == "deleted" ? Color.junoDanger : Color.junoAccent
                    )
                    Text(info.path)
                      .junoFont(size: 13, relativeTo: .footnote, design: .monospaced)
                      .lineLimit(1)
                    Spacer(minLength: 4)
                    Text("+\(info.linesAdded) −\(info.linesRemoved)")
                      .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                      .foregroundStyle(Color.junoSuccess)
                  } else {
                    JunoIconView(.file, size: 13)
                      .junoSecondaryInk()
                    Text(event.title)
                      .junoFont(size: 13, relativeTo: .footnote, design: .monospaced)
                      .lineLimit(1)
                    Spacer(minLength: 4)
                    if let detail = event.detail, !detail.isEmpty {
                      Text(detail)
                        .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
                        .foregroundStyle(Color.junoSuccess)
                    }
                  }
                }
                if let diff = event.fileChangeInfo?.diff, !diff.isEmpty {
                  Text(diff)
                    .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                    .junoSecondaryInk()
                    .lineLimit(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(
                      RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.junoMuted.opacity(0.4))
                    )
                }
              }
            }
          }
        }
      }
    }
  }

  private var terminalContent: some View {
    let toolEvents = model.events.filter { $0.kind == .tool }
    return Group {
      if toolEvents.isEmpty {
        ContentUnavailableView {
          Label {
            Text("Terminal Idle")
          } icon: {
            JunoIconView(.terminal, size: 30)
          }
        } description: {
          Text("Commands executed by the agent will stream here.")
        }
        .padding(.vertical, 24)
      } else {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(toolEvents) { event in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                  JunoIconView(.terminal, size: 12)
                    .foregroundStyle(Color.junoAccent)
                  Text(event.title)
                    .junoFont(
                      size: 12, relativeTo: .caption, weight: .semibold, design: .monospaced
                    )
                    .lineLimit(1)
                  Spacer(minLength: 4)
                  if let code = event.exitCode {
                    JunoStatusPill(
                      text: "exit \(code)",
                      tint: code == 0 ? Color.junoSuccess : Color.junoDanger
                    )
                  }
                }
                if let detail = event.detail, !detail.isEmpty {
                  Text(detail)
                    .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                    .junoSecondaryInk()
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(
                      RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.junoMuted.opacity(0.5))
                    )
                }
              }
            }
          }
        }
      }
    }
  }

  private var testsContent: some View {
    let testSummaries = model.events.compactMap { $0.testSummary }
    return Group {
      if testSummaries.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Tests Executed")
          } icon: {
            JunoIconView(.check, size: 30)
          }
        } description: {
          Text("Structured test suite executions and pass/fail metrics will appear here.")
        }
        .padding(.vertical, 24)
      } else {
        let totalRun = testSummaries.compactMap(\.testsRun).reduce(0, +)
        let totalPassed = testSummaries.compactMap(\.passed).reduce(0, +)
        let totalFailed = testSummaries.compactMap(\.failed).reduce(0, +)
        let totalSkipped = testSummaries.compactMap(\.skipped).reduce(0, +)

        VStack(alignment: .leading, spacing: 10) {
          JunoCard(padding: 12) {
            HStack(spacing: 16) {
              VStack(alignment: .leading, spacing: 2) {
                Text("Total Tests")
                  .junoFont(size: 11, relativeTo: .caption2)
                  .junoMetaInk()
                Text("\(totalRun > 0 ? totalRun : testSummaries.count)")
                  .junoFont(size: 18, relativeTo: .title3, weight: .bold)
              }
              if totalPassed > 0 {
                VStack(alignment: .leading, spacing: 2) {
                  Text("Passed")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoMetaInk()
                  Text("\(totalPassed)")
                    .junoFont(size: 18, relativeTo: .title3, weight: .bold)
                    .foregroundStyle(Color.junoSuccess)
                }
              }
              if totalFailed > 0 {
                VStack(alignment: .leading, spacing: 2) {
                  Text("Failed")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoMetaInk()
                  Text("\(totalFailed)")
                    .junoFont(size: 18, relativeTo: .title3, weight: .bold)
                    .foregroundStyle(Color.junoDanger)
                }
              }
              if totalSkipped > 0 {
                VStack(alignment: .leading, spacing: 2) {
                  Text("Skipped")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoMetaInk()
                  Text("\(totalSkipped)")
                    .junoFont(size: 18, relativeTo: .title3, weight: .bold)
                    .junoSecondaryInk()
                }
              }
              Spacer(minLength: 0)
            }
          }
          ForEach(Array(testSummaries.enumerated()), id: \.offset) { _, summary in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                  switch summary.status {
                  case .passed:
                    JunoIconView(.check, size: 13)
                      .foregroundStyle(Color.junoSuccess)
                  case .failed:
                    JunoIconView(.error, size: 13)
                      .foregroundStyle(Color.junoDanger)
                  case .running:
                    JunoIconView(.refresh, size: 13)
                      .foregroundStyle(Color.junoAccent)
                  case .skipped:
                    JunoIconView(.close, size: 13)
                      .junoSecondaryInk()
                  case .cancelled:
                    JunoIconView(.stop, size: 13)
                      .junoSecondaryInk()
                  case .unknown:
                    JunoIconView(.error, size: 13)
                      .junoMetaInk()
                  }
                  Text(summary.suite ?? summary.framework ?? "Test Suite")
                    .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
                    .lineLimit(1)
                  Spacer(minLength: 4)
                  if summary.status == .unknown {
                    JunoStatusPill(text: "UNKNOWN", tint: Color.junoMutedForeground)
                  }
                  if let duration = summary.durationSeconds {
                    Text(String(format: "%.2fs", duration))
                      .junoFont(size: 11, relativeTo: .caption2)
                      .junoMetaInk()
                  }
                }
                if let failure = summary.failureDetail, !failure.isEmpty {
                  Text(failure)
                    .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                    .foregroundStyle(Color.junoDanger)
                    .lineLimit(4)
                }
              }
            }
          }
        }
      }
    }
  }

  private var previewContent: some View {
    let previewEvents = model.events.compactMap { $0.previewInfo }
    return Group {
      if previewEvents.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Preview Available")
          } icon: {
            JunoIconView(.web, size: 30)
          }
        } description: {
          Text(
            "Visual verification frames, WebKit screenshots, and web preview diagnostics will appear here."
          )
        }
        .padding(.vertical, 24)
      } else {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(previewEvents.enumerated()), id: \.offset) { _, info in
            JunoCard(padding: 14) {
              VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                  JunoIconView(.web, size: 14)
                    .foregroundStyle(Color.junoAccent)
                  Text(info.url ?? "Web Preview")
                    .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
                    .lineLimit(1)
                  Spacer(minLength: 4)
                  JunoStatusPill(
                    text: info.status,
                    tint: info.status == "ready" ? Color.junoSuccess : Color.junoAccent
                  )
                }
                if let diagnostic = info.diagnostic, !diagnostic.isEmpty {
                  Text(diagnostic)
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoSecondaryInk()
                }
                if let screenshot = info.screenshotURL, let url = URL(string: screenshot) {
                  AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                      image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                          RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Color.junoBorder, lineWidth: 1)
                        )
                    case .failure:
                      HStack(spacing: 6) {
                        JunoIconView(.error, size: 13)
                        Text("Could not load preview screenshot")
                      }
                      .junoFont(size: 12, relativeTo: .caption)
                      .junoMetaInk()
                      .padding(12)
                    case .empty:
                      ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                    @unknown default:
                      EmptyView()
                    }
                  }
                  Link(destination: url) {
                    HStack(spacing: 6) {
                      JunoIconView(.external, size: 13)
                      Text("Open Full Visual Evidence")
                    }
                    .junoFont(size: 12, relativeTo: .caption, weight: .medium)
                    .foregroundStyle(Color.junoAccent)
                    .frame(minHeight: 36)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private var agentsContent: some View {
    let agents = model.events.compactMap { $0.agentInfo }
    return Group {
      if agents.isEmpty {
        ContentUnavailableView {
          Label {
            Text("No Delegated Agents")
          } icon: {
            JunoIconView(.user, size: 30)
          }
        } description: {
          Text(
            "This run executed directly on the primary host runner without subagent delegations.")
        }
        .padding(.vertical, 24)
      } else {
        VStack(alignment: .leading, spacing: 10) {
          Text("\(agents.count) Delegated Agent\(agents.count == 1 ? "" : "s")")
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .junoSecondaryInk()
          ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                  JunoIconView(.user, size: 13)
                    .foregroundStyle(Color.junoAccent)
                  Text(agent.title ?? agent.role)
                    .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
                  Spacer(minLength: 4)
                  JunoStatusPill(
                    text: agent.status,
                    tint: agent.status == "completed"
                      ? Color.junoSuccess
                      : (agent.status == "failed" ? Color.junoDanger : Color.junoAccent)
                  )
                }
                if let model = agent.model {
                  Text(model)
                    .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                    .junoMetaInk()
                }
                if let summary = agent.summary, !summary.isEmpty {
                  Text(summary)
                    .junoFont(size: 12, relativeTo: .caption)
                    .junoSecondaryInk()
                }
              }
            }
          }
        }
      }
    }
  }

  private var gitContent: some View {
    guard let task = model.openTask else { return AnyView(EmptyView()) }
    return AnyView(
      VStack(alignment: .leading, spacing: 10) {
        JunoCard(padding: 14) {
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
              JunoIconView(.branch, size: 14)
                .junoSecondaryInk()
              Text("Branch / Target")
                .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
              Spacer(minLength: 4)
              if let branch = task.baseRef ?? task.repoName {
                Text(branch)
                  .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
                  .junoMetaInk()
              }
            }
            Divider()
            HStack(spacing: 8) {
              Text("Location")
                .junoFont(size: 12, relativeTo: .caption)
                .junoMetaInk()
              Spacer(minLength: 4)
              Text(task.whereItRuns)
                .junoFont(size: 12, relativeTo: .caption, weight: .medium)
            }
            if let pr = task.pullRequestURL {
              Divider()
              Link(destination: pr) {
                HStack(spacing: 8) {
                  JunoIconView(.pulls, size: 14)
                  Text("code.open-pull-request")
                    .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
                  Spacer(minLength: 4)
                  JunoIconView(.external, size: 11)
                }
                .foregroundStyle(Color.junoAccent)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
              }
            }
          }
        }
      }
    )
  }

  private func summary(_ task: NativeCodeTask) -> some View {
    JunoCard(padding: 14) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          JunoIconView(task.target == .cloud ? .cloud : .device, size: 12)
            .junoSecondaryInk()
          Text(task.whereItRuns)
            .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
            .junoMetaInk()
            .lineLimit(1)
          Spacer(minLength: 4)
          JunoStatusPill(
            text: junoCodeStatusText(task.status),
            tint: junoCodeStatusTint(task.status)
          )
        }
        // Where the run has got to, as text that survives a still frame.
        //
        // This corner used to hold a bare `ProgressView`, which is the
        // one thing a supervision screen must not do: a spinner spins
        // identically whether the agent is working or wedged, so the only
        // signal on the page informed nobody. Status, how long it has
        // been going and the last thing it actually did are three facts
        // that read the same in a screenshot as they do live.
        Text(progressLine(task))
          .junoCaption()
          .lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
        if !task.prompt.isEmpty {
          Text(task.prompt)
            .font(.callout)
            .junoSecondaryInk()
            .lineLimit(6)
        }
        if let url = task.pullRequestURL {
          Link(destination: url) {
            JunoIconLabel("code.open-pull-request", icon: .pulls, size: 14)
              .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
          }
          .foregroundStyle(Color.junoAccent)
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
      }
    }
  }

  /// "Started 4 minutes ago · Reading the settings store" while a run is live,
  /// and "Started 6 hours ago · Stopped 5 hours ago" once it is not.
  ///
  /// The second half changes with the first because the useful fact changes:
  /// on a live run it is what the agent last did, and on a finished one it is
  /// when it stopped — repeating the last log line there just says the bottom
  /// of the log twice.
  ///
  /// "Reconnecting…" displaces the last action, because a log that stopped
  /// growing because the connection dropped looks exactly like a log that
  /// stopped growing because the agent is thinking.
  private func progressLine(_ task: NativeCodeTask) -> String {
    let started = task.createdAt.formatted(.relative(presentation: .named))
    var line = String(localized: "code.session.started", defaultValue: "Started \(started)")
    if task.status.isTerminal {
      let stopped = task.updatedAt.formatted(.relative(presentation: .named))
      line +=
        " · "
        + String(
          localized: "code.session.stopped", defaultValue: "stopped \(stopped)"
        )
    } else if model.streamReconnectAttempt > 0 {
      line +=
        " · "
        + String(
          localized: "code.session.reconnecting", defaultValue: "Reconnecting…"
        )
    } else if let last = model.events.last?.title, !last.isEmpty {
      line += " · " + last
    }
    return line
  }

  /// Everything the reader can say to this run, on **one** pane of glass.
  ///
  /// The approval card and the follow-up composer are one surface rather than
  /// two stacked cards, and the reason is a rule about the material: a screen
  /// gets a single Liquid Glass layer over opaque content. Two glass platters
  /// in the same safe-area inset would each be sampling the other, which is how
  /// both lose their lensing and collapse into a pair of grey slabs.
  ///
  /// The approval half sits on top because the agent is *blocked* on it — an
  /// answer buried in the scrollback leaves a run stalled with no visible
  /// reason — and the composer under it, where the keyboard expects it.
  private var footer: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let approval = model.pendingApproval {
        approvalPanel(approval)
        Divider()
      }
      followUpComposer
    }
    .padding(14)
    .background(JunoGlassBackground(cornerRadius: 22))
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
    .animation(
      JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
      value: model.pendingApproval
    )
  }

  /// A second message to a session that already exists.
  ///
  /// Before this there was none: the bottom of this screen held the approval
  /// card and nothing else, so the only thing a reader could say to a run they
  /// had started from their phone was yes or no. Anything else meant starting a
  /// *new* session, which throws away the conversation the first one is
  /// attached to.
  ///
  /// A follow-up is a fresh execution inside the same durable Code
  /// conversation, so it can only be sent once the current one has stopped —
  /// the field says so plainly rather than accepting a message it would have to
  /// drop.
  private var followUpComposer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let blocked = followUpBlockedReason {
        Text(blocked)
          .junoCaption()
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField(
          String(
            localized: "code.followup.placeholder",
            defaultValue: "Reply to this session"
          ),
          text: $followUp,
          axis: .vertical
        )
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        .focused($followUpFocused)
        .disabled(followUpBlockedReason != nil)
        .frame(minHeight: 44)
        .accessibilityIdentifier("juno.mobile.code-followup")
        Button {
          sendFollowUp()
        } label: {
          JunoIconView(.send, size: 16)
            .foregroundStyle(
              canSendFollowUp ? Color.junoOnAccent : Color.junoMutedForeground
            )
            .frame(width: 34, height: 34)
            .modifier(JunoComposerSendBackground(active: canSendFollowUp))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canSendFollowUp)
        .accessibilityLabel(
          Text(String(localized: "code.followup.send", defaultValue: "Send follow-up"))
        )
        .accessibilityIdentifier("juno.mobile.code-followup-send")
      }
    }
    .animation(
      JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
      value: canSendFollowUp
    )
  }

  /// Why a follow-up cannot be sent right now, in the reader's terms.
  ///
  /// Two honest reasons and no third: the run has not finished, or it predates
  /// server-side Code conversations and has nothing to continue into. Both are
  /// facts about the task rather than about this screen, which is why neither
  /// is phrased as an apology or offered a retry.
  private var followUpBlockedReason: String? {
    guard let task = model.openTask else { return nil }
    if !task.status.isTerminal {
      return String(
        localized: "code.followup.blocked.active",
        defaultValue: "Juno is still working. You can reply once this run stops."
      )
    }
    if task.conversationID == nil {
      return String(
        localized: "code.followup.blocked.unlinked",
        defaultValue: "This run is not linked to a Code conversation, so it cannot be continued."
      )
    }
    return nil
  }

  private var canSendFollowUp: Bool {
    !followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && followUpBlockedReason == nil
      && !model.isMutating
  }

  /// Sends, and clears only on success. A field emptied by a request that
  /// failed loses the reader's words with no way back.
  private func sendFollowUp() {
    let text = followUp
    Task {
      if await model.sendFollowUp(prompt: text) != nil {
        followUp = ""
        followUpFocused = false
      }
    }
  }

  private func approvalPanel(_ approval: NativeCodeApproval) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Label {
          Text("code.approval.title")
        } icon: {
          JunoIconView(.permission, size: 15)
        }
        .junoFont(size: 15, relativeTo: .subheadline, weight: .semibold)
        .foregroundStyle(Color.junoCaution)
        Spacer(minLength: 4)
        JunoStatusPill(
          text: approval.risk.uppercased(),
          tint: (approval.risk == "high" || approval.risk == "destructive")
            ? Color.junoDanger : Color.junoCaution
        )
      }
      Text(approval.summary)
        .font(.callout)
        .junoInk()
        .frame(maxWidth: .infinity, alignment: .leading)
      if let detail = approval.detail, !detail.isEmpty {
        Text(detail)
          .junoCaption()
          .lineLimit(4)
      }
      // Neither of these is glass, and the panel behind them is why.
      // The footer carries `JunoGlassBackground`, so a glass capsule
      // sat inside it had nothing to refract but the pane it was
      // already standing on: glass cannot sample glass, and the result
      // is that *both* surfaces collapse to a flat translucent wash and
      // lose their lensing. The system's bordered pair is the correct
      // vocabulary on a glass platter, and the explicit tint keeps
      // Allow on Juno's accent instead of the device's.
      HStack(spacing: 10) {
        Button {
          Task { await model.respondToApproval(approve: false) }
        } label: {
          Text("code.approval.deny")
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        }
        // Neutral, explicitly. `.bordered` inherits the app tint, so
        // Deny drew in coral beside a coral Allow and the pane had two
        // accented actions competing to be the obvious one — on the
        // single control in the product that stops an agent from
        // touching somebody's files. One tinted action per surface.
        .buttonStyle(.bordered)
        .tint(Color.junoMutedForeground)
        .foregroundStyle(.primary)
        .controlSize(.large)
        .contentShape(.rect)
        Button {
          Task { await model.respondToApproval(approve: true) }
        } label: {
          Text("code.approval.allow")
            .fontWeight(.semibold)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .controlSize(.large)
        .accessibilityIdentifier("juno.mobile.code-approve")
        .contentShape(.rect)
      }
    }
    .transition(.move(edge: .bottom).combined(with: .opacity))
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
      .foregroundStyle(Color.junoCaution)
      .frame(maxWidth: .infinity, alignment: .leading)
    case .status, .done, .cancelRequest:
      Text(event.title)
        .font(.caption)
        .junoMetaInk()
        .frame(maxWidth: .infinity, alignment: .leading)
    default:
      HStack(alignment: .top, spacing: 8) {
        Group {
          JunoIconView(symbol, size: 12)
        }
        .junoSecondaryInk()
        .frame(width: 14)
        .padding(.top, 2)
        VStack(alignment: .leading, spacing: 1) {
          // The code face only where the content is code. A file
          // change is a path and a line count and belongs in it; a
          // tool call's summary and a sub-agent's status line are
          // sentences, and setting those in monospace is what made an
          // ordinary run read as a terminal dump.
          Text(event.title)
            .junoFont(size: 13, relativeTo: .footnote, design: design)
            .lineLimit(2)
          if let detail = event.detail, !detail.isEmpty {
            Text(detail)
              .junoFont(size: 12, relativeTo: .caption, design: design)
              .junoSecondaryInk()
              .lineLimit(2)
          }
        }
        Spacer(minLength: 0)
      }
      .accessibilityElement(children: .combine)
    }
  }

  /// Monospace for the rows that carry a path, and the UI face for the rest.
  private var design: Font.Design {
    switch event.kind {
    case .fileChange, .acceptChange, .rejectChange, .rollbackResult: .monospaced
    default: .default
    }
  }

  private var symbol: JunoIcon {
    switch event.kind {
    case .tool: .tools
    case .fileChange: .file
    case .approvalRequest: .permission
    case .approvalResponse: .check
    case .agent: .user
    default: .refresh
    }
  }
}
