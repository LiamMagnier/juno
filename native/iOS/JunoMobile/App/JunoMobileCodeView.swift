import JunoAuth
import JunoChatKit
import JunoCodeCore
import JunoCodeKit
import JunoCodeRemote
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoVoiceKit
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
  /// The phone's trusted-host session coordinator. The initial integration
  /// keeps it architectural; a remote browser surface consumes this instead of
  /// creating another relay client when the mobile Code flow is expanded.
  var remoteModel: CodeRemoteBrowserModel? = nil
  /// The v2 remote (docs/code-v2/REMOTE-CONTROL.md) for Macs paired with this
  /// iPhone. Nil builds the app's one from `requestSender`; the snapshot tests
  /// hand in a filled one.
  var linkModelOverride: CodeLinkRemoteModel? = nil
  @Environment(\.scenePhase) private var scenePhase
  /// Local notifications for approvals. Nil in the harness.
  var notifications: JunoMobileCodeNotifications? = nil
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
  /// Opens Work's sessions, which live under Code's menu on the phone.
  var openWork: (() -> Void)? = nil

  @State private var prompt = ""
  @State private var showingPulls = false
  @State private var showingUsage = false
  @State private var showingDevices = false
  /// The scope (All, Cloud, a computer) and, in All, where the dock starts work.
  @AppStorage(JunoMobilePreferences.codeScope) private var scopeStored = "all"
  @AppStorage(JunoMobilePreferences.codeLastTarget) private var lastTargetStored = ""
  @AppStorage(JunoMobilePreferences.codeDefaultHost) private var defaultHostID = ""
  @State private var searching = false
  @State private var query = ""
  /// The cloud composer, unfolded from the dock in place.
  @State private var cloudComposerOpen = false
  @State private var cloudDictate = false
  /// The dock's microphone opened a session on a Mac: its composer dictates.
  @State private var linkDictate = false
  /// The home's camera, photos and files, for the dock's "+".
  @State private var homeAttachments = JunoMobileAttachmentCoordinator()
  @Environment(\.junoThreadSync) private var threadSync
  /// Opens on this scope: the offscreen snapshots only.
  var previewScope: JunoMobileCodeScope? = nil
  @Namespace private var zoom
  @FocusState private var composerFocused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Opens the start composer dictating: the offscreen snapshots only.
  var previewDictation: JunoMobileDictationSession? = nil
  /// Opens the start composer with this typed: the offscreen snapshots only.
  var previewPrompt: String? = nil
  /// The mode the next cloud run starts on, remembered per repository.
  @State private var startMode: CodeComposerModeLadder = .full
  @Environment(\.junoStartCodeVoice) private var startCodeVoice
  @Environment(\.junoCodeVoiceSession) private var codeVoice

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
              .controlSize(.large)
              .contentShape(.rect)
          }
        }
      case .ready:
        sessions
      }
    }
    .background(Color.junoCanvas)
    .navigationTitle("navigation.code")
    // Inline: on the phone the bar's centre is Chat | Code, and a large
    // title would only leave an empty band above the list.
    .navigationBarTitleDisplayMode(.inline)
    // One trailing item, as Codex's home: search. Everything else is the
    // "…" at the end of the scope row.
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          searching.toggle()
          if !searching { query = "" }
        } label: {
          JunoIconView(searching ? .close : .search, size: 18)
            .foregroundStyle(Color.primary)
        }
        .accessibilityLabel(searching ? "Close search" : "Search sessions")
        .accessibilityIdentifier("juno.mobile.code-search")
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
    .navigationDestination(
      isPresented: Binding(
        get: { model.openTask != nil },
        set: { if !$0 { model.closeOpenTask() } }
      )
    ) {
      JunoMobileCodeSessionView(model: model)
        .environment(\.junoCodeVoiceSession, codeVoice)
        .environment(\.junoStartCodeVoice, startCodeVoice)
    }
    // The remote thread. Pushed the moment the session summary is known —
    // which for a notification tap or a preview flag can be a beat after the
    // id is set, once the host's list arrives.
    .navigationDestination(
      item: Binding(
        get: { remoteModel?.openSession },
        set: { if $0 == nil { remoteModel?.closeSession() } }
      )
    ) { session in
      if let remoteModel {
        JunoMobileCodeRemoteThreadView(
          model: remoteModel, session: session, modelCatalog: modelCatalog
        )
        .environment(\.junoCodeVoiceSession, codeVoice)
        .environment(\.junoStartCodeVoice, startCodeVoice)
        .modifier(JunoMobileZoomTransitionSource(id: session.sessionID, namespace: zoom))
      }
    }
    .navigationDestination(isPresented: $showingDevices) {
      JunoMobileCodeDevicesView(remoteModel: remoteModel)
    }
    // A session on a Mac paired over the device link: a live one, or the
    // empty thread a new one starts from (the same screen, so the first
    // message turns it into the thread without a swap).
    .navigationDestination(
      isPresented: Binding(
        get: { linkModel?.showsThread == true },
        set: { if !$0 { linkModel?.close(); linkDictate = false } }
      )
    ) {
      if let linkModel {
        JunoMobileLinkThreadView(model: linkModel, dictateOnAppear: linkDictate, chatModels: modelCatalog)
          .environment(\.junoCodeVoiceSession, codeVoice)
          .environment(\.junoStartCodeVoice, startCodeVoice)
      }
    }
    // Asked here, on first use of Code, rather than at launch — see
    // `JunoMobileCodeNotifications`.
    .task { await notifications?.requestPermissionIfNeeded() }
    .accessibilityIdentifier("juno.mobile.code")
  }

  // MARK: Home: scopes, Recents, the dock

  private var linkModel: CodeLinkRemoteModel? {
    linkModelOverride ?? JunoMobileLinkModels.model(for: requestSender)
  }

  private var scope: JunoMobileCodeScope {
    if let previewScope { return previewScope }
    guard let stored = JunoMobileCodeScope(stored: scopeStored) else { return .all }
    if let id = stored.deviceID, !scopeDevices.contains(where: { $0.id == id }) { return .all }
    return stored
  }

  private var scopeBinding: Binding<JunoMobileCodeScope> {
    Binding(get: { scope }, set: { choose(scope: $0) })
  }

  /// Paired Macs first (they take new sessions), then other signed-in
  /// computers that can only be watched.
  private var scopeDevices: [JunoMobileCodeScopeDevice] {
    var out: [JunoMobileCodeScopeDevice] = (linkModel?.macs ?? []).map { mac in
      let reachable: Bool
      switch mac.reachability {
      case .online, .unknown: reachable = true
      case .offline, .notPaired: reachable = false
      }
      return JunoMobileCodeScopeDevice(
        id: mac.id, name: mac.name, reachable: reachable,
        working: linkModel?.isWorking(mac.id) ?? false, paired: true
      )
    }
    for host in remoteModel?.hosts ?? [] where !out.contains(where: { $0.id == host.id }) {
      let sessions = remoteModel?.sessionsByDevice[host.id] ?? []
      out.append(JunoMobileCodeScopeDevice(
        id: host.id, name: host.name, reachable: host.online,
        working: sessions.contains { $0.isRunning || $0.isAwaitingApproval }, paired: false,
        icon: host.platform == "windows" ? .monitor : .device
      ))
    }
    return out
  }

  /// Where the dock starts work: the scope, or in All the last target.
  private var target: JunoMobileCodeTarget {
    switch scope {
    case .cloud: return .cloud
    case .device(let id): return .device(id)
    case .all:
      if let last = JunoMobileCodeTarget(stored: lastTargetStored) {
        if case .device(let id) = last, !scopeDevices.contains(where: { $0.id == id && $0.paired }) {
          return defaultTarget
        }
        return last
      }
      return defaultTarget
    }
  }

  /// The settings' default computer when paired, else the first paired Mac, else Cloud.
  private var defaultTarget: JunoMobileCodeTarget {
    let paired = scopeDevices.filter(\.paired)
    if let chosen = paired.first(where: { $0.id == defaultHostID }) ?? paired.first { return .device(chosen.id) }
    return .cloud
  }

  /// Every session the home knows of, as Recents rows.
  private var recents: [JunoMobileCodeRecent] {
    var rows: [JunoMobileCodeRecent] = model.tasks.map { task in
      JunoMobileCodeRecent(
        source: .cloud(taskID: task.id, deviceID: task.target == .cloud ? nil : task.deviceID),
        title: task.title,
        place: task.target == .cloud ? "Cloud" : (scopeDevices.first { $0.id == task.deviceID }?.name ?? task.whereItRuns),
        date: task.updatedAt,
        status: CodeLinkSessionStatus(cloud: task.status)
      )
    }
    if let linkModel {
      for mac in linkModel.macs {
        for session in linkModel.sessions(on: mac.id) {
          rows.append(JunoMobileCodeRecent(
            source: .link(deviceID: mac.id, session: session),
            title: session.title ?? "Untitled session",
            place: mac.name,
            date: CodeV2Dates.parse(session.updatedAt) ?? .distantPast,
            status: linkStatus(session, on: mac.id)
          ))
        }
      }
    }
    for device in scopeDevices where !device.paired {
      for session in remoteModel?.sessionsByDevice[device.id] ?? [] {
        rows.append(JunoMobileCodeRecent(
          source: .relay(deviceID: device.id, sessionID: session.sessionID),
          title: session.title,
          place: device.name,
          date: session.updatedAt,
          status: CodeLinkSessionStatus(relay: session)
        ))
      }
    }
    return rows
  }

  /// The live state, or the backend's needs-you for a session not opened here.
  private func linkStatus(_ session: CodeV2.SessionSummary, on deviceID: String) -> CodeLinkSessionStatus {
    let live = linkModel?.status(of: session, on: deviceID) ?? CodeLinkSessionStatus(state: session.state)
    if live.isLive { return live }
    if threadSync?.states[ThreadSyncKey.code(deviceID: deviceID, sessionID: session.id)]?.needsYou == true { return .needsYou }
    return live
  }

  /// The scope's computer when this iPhone cannot start sessions on it.
  private var unpairedScopeDevice: JunoMobileCodeScopeDevice? {
    guard let id = scope.deviceID else { return nil }
    if let device = scopeDevices.first(where: { $0.id == id }), !device.paired { return device }
    if case .notPaired? = linkModel?.macs.first(where: { $0.id == id })?.reachability {
      return scopeDevices.first { $0.id == id }
    }
    return nil
  }

  private var emptyLine: String {
    switch scope {
    case .all: "No sessions yet. Ask Alevr below to start one."
    case .cloud: "No cloud sessions yet. Ask Alevr below to start one in a repository."
    case .device(let id): "Nothing on \(scopeDevices.first { $0.id == id }?.name ?? "this computer") yet. Ask Alevr below to start a session there."
    }
  }

  private var sessions: some View {
    VStack(spacing: 0) {
      JunoMobileCodeScopeBar(
        scope: scopeBinding,
        devices: scopeDevices,
        cloudWorking: model.tasks.contains { $0.status.isActive && $0.target == .cloud },
        onPair: junoMobileRequestPairing
      ) {
        overflowMenu
      }
      .padding(.top, JunoSpace.hairline)

      JunoMobileCodeRecentsList(
        rows: JunoMobileCodeRecent.visible(recents, scope: scope, query: searching ? query : ""),
        loading: recents.isEmpty && (model.phase == .loading || (linkModel?.isLoadingSessions ?? false)),
        emptyLine: emptyLine,
        query: $query,
        searching: searching,
        hasLeading: showsListLead,
        compose: { openComposer(dictate: false) },
        open: open,
        stop: stop,
        refresh: refreshAll
      ) {
        if let error = model.lastErrorDescription, scope == .cloud || scope == .all, model.tasks.isEmpty {
          JunoInlineError(message: error) { Task { await model.refresh() } }
        }
        if let device = unpairedScopeDevice {
          JunoMobileCodePairLine(name: device.name)
        } else if let id = scope.deviceID, case .offline? = linkModel?.macs.first(where: { $0.id == id })?.reachability {
          JunoMobileLinkNotice(icon: .wifiOff, text: "\(scopeDevices.first { $0.id == id }?.name ?? "This Mac") is offline. Open Alevr on it to reach it.")
        }
      }
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: scope)
      // The composer floats over the list, which scrolls under its glass and
      // fades softly at the foot: no slab behind it.
      .scrollEdgeEffectStyle(.soft, for: .top)
      .modifier(JunoMobileSoftBottomEdge())
      .safeAreaInset(edge: .bottom, spacing: 0) { bottomComposer }
    }
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: cloudComposerOpen)
    // Files picked from the dock go with the next session on the Mac, which
    // opens with them already in its composer.
    .junoAttachmentSurfaces(
      coordinator: homeAttachments,
      capacity: CodeLinkRemoteModel.maxAttachments - (linkModel?.draftAttachments.count ?? 0)
    ) { files in
      guard let linkModel else { return }
      linkModel.attach(files.map(CodeLinkDraftAttachment.init))
      openComposer(dictate: false, keepAttachments: true)
    }
    .onChange(of: composerFocused) { _, focused in
      // The cloud composer folds back into the dock when it is left empty.
      if !focused, prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, codeVoice == nil {
        cloudComposerOpen = false
      }
    }
    .onAppear {
      if let previewPrompt {
        prompt = previewPrompt
        cloudComposerOpen = true
      }
      if previewDictation != nil { cloudComposerOpen = true }
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      if linkModelOverride == nil { linkModel?.setSubscriptionRefreshActive(phase == .active) }
    }
    .onDisappear { if linkModelOverride == nil { linkModel?.setSubscriptionRefreshActive(false) } }
    .task(id: accountID) {
      // Remote state is account-scoped. Starting it here rather than at app
      // launch avoids retaining another account's trusted-host inventory after
      // sign-out/sign-in, while the model itself owns clearing on `stop()`.
      if let accountID {
        remoteModel?.start(for: accountID)
        remoteModel?.updateHosts(from: model.devices)
        if let linkModel, linkModelOverride == nil {
          linkModel.start(for: accountID)
          await linkModel.refreshMacs()
          if let id = scope.deviceID, linkModel.macs.contains(where: { $0.id == id }) {
            await linkModel.select(id)
          } else if let id = linkModel.selectedDeviceID {
            await linkModel.select(id)
          }
          await linkModel.refreshAllSessions()
          linkModel.setSubscriptionRefreshActive(scenePhase == .active)
        }
        await remoteModel?.refreshAllSessions()
      } else {
        remoteModel?.stop()
        if linkModelOverride == nil { linkModel?.stop() }
      }
    }
    // The device link streams for the selected Mac (and its thread on top).
    .task(id: linkModelOverride == nil ? linkModel?.selectedDeviceID : nil) {
      guard linkModelOverride == nil, let linkModel, linkModel.selectedDeviceID != nil else { return }
      await linkModel.runLink()
    }
    // The other Macs and the watched computers, every 20 seconds while the
    // home is up: enough to know which one is working and what needs you.
    .task(id: linkModelOverride == nil ? accountID : nil) {
      guard accountID != nil, linkModelOverride == nil else { return }
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(20))
        guard !Task.isCancelled else { return }
        await linkModel?.refreshAllSessions()
        await remoteModel?.refreshAllSessions()
      }
    }
    // A notification or Handoff named a session on a paired Mac.
    .onChange(of: JunoMobileRemoteRouting.shared.linkSession, initial: true) { _, request in
      guard let request, let linkModel else { return }
      JunoMobileRemoteRouting.shared.linkSession = nil
      Task { await linkModel.openRouted(deviceID: request.deviceID, sessionID: request.sessionID) }
    }
    .onChange(of: JunoMobileRemoteRouting.shared.linkApproval, initial: true) { _, request in
      guard let request, let linkModel else { return }
      JunoMobileRemoteRouting.shared.linkApproval = nil
      Task {
        await linkModel.answerRouted(
          deviceID: request.deviceID, sessionID: request.sessionID, requestID: request.requestID, approved: request.approved
        )
      }
    }
    .onChange(of: model.devices) { _, devices in
      remoteModel?.updateHosts(from: devices)
    }
  }

  /// An error, a pairing line or an offline notice above Recents.
  private var showsListLead: Bool {
    if model.lastErrorDescription != nil, scope == .cloud || scope == .all, model.tasks.isEmpty { return true }
    if unpairedScopeDevice != nil { return true }
    if let id = scope.deviceID, case .offline? = linkModel?.macs.first(where: { $0.id == id })?.reachability { return true }
    return false
  }

  /// The foot of the home: the cloud composer unfolded in place, or the dock.
  @ViewBuilder
  private var bottomComposer: some View {
    if cloudComposerOpen {
      composer
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    } else if unpairedScopeDevice == nil {
      JunoMobileCodeDock(
        target: target,
        devices: scopeDevices.filter(\.paired),
        showsTarget: scope == .all,
        attachments: homeAttachments,
        canAttach: dockCanAttach,
        attachNote: target == .cloud ? "Cloud sessions take text for now. Attach files to a session on your Mac." : nil,
        choose: { lastTargetStored = $0.stored },
        open: { openComposer(dictate: $0) }
      )
      .transition(.opacity)
    }
  }

  private var dockCanAttach: Bool {
    guard target != .cloud, let linkModel else { return false }
    return linkModel.canAttachMore
  }

  /// Everything that is not the list: pull requests, Work, usage, pairing, settings.
  private var overflowMenu: some View {
    Menu {
      if pullsClient != nil {
        Button {
          showingPulls = true
        } label: {
          Label("Pull requests", image: JunoIcon.pulls.assetName(.regular))
        }
        .accessibilityIdentifier("juno.mobile.code.pulls")
      }
      if let openWork {
        Button(action: openWork) {
          Label("Work sessions", image: JunoIcon.listChecks.assetName(.regular))
        }
      }
      if session != nil {
        Button {
          showingUsage = true
        } label: {
          Label("Your usage", image: JunoIcon.usage.assetName(.regular))
        }
      }
      Section {
        Button(action: junoMobileRequestPairing) {
          Label("Pair a Mac", image: JunoIcon.scan.assetName(.regular))
        }
        .accessibilityIdentifier("juno.mobile.code-pair")
        if remoteModel != nil {
          Button {
            showingDevices = true
          } label: {
            Label("Paired computers", image: JunoIcon.device.assetName(.regular))
          }
        }
        if let openSettings {
          Button(action: openSettings) {
            Label("navigation.settings", image: JunoIcon.settings.assetName(.regular))
          }
        }
      }
    } label: {
      JunoIconView(.ellipsis, size: 17)
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .tint(Color.primary)
    .accessibilityLabel("More")
    .accessibilityIdentifier("juno.mobile.code.account")
  }

  private func choose(scope next: JunoMobileCodeScope) {
    scopeStored = next.stored
    cloudComposerOpen = false
    if case .device(let id) = next, let linkModel, linkModel.macs.contains(where: { $0.id == id }) {
      lastTargetStored = JunoMobileCodeTarget.device(id).stored
      Task { await linkModel.select(id) }
    } else if case .device(let id) = next, let remoteModel {
      Task { await remoteModel.loadSessions(deviceID: id) }
    } else if next == .cloud {
      lastTargetStored = JunoMobileCodeTarget.cloud.stored
    }
  }

  /// Opens the full composer where the target lives: the empty thread on a
  /// paired Mac, the cloud composer in place.
  private func openComposer(dictate: Bool, keepAttachments: Bool = false) {
    switch target {
    case .cloud:
      model.isTargetless = false
      model.target = .cloud
      model.loadRepositoriesIfNeeded()
      cloudDictate = dictate
      cloudComposerOpen = true
      if !dictate {
        Task {
          try? await Task.sleep(for: .milliseconds(120))
          composerFocused = true
        }
      }
    case .device(let id):
      guard let linkModel, linkModel.macs.contains(where: { $0.id == id }) else { return }
      linkDictate = dictate
      lastTargetStored = JunoMobileCodeTarget.device(id).stored
      Task {
        if linkModel.selectedDeviceID != id { await linkModel.select(id) }
        linkModel.beginNewSession(keepingAttachments: keepAttachments)
      }
    }
  }

  private func open(_ recent: JunoMobileCodeRecent) {
    switch recent.source {
    case .cloud(let id, _):
      if let task = model.tasks.first(where: { $0.id == id }) { model.open(task) }
    case .link(let deviceID, let session):
      guard let linkModel else { return }
      Task { await linkModel.openRouted(deviceID: deviceID, sessionID: session.id) }
    case .relay(let deviceID, let sessionID):
      guard let remoteModel else { return }
      Task {
        if remoteModel.selectedDeviceID != deviceID { await remoteModel.selectHost(deviceID) }
        remoteModel.openSession(sessionID)
      }
    }
  }

  private func stop(_ recent: JunoMobileCodeRecent) {
    switch recent.source {
    case .cloud(let id, _):
      if let task = model.tasks.first(where: { $0.id == id }) { Task { await model.cancel(task) } }
    case .link(let deviceID, let session):
      Task { await linkModel?.stop(session, on: deviceID) }
    case .relay(let deviceID, let sessionID):
      Task { await remoteModel?.stopGeneration(deviceID: deviceID, sessionID: sessionID) }
    }
  }

  private func refreshAll() async {
    await model.refresh()
    await linkModel?.refreshAllSessions()
    await remoteModel?.refreshAllSessions()
  }

  /// The start composer: prompt, target toggle, target picker, go.
  private var composer: some View {
    VStack(spacing: JunoSpace.snug) {
      if let blocked = model.startBlockedReason, !prompt.isEmpty {
        Label {
          Text(blocked)
        } icon: {
          JunoIconView(.error, size: 13)
        }
          .font(.caption2)
          .junoSecondaryInk()
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, JunoSpace.tight)
          .transition(.opacity)
      }
      // The iOS Chat composer's anatomy: one glass card, the field, one row.
      // Where it runs is one chip ("Cloud · juno"), the mode another, then
      // the microphone and the one primary circle (voice while empty).
      JunoMobileCodeComposer(
        text: $prompt,
        placeholder: model.isTargetless
          ? String(localized: "code.composer.placeholder.none")
          : String(localized: "code.composer.placeholder"),
        focused: $composerFocused,
        voice: codeVoice,
        canSend: canStart,
        send: start,
        startVoice: startCodeVoice.map { begin in
          { begin(JunoMobileCodeVoiceRelay.briefing(place: startPlace, turns: [])) }
        },
        previewDictation: previewDictation,
        dictateOnAppear: cloudDictate
      ) {
        JunoMobileCodeWhereChip(model: model)
        if !model.isTargetless {
          startModeChip
        }
      }
    }
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.vertical, JunoSpace.tight)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: canStart)
    // A spoken sentence on the home screen starts the run with it; once a
    // thread is open, that thread's composer takes the sentences instead.
    .junoCodeVoiceLink(
      codeVoice, isRunning: false, latestReply: nil,
      enabled: model.openTask == nil && remoteModel?.openSessionID == nil && linkModel?.showsThread != true
    ) { sentence in
      prompt = Self.joined(prompt, sentence)
      start()
    }
    .task(id: startModeProject) { startMode = rememberedStartMode }
    .onAppear { if let previewPrompt { prompt = previewPrompt } }
  }

  // MARK: Voice and the mode

  static func joined(_ draft: String, _ words: String) -> String {
    let spoken = words.trimmingCharacters(in: .whitespacesAndNewlines)
    let existing = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    if spoken.isEmpty { return draft }
    return existing.isEmpty ? spoken : "\(existing) \(spoken)"
  }

  /// Where a run would start, for the call's briefing.
  private var startPlace: String? {
    model.target == .cloud ? model.selectedRepository?.fullName : model.selectedWorkspace?.name
  }

  /// What the mode is remembered against: the repository a cloud run uses.
  private var startModeProject: String? {
    model.target == .cloud ? model.selectedRepository?.fullName : nil
  }

  private var rememberedStartMode: CodeComposerModeLadder {
    CodeComposerModeLadder.remembered(project: startModeProject, offered: CodeComposerModeLadder.cloud) ?? .full
  }

  /// The mode chip: a cloud run carries the choice (Plan, Accept edits, Full
  /// access, all its sandbox enforces); a run on a Mac uses the Mac's.
  @ViewBuilder
  private var startModeChip: some View {
    if model.target == .cloud {
      JunoMobileCodeModeChip(
        mode: startMode,
        offered: CodeComposerModeLadder.cloud,
        note: "A cloud run works in a sandbox and opens a pull request.",
        isEnabled: !model.isMutating
      ) { mode in
        startMode = mode
        mode.remember(project: startModeProject)
      }
    } else {
      JunoMobileCodeModeChip(
        mode: .ask,
        offered: [.ask],
        note: "A run on your Mac asks there first. Change the mode on the Mac, or in the session.",
        isEnabled: !model.isMutating
      ) { _ in }
    }
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
      let mode = model.target == .cloud ? startMode.cloudPermissionMode : nil
      if await model.startTask(prompt: text, permissionMode: mode) != nil { prompt = "" }
    }
  }
}

/// "Where does this run" — the No project ⇄ Cloud ⇄ Remote switch.
///
/// One of a pair: this half chooses the *kind* of target and
/// ``JunoMobileCodeTargetChip`` names the particular one. They were a single
/// row until the switch started truncating under the chip on a phone; splitting
/// them is what let each keep its full width without either becoming a screen
/// of its own.
/// Where the run goes, as one chip on the composer's row ("Cloud · juno"):
/// the three destinations, then the repository or folder, which opens the
/// picker. It replaces the destination switch and the separate target chip,
/// which together took a row of their own on a phone.
private struct JunoMobileCodeWhereChip: View {
  @Bindable var model: NativeCodeModel
  @State private var picking = false

  /// The three things the reader can aim the composer at. A local enum: the
  /// wire target is a fact about `/api/code/tasks`, which has exactly two.
  private enum Choice: Hashable, CaseIterable {
    case none, cloud, device

    var title: String {
      switch self {
      case .none: String(localized: "code.target.none")
      case .cloud: String(localized: "code.target.cloud")
      case .device: String(localized: "code.target.remote")
      }
    }

    var icon: JunoIcon {
      switch self {
      case .none: .message
      case .cloud: .cloud
      case .device: .device
      }
    }
  }

  private var choice: Choice {
    if model.isTargetless { return .none }
    return model.target == .cloud ? .cloud : .device
  }

  private func choose(_ next: Choice) {
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

  /// The repository or folder, short: the full identity is the
  /// accessibility label and the picker's.
  private var place: String? {
    guard !model.isTargetless else { return nil }
    switch model.target {
    case .cloud: return model.selectedRepository?.name
    case .device: return model.selectedWorkspace?.name ?? model.selectedDevice?.name
    }
  }

  private var pickTitle: String {
    model.target == .cloud
      ? String(localized: "code.target.pick-repo")
      : String(localized: "code.target.pick-device")
  }

  var body: some View {
    Menu {
      Section {
        ForEach(Choice.allCases, id: \.self) { option in
          Button {
            choose(option)
          } label: {
            if option == choice {
              Label(option.title, image: JunoIcon.check.assetName(.regular))
            } else {
              Text(option.title)
            }
          }
        }
      }
      if !model.isTargetless {
        Section {
          Button {
            picking = true
          } label: {
            Text(place.map { "\(pickTitle): \($0)" } ?? pickTitle)
          }
        }
      }
    } label: {
      HStack(spacing: JunoSpace.hairline + 2) {
        JunoIconView(choice.icon, size: 14)
        Text(place.map { "\(choice.title) \u{00B7} \($0)" } ?? choice.title)
          .lineLimit(1)
          .truncationMode(.middle)
        JunoIconView(.chevronDown, size: 10)
          .foregroundStyle(Color.junoTertiaryInk)
      }
      .font(.subheadline.weight(.medium))
      .foregroundStyle(Color.junoSecondaryInk)
      .padding(.horizontal, JunoSpace.snug)
      .frame(minHeight: 44)
      .contentShape(.hoverEffect, .rect(cornerRadius: 10))
      .hoverEffect(.highlight)
    }
    .menuOrder(.fixed)
    .tint(Color.primary)
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect)
    .accessibilityLabel("Where it runs, \(choice.title)\(place.map { ", \($0)" } ?? "")")
    .accessibilityIdentifier("juno.mobile.code-target")
    .sheet(isPresented: $picking) {
      JunoMobileCodeTargetSheet(model: model)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
        JunoMobileSheetClose(label: "Done") { dismiss() }
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
            HStack(spacing: JunoSpace.close) {
              JunoIconView(repo.isPrivate ? .lock : .branch, size: 14)
                .junoSecondaryInk()
                .frame(width: 20)
              VStack(alignment: .leading, spacing: JunoSpace.micro) {
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
            .controlSize(.large)
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
                HStack(spacing: JunoSpace.close) {
                  JunoIconView(.projects, size: 14)
                    .junoSecondaryInk()
                    .frame(width: 20)
                  VStack(alignment: .leading, spacing: JunoSpace.micro) {
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
            HStack(spacing: JunoSpace.tight) {
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
  @Environment(\.junoStartCodeVoice) private var startCodeVoice
  @Environment(\.junoCodeVoiceSession) private var codeVoice

  private let bottomAnchor = "juno.code.bottom"

  /// The run is working (a follow-up waits until it stops).
  private var runIsActive: Bool { !(model.openTask?.status.isTerminal ?? true) }

  /// The thread's turns, for the call's briefing and its read-back.
  private var spokenTurns: [(role: JunoVoiceTranscriptRole, text: String)] {
    var turns: [(role: JunoVoiceTranscriptRole, text: String)] = []
    for event in model.events {
      switch event.kind {
      case .user:
        turns.append((.user, event.title))
      case .text:
        if let last = turns.last, last.role == .assistant {
          turns[turns.count - 1] = (.assistant, last.text + event.title)
        } else {
          turns.append((.assistant, event.title))
        }
      default:
        break
      }
    }
    return turns
  }

  private var latestReply: String? { spokenTurns.last(where: { $0.role == .assistant })?.text }

  /// A sentence from the call: a follow-up once the run has stopped, else
  /// it waits in the field, said, for when it can go.
  private func hear(_ sentence: String) {
    followUp = JunoMobileCodeView.joined(followUp, sentence)
    if canSendFollowUp { sendFollowUp() }
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: JunoSpace.cozy) {
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
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.comfy)
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
        .padding(.vertical, JunoSpace.section)
      } else {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          Text("\(fileEvents.count) file change\(fileEvents.count == 1 ? "" : "s")")
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .junoSecondaryInk()
          ForEach(fileEvents) { event in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
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
                    .padding(JunoSpace.snug)
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
        .padding(.vertical, JunoSpace.section)
      } else {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
          ForEach(toolEvents) { event in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.tight) {
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
                    .padding(JunoSpace.snug)
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
        .padding(.vertical, JunoSpace.section)
      } else {
        let totalRun = testSummaries.compactMap(\.testsRun).reduce(0, +)
        let totalPassed = testSummaries.compactMap(\.passed).reduce(0, +)
        let totalFailed = testSummaries.compactMap(\.failed).reduce(0, +)
        let totalSkipped = testSummaries.compactMap(\.skipped).reduce(0, +)

        VStack(alignment: .leading, spacing: JunoSpace.close) {
          JunoCard(padding: 12) {
            HStack(spacing: JunoSpace.regular) {
              VStack(alignment: .leading, spacing: JunoSpace.micro) {
                Text("Total Tests")
                  .junoFont(size: 11, relativeTo: .caption2)
                  .junoMetaInk()
                Text("\(totalRun > 0 ? totalRun : testSummaries.count)")
                  .junoFont(size: 18, relativeTo: .title3, weight: .bold)
              }
              if totalPassed > 0 {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                  Text("Passed")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoMetaInk()
                  Text("\(totalPassed)")
                    .junoFont(size: 18, relativeTo: .title3, weight: .bold)
                    .foregroundStyle(Color.junoSuccess)
                }
              }
              if totalFailed > 0 {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                  Text("Failed")
                    .junoFont(size: 11, relativeTo: .caption2)
                    .junoMetaInk()
                  Text("\(totalFailed)")
                    .junoFont(size: 18, relativeTo: .title3, weight: .bold)
                    .foregroundStyle(Color.junoDanger)
                }
              }
              if totalSkipped > 0 {
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
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
              VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                HStack(spacing: JunoSpace.snug) {
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
        .padding(.vertical, JunoSpace.section)
      } else {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
          ForEach(Array(previewEvents.enumerated()), id: \.offset) { _, info in
            JunoCard(padding: 14) {
              VStack(alignment: .leading, spacing: JunoSpace.close) {
                HStack(spacing: JunoSpace.snug) {
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
                      HStack(spacing: JunoSpace.tight) {
                        JunoIconView(.error, size: 13)
                        Text("Could not load preview screenshot")
                      }
                      .junoFont(size: 12, relativeTo: .caption)
                      .junoMetaInk()
                      .padding(JunoSpace.cozy)
                    case .empty:
                      ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                    @unknown default:
                      EmptyView()
                    }
                  }
                  Link(destination: url) {
                    HStack(spacing: JunoSpace.tight) {
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
        .padding(.vertical, JunoSpace.section)
      } else {
        VStack(alignment: .leading, spacing: JunoSpace.close) {
          Text("\(agents.count) Delegated Agent\(agents.count == 1 ? "" : "s")")
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .junoSecondaryInk()
          ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
            JunoCard(padding: 12) {
              VStack(alignment: .leading, spacing: JunoSpace.tight) {
                HStack(spacing: JunoSpace.snug) {
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
      VStack(alignment: .leading, spacing: JunoSpace.close) {
        JunoCard(padding: 14) {
          VStack(alignment: .leading, spacing: JunoSpace.close) {
            HStack(spacing: JunoSpace.snug) {
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
            HStack(spacing: JunoSpace.snug) {
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
                HStack(spacing: JunoSpace.snug) {
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
      VStack(alignment: .leading, spacing: JunoSpace.snug) {
        HStack(spacing: JunoSpace.snug) {
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
    } else if let connection = model.streamConnection {
      // Which way the stream is coming back (Tether): reconnecting, waiting
      // for the network, or parked until a trigger.
      line += " · " + connection.phaseLabel
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
  @State private var questionAnswer = ""

  private var hasPendingCard: Bool {
    model.pendingQuestion != nil || model.pendingPlan != nil || model.pendingApproval != nil
  }

  /// What the run waits on (a question, a plan, an approval) on a raised card,
  /// then the composer, in the Chat composer's own glass card: one glass layer.
  private var footer: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if hasPendingCard {
        pendingCard
          .padding(JunoSpace.comfy)
          .junoMobileRaised(cornerRadius: 20)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      followUpComposer
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.bottom, JunoSpace.snug)
    .animation(
      JunoMotion.reduced(JunoMotion.standard, when: reduceMotion),
      value: model.pendingApproval
    )
  }

  private var pendingCard: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      if let question = model.pendingQuestion {
        Text("Alevr needs your answer").font(.headline)
        Text(question.text).textSelection(.enabled)
        TextField("Your answer", text: $questionAnswer, axis: .vertical)
          .lineLimit(1...6)
          .accessibilityIdentifier("juno.code.question-answer")
        Button("Send answer") {
          Task { await model.answerQuestion(questionAnswer) }
        }.disabled(model.isMutating || questionAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).contentShape(.rect)
        Divider()
      }
      if let plan = model.pendingPlan {
        Text("Review the plan").font(.headline)
        ScrollView { Text(plan.text).textSelection(.enabled) }.frame(maxHeight: 180)
        HStack {
          Button("Keep planning") { Task { await model.decidePlan(approve: false) } }.contentShape(.rect)
          Button("Approve plan") { Task { await model.decidePlan(approve: true) } }.contentShape(.rect)
        }.disabled(model.isMutating)
        Divider()
      }
      if let approval = model.pendingApproval {
        approvalPanel(approval)
      }
    }
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
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      if let blocked = followUpBlockedReason {
        Text(blocked)
          .junoCaption()
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, JunoSpace.snug)
      }
      JunoMobileCodeComposer(
        text: $followUp,
        placeholder: String(localized: "code.followup.placeholder", defaultValue: "Reply to this session"),
        focused: $followUpFocused,
        voice: codeVoice,
        canSend: canSendFollowUp,
        isRunning: runIsActive,
        send: sendFollowUp,
        stop: { Task { await model.cancelOpenTask() } },
        startVoice: startCodeVoice.map { begin in
          { begin(JunoMobileCodeVoiceRelay.briefing(place: model.openTask?.whereItRuns, turns: spokenTurns)) }
        }
      ) {
        EmptyView()
      }
      .accessibilityIdentifier("juno.mobile.code-followup")
    }
    .junoCodeVoiceLink(codeVoice, isRunning: runIsActive, latestReply: latestReply, deliver: hear)
    .onChange(of: runIsActive) { _, active in
      // Words said while the run worked go once it stops.
      if !active, !followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, codeVoice != nil, canSendFollowUp {
        sendFollowUp()
      }
    }
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
        defaultValue: "Alevr is still working. You can reply once this run stops."
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
    VStack(alignment: .leading, spacing: JunoSpace.close) {
      HStack(spacing: JunoSpace.snug) {
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
      HStack(spacing: JunoSpace.close) {
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
        .modifier(JunoMobileWorkspaceActionStyle())
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
      HStack(alignment: .top, spacing: JunoSpace.snug) {
        Group {
          JunoIconView(symbol, size: 12)
        }
        .junoSecondaryInk()
        .frame(width: 14)
        .padding(.top, JunoSpace.micro)
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
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
    case .protocolEvent: .tasks
    case .approvalRequest: .permission
    case .approvalResponse: .check
    case .agent: .user
    default: .refresh
    }
  }
}
