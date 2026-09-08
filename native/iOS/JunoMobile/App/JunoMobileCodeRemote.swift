import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import SwiftUI
import UIKit

// MARK: - Hosts strip

/// The paired computers, across the top of Code: one chip per Mac with an
/// online dot and when it was last seen, plus Cloud.
///
/// The Claude and ChatGPT phone apps both open their Code surface on a row of
/// devices, because the first question a phone asks is *where* — the machine
/// with the checkout is the context every session below belongs to.
struct JunoMobileCodeHostsStrip: View {
  let hosts: [CodeRemoteHostSummary]
  @Binding var selection: JunoMobileCodeHostSelection
  var onPair: () -> Void

  @State private var selectionHaptic = JunoMobileHapticTrigger()

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: JunoSpace.snug) {
        ForEach(hosts) { host in
          chip(
            title: host.name,
            subtitle: host.online ? "Online" : "Seen \(host.lastSeenAt.formatted(.relative(presentation: .named)))",
            icon: host.platform == "windows" ? "pc" : "laptopcomputer",
            online: host.online,
            selected: selection == .host(host.id)
          ) {
            selectionHaptic.fire()
            selection = .host(host.id)
          }
          .accessibilityIdentifier("juno.mobile.code-host-\(host.id)")
        }
        chip(
          title: "Cloud",
          subtitle: "Runs on Juno",
          icon: "cloud",
          online: nil,
          selected: selection == .cloud
        ) {
          selectionHaptic.fire()
          selection = .cloud
        }
        .accessibilityIdentifier("juno.mobile.code-host-cloud")
        Button(action: onPair) {
          HStack(spacing: JunoSpace.tight) {
            JunoIconView(.plus, size: 13)
            Text(hosts.isEmpty ? "Pair a Mac" : "Pair")
              .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          }
          .foregroundStyle(Color.junoMutedForeground)
          .padding(.horizontal, JunoSpace.cozy)
          .frame(minHeight: 44)
          .overlay(
            RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
              .strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.junoPress)
        .accessibilityIdentifier("juno.mobile.code-pair")
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.tight)
    }
    .junoHaptic(JunoMobileHaptic.selection, trigger: selectionHaptic)
    .accessibilityIdentifier("juno.mobile.code-hosts")
  }

  private func chip(
    title: String, subtitle: String, icon: String, online: Bool?, selected: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: JunoSpace.snug) {
        Image(systemName: icon)
          .junoFont(size: 15, relativeTo: .body)
          .foregroundStyle(selected ? Color.junoAccent : Color.junoMutedForeground)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 1) {
          Text(title)
            .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
            .foregroundStyle(.primary)
            .lineLimit(1)
          HStack(spacing: 4) {
            if let online {
              Circle()
                .fill(online ? Color.junoSuccess : Color.junoMutedForeground.opacity(0.5))
                .frame(width: 6, height: 6)
            }
            Text(subtitle)
              .junoFont(size: 11, relativeTo: .caption2)
              .junoSecondaryInk()
              .lineLimit(1)
          }
        }
      }
      .padding(.horizontal, JunoSpace.cozy)
      .padding(.vertical, JunoSpace.snug)
      .frame(minHeight: 44)
      .background(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .fill(selected ? Color.junoSurface : Color.junoMuted.opacity(0.6))
          .shadow(
            color: selected ? Color.junoCardShadow : .clear,
            radius: JunoElevation.cardBlur, y: JunoElevation.cardOffsetY
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
          .strokeBorder(selected ? Color.junoAccent.opacity(0.5) : Color.junoHairline, lineWidth: 1)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoPress)
    .accessibilityLabel("\(title), \(subtitle)")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// Which strip chip is chosen: a paired host, or the cloud runner.
enum JunoMobileCodeHostSelection: Equatable, Hashable {
  case host(String)
  case cloud

  var deviceID: String? {
    if case .host(let id) = self { return id }
    return nil
  }
}

// MARK: - Sessions

enum JunoMobileCodeSessionFilter: String, CaseIterable, Identifiable {
  case all, running, needsYou, done
  var id: String { rawValue }
  var title: String {
    switch self {
    case .all: "All"
    case .running: "Running"
    case .needsYou: "Needs you"
    case .done: "Done"
    }
  }

  func matches(_ session: CodeRemoteSessionSummary) -> Bool {
    switch self {
    case .all: true
    case .running: session.isRunning
    case .needsYou: session.isAwaitingApproval || session.lastError != nil
    case .done: !session.isRunning && !session.isAwaitingApproval
    }
  }
}

/// One host's sessions, newest first, with the four filters.
struct JunoMobileCodeRemoteSessionsList: View {
  @Bindable var model: CodeRemoteBrowserModel
  let host: CodeRemoteHostSummary
  let open: (CodeRemoteSessionSummary) -> Void
  var newSession: (() -> Void)?

  @State private var filter: JunoMobileCodeSessionFilter = .all
  @Namespace private var zoom

  private var sessions: [CodeRemoteSessionSummary] {
    model.sessions
      .filter { filter.matches($0) }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        JunoMobileSegmented(
          options: JunoMobileCodeSessionFilter.allCases.map {
            JunoMobileSegmented<JunoMobileCodeSessionFilter>.Option($0, $0.title)
          },
          selection: $filter,
          accessibilityLabel: "Session filter",
          compact: true
        )
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
      }
      List {
        if sessions.isEmpty {
          ContentUnavailableView {
            Label {
              Text(model.phase == .loading ? "Loading sessions" : "No sessions")
            } icon: {
              JunoIconView(.code, size: 28)
            }
          } description: {
            Text(emptyDescription)
          } actions: {
            if let newSession, host.online {
              Button("New session", action: newSession)
                .buttonStyle(.borderedProminent)
                .tint(Color.junoAccent)
            }
          }
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }
        ForEach(sessions) { session in
          Button {
            open(session)
          } label: {
            JunoMobileCodeRemoteSessionRow(session: session)
          }
          .buttonStyle(.plain)
          .listRowBackground(Color.junoSurface)
          .accessibilityIdentifier("juno.mobile.code-session-\(session.sessionID)")
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .refreshable { await model.loadSessions(deviceID: host.id) }
      .overlay(alignment: .top) {
        if let error = model.lastErrorDescription, model.phase != .ready {
          JunoInlineError(message: error) {
            Task { await model.loadSessions(deviceID: host.id) }
          }
          .padding(.horizontal, JunoSpace.regular)
        }
      }
    }
    .accessibilityIdentifier("juno.mobile.code-remote-sessions")
  }

  private var emptyDescription: String {
    switch filter {
    case .all: host.online
      ? "Start one here or from Juno Code on \(host.name)."
      : "\(host.name) is offline. Sessions appear once it checks in."
    case .running: "Nothing is running on \(host.name) right now."
    case .needsYou: "Nothing is waiting on you."
    case .done: "No finished sessions yet."
    }
  }
}

/// Status glyph · title · project/branch · diff stat · time.
struct JunoMobileCodeRemoteSessionRow: View {
  let session: CodeRemoteSessionSummary

  var body: some View {
    HStack(alignment: .top, spacing: JunoSpace.cozy) {
      statusGlyph
        .frame(width: 22, height: 22)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        Text(session.title)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(.primary)
          .lineLimit(2)
        HStack(spacing: JunoSpace.tight) {
          if let workspace = session.workspaceName {
            Text(workspace)
          }
          if let branch = session.activeBranch {
            Text("·").accessibilityHidden(true)
            HStack(spacing: 2) {
              JunoIconView(.branch, size: 10)
              Text(branch).lineLimit(1)
            }
          }
        }
        .junoFont(size: 12, relativeTo: .caption)
        .junoSecondaryInk()
        .lineLimit(1)
        HStack(spacing: JunoSpace.snug) {
          Text(statusWord)
            .junoFont(size: 12, relativeTo: .caption, weight: .medium)
            .foregroundStyle(statusTint)
          if session.pendingChangeCount > 0 {
            Text("^[\(session.pendingChangeCount) file](inflect: true) changed")
              .junoFont(size: 12, relativeTo: .caption)
              .junoMetaInk()
          }
          Spacer(minLength: 0)
          Text(session.updatedAt, style: .relative)
            .junoFont(size: 11, relativeTo: .caption2)
            .monospacedDigit()
            .junoMetaInk()
        }
      }
    }
    .padding(.vertical, JunoSpace.hairline)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private var statusWord: String {
    if session.isAwaitingApproval { return "Needs you" }
    if session.isRunning { return "Running" }
    switch session.currentStatus {
    case "completed": return "Done"
    case "failed": return "Failed"
    case "interrupted": return "Stopped"
    case "idle": return "Idle"
    default: return session.currentStatus.capitalized
    }
  }

  private var statusTint: Color {
    if session.isAwaitingApproval { return Color.junoCaution }
    if session.isRunning { return Color.junoAccent }
    switch session.currentStatus {
    case "completed": return Color.junoSuccess
    case "failed": return Color.junoDanger
    default: return Color.junoMutedForeground
    }
  }

  @ViewBuilder
  private var statusGlyph: some View {
    if session.isAwaitingApproval {
      JunoIconView(.permission, size: 15).foregroundStyle(Color.junoCaution)
    } else if session.isRunning {
      JunoMobileRunningDot()
    } else {
      switch session.currentStatus {
      case "completed": JunoIconView(.check, size: 15).foregroundStyle(Color.junoSuccess)
      case "failed": JunoIconView(.error, size: 15).foregroundStyle(Color.junoDanger)
      default: JunoIconView(.code, size: 15).foregroundStyle(Color.junoMutedForeground)
      }
    }
  }
}

/// A breathing accent dot for a session in flight. Still under Reduce Motion.
struct JunoMobileRunningDot: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 20, paused: reduceMotion)) { context in
      let phase = reduceMotion ? 1 : 0.7 + 0.3 * sin(context.date.timeIntervalSinceReferenceDate * 3)
      Circle()
        .fill(Color.junoAccent)
        .frame(width: 9, height: 9)
        .scaleEffect(phase)
        .opacity(0.6 + 0.4 * phase)
    }
    .accessibilityLabel("Running")
  }
}

// MARK: - Devices / pairing

/// The paired computers, and how to add one.
///
/// Pairing is Mac-initiated: Juno Code on the Mac registers the device with
/// the account when Remote is switched on there, and the relay only ever
/// accepts commands for a device that did. There is no code to type on the
/// phone, and inventing one here would be a screen that talks to nothing — so
/// this lists what is paired and explains the one real way to add a machine.
struct JunoMobileCodeDevicesView: View {
  var remoteModel: CodeRemoteBrowserModel?

  /// The host a revoke confirmation is up for. Set from the row's swipe
  /// action rather than revoking inline: full-swipe is off, so a revoke is
  /// always a deliberate second tap, never a gesture that overshoots.
  @State private var pendingRevoke: CodeRemoteHostSummary?
  @State private var revokeError: String?

  var body: some View {
    List {
      Section {
        if let hosts = remoteModel?.hosts, !hosts.isEmpty {
          ForEach(hosts) { host in
            hostRow(host)
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                  pendingRevoke = host
                } label: {
                  Label("Revoke", systemImage: "trash")
                }
                .disabled(remoteModel?.revokingHostID != nil)
                .accessibilityLabel("Revoke \(host.name)")
                .accessibilityIdentifier("juno.mobile.code-device-revoke.\(host.id)")
              }
          }
        } else {
          Text("No computers are paired yet.")
            .junoCaption()
        }
      } header: {
        Text("Paired computers")
      } footer: {
        Text("Swipe left on a computer to revoke it. Its sessions and pending approvals go with it; the Mac pairs again from Juno Code on the Mac.")
      }

      Section("How to pair a Mac") {
        step(1, "Open Juno Code on your Mac and sign in to the same account.")
        step(2, "In the sidebar, turn on Remote and share the folders you want to reach from your phone.")
        step(3, "The Mac appears here within a minute. Sessions it runs show up under it.")
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .junoScreenCanvas()
    .navigationTitle("Paired computers")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await remoteModel?.refreshAllSessions() }
    .confirmationDialog(
      pendingRevoke.map { "Revoke \($0.name)?" } ?? "",
      isPresented: Binding(
        get: { pendingRevoke != nil },
        set: { if !$0 { pendingRevoke = nil } }
      ),
      titleVisibility: .visible,
      presenting: pendingRevoke
    ) { host in
      Button("Revoke \(host.name)", role: .destructive) {
        pendingRevoke = nil
        Task { await revoke(host) }
      }
      .contentShape(.rect)
      Button("Cancel", role: .cancel) { pendingRevoke = nil }
        .contentShape(.rect)
    } message: { host in
      Text("\(host.name) stops being listed, and its sessions and pending approvals go with it. The Mac can pair again from Juno Code on the Mac.")
    }
    .alert(
      "Could not revoke this computer",
      isPresented: Binding(
        get: { revokeError != nil },
        set: { if !$0 { revokeError = nil } }
      )
    ) {
      Button("OK", role: .cancel) { revokeError = nil }
        .contentShape(.rect)
    } message: {
      Text(revokeError ?? "Try again.")
    }
    .accessibilityIdentifier("juno.mobile.code-devices")
  }

  /// Revokes through the browser model and reports only a genuine failure: a
  /// host the model no longer lists is revoked, whatever else has happened
  /// since.
  private func revoke(_ host: CodeRemoteHostSummary) async {
    await remoteModel?.revokeHost(id: host.id)
    if remoteModel?.hosts.contains(where: { $0.id == host.id }) == true {
      revokeError = remoteModel?.lastErrorDescription
        ?? "The computer could not be revoked."
    }
  }

  private func hostRow(_ host: CodeRemoteHostSummary) -> some View {
    HStack(spacing: JunoSpace.cozy) {
      Image(systemName: host.platform == "windows" ? "pc" : "laptopcomputer")
        .junoFont(size: 17, relativeTo: .body)
        .foregroundStyle(Color.junoAccent)
        .frame(width: 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(host.name).junoRowLabel()
        Text(host.online ? "Online now" : "Last seen \(host.lastSeenAt.formatted(.relative(presentation: .named)))")
          .junoCaption()
        if !host.workspaceNames.isEmpty {
          Text(host.workspaceNames.joined(separator: " · "))
            .junoFont(size: 11, relativeTo: .caption2)
            .junoMetaInk()
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      if remoteModel?.revokingHostID == host.id {
        ProgressView()
          .controlSize(.small)
          .accessibilityLabel("Revoking \(host.name)")
      } else {
        Circle()
          .fill(host.online ? Color.junoSuccess : Color.junoMutedForeground.opacity(0.4))
          .frame(width: 8, height: 8)
      }
    }
    .padding(.vertical, 2)
  }

  private func step(_ number: Int, _ text: String) -> some View {
    HStack(alignment: .top, spacing: JunoSpace.cozy) {
      Text("\(number)")
        .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
        .foregroundStyle(Color.junoOnAccent)
        .frame(width: 22, height: 22)
        .background(Circle().fill(Color.junoAccent))
      Text(text)
        .junoRowLabel()
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Thread

/// One remote session: the journal folded into a thread, with the host's
/// approvals answered in place and a follow-up composer that queues.
struct JunoMobileCodeRemoteThreadView: View {
  @Bindable var model: CodeRemoteBrowserModel
  let session: CodeRemoteSessionSummary
  var modelCatalog: [NativeChatModelOption] = []

  private enum Surface: String, CaseIterable, Identifiable {
    case thread, changes, terminal, tests
    var id: String { rawValue }
    var title: String {
      switch self {
      case .thread: "Thread"
      case .changes: "Changes"
      case .terminal: "Terminal"
      case .tests: "Tests"
      }
    }
  }

  @State private var surface: Surface = .thread
  @State private var followUp = ""
  @State private var isNearBottom = true
  @State private var approveHaptic = JunoMobileHapticTrigger()
  @State private var denyHaptic = JunoMobileHapticTrigger()
  @State private var sendHaptic = JunoMobileHapticTrigger()
  @State private var stopHaptic = JunoMobileHapticTrigger()
  @State private var attentionHaptic = JunoMobileHapticTrigger()
  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  @FocusState private var composerFocused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var thread: CodeRemoteThread { model.thread }
  private var isRunning: Bool { thread.isRunning || (thread.status == nil && session.isRunning) }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: JunoSpace.snug) {
          JunoMobileSegmented(
            options: Surface.allCases.map { JunoMobileSegmented<Surface>.Option($0, badge($0)) },
            selection: $surface,
            accessibilityLabel: "Session surface",
            compact: true
          )
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.snug)
      }
      content
    }
    .junoScreenCanvas()
    .navigationTitle(session.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .safeAreaInset(edge: .bottom) { footer }
    .junoHaptic(JunoMobileHaptic.approve, trigger: approveHaptic)
    .junoHaptic(JunoMobileHaptic.deny, trigger: denyHaptic)
    .junoHaptic(JunoMobileHaptic.send, trigger: sendHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: stopHaptic)
    .junoHaptic(JunoMobileHaptic.attention, trigger: attentionHaptic)
    .task(id: session.sessionID) { await follow() }
    .onChange(of: thread.pendingApproval?.requestID) { oldID, id in
      if let oldID, oldID != id {
        JunoMobileLiveActivityCoordinator.shared.resolveApproval(requestID: oldID)
      }
      guard let approval = thread.pendingApproval, approval.requestID == id else { return }
      attentionHaptic.fire()
      JunoMobileLiveActivityCoordinator.shared.presentApproval(
        deviceID: session.deviceID, sessionID: session.sessionID,
        requestID: approval.requestID, summary: approval.summary, risk: approval.risk
      )
    }
    .accessibilityIdentifier("juno.mobile.code-remote-thread")
  }

  private func badge(_ surface: Surface) -> String {
    switch surface {
    case .thread: return surface.title
    case .changes:
      return thread.changes.isEmpty ? surface.title : "\(surface.title) · \(thread.changes.count)"
    case .terminal: return surface.title
    case .tests:
      guard let tests = thread.latestTests else { return surface.title }
      switch tests.status {
      case .passed: return "\(surface.title) ✓"
      case .failed: return "\(surface.title) ✕"
      default: return surface.title
      }
    }
  }

  /// Poll once for the backlog, then follow the live feed; when the feed
  /// closes — the relay rotates connections — poll and reconnect with a short
  /// pause so a finished session does not spin.
  private func follow() async {
    await model.pollEvents(deviceID: session.deviceID, sessionID: session.sessionID)
    while !Task.isCancelled {
      await model.watchEvents(deviceID: session.deviceID, sessionID: session.sessionID)
      guard !Task.isCancelled else { return }
      try? await Task.sleep(for: .seconds(model.thread.isRunning ? 2 : 8))
      guard !Task.isCancelled else { return }
      await model.pollEvents(deviceID: session.deviceID, sessionID: session.sessionID)
    }
  }

  @ViewBuilder
  private var content: some View {
    switch surface {
    case .thread: threadSurface
    case .changes: JunoMobileCodeChangesView(changes: thread.changes)
    case .terminal: JunoMobileTerminalView(lines: thread.terminalLines, live: isRunning)
    case .tests: testsSurface
    }
  }

  private var threadSurface: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
        ForEach(thread.items) { item in
          JunoMobileCodeThreadItem(
            item: item,
            isSending: model.isSendingCommand,
            approve: { requestID, approved in
              if approved { approveHaptic.fire() } else { denyHaptic.fire() }
              Task {
                await model.respondToApproval(
                  deviceID: session.deviceID, sessionID: session.sessionID,
                  requestID: requestID, approved: approved
                )
              }
            }
          )
          .transition(.opacity.combined(with: .offset(y: JunoSpace.snug)))
        }
        ForEach(Array(thread.queuedPrompts.enumerated()), id: \.offset) { _, prompt in
          JunoMobileCodeQueuedPrompt(text: prompt)
        }
        if isRunning, !thread.isStreamingText {
          JunoShimmerText(workingLabel)
            .padding(.leading, JunoSpace.hairline)
        }
        if let error = model.lastErrorDescription, model.phase != .ready {
          JunoInlineError(message: error) {
            Task { await model.pollEvents(deviceID: session.deviceID, sessionID: session.sessionID) }
          }
        }
        if thread.items.isEmpty, model.phase == .loading {
          JunoShimmerText("Loading the session…")
        }
      }
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: thread.items.count)
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .frame(maxWidth: 768)
      .frame(maxWidth: .infinity)
    }
    // Bottom for where it opens and for what arrives; top for how a short
    // thread sits. One `.defaultScrollAnchor(.bottom)` did all three, and a
    // session with two items floated them to the foot of an empty screen.
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .defaultScrollAnchor(.top, for: .alignment)
    .scrollPosition($scrollPosition)
    .scrollDismissesKeyboard(.interactively)
    .modifier(JunoMobileSoftBottomEdge())
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentSize.height <= geometry.containerSize.height
        || geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 120
    } action: { _, nearBottom in
      isNearBottom = nearBottom
    }
    .onChange(of: model.events.count) { _, _ in
      guard isNearBottom else { return }
      withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
        scrollPosition.scrollTo(edge: .bottom)
      }
    }
  }

  private var workingLabel: String {
    if case .workLog(_, let activities)? = thread.items.last,
      let last = activities.last, !last.isFinished
    {
      return last.summary ?? "Running \(last.name)…"
    }
    return "Working…"
  }

  @ViewBuilder
  private var testsSurface: some View {
    if let tests = thread.latestTests {
      ScrollView {
        JunoMobileCodeTestsCard(summary: tests)
          .padding(JunoSpace.regular)
      }
    } else {
      ContentUnavailableView {
        Label { Text("No test run yet") } icon: { JunoIconView(.check, size: 28) }
      } description: {
        Text("Results appear here when the agent runs the suite.")
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      if isRunning {
        Button(role: .destructive) {
          stopHaptic.fire()
          Task { await model.stopGeneration(deviceID: session.deviceID, sessionID: session.sessionID) }
        } label: {
          JunoIconView(.stop, size: 16)
        }
        .disabled(model.isSendingCommand)
        .accessibilityLabel("code.stop")
        .accessibilityIdentifier("juno.mobile.code-remote-stop")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Section("Model") {
          ForEach(modelChoices, id: \.self) { id in
            Button {
              Task { await model.patchSession(deviceID: session.deviceID, sessionID: session.sessionID, modelID: id) }
            } label: {
              if id == session.modelID {
                Label(junoDisplayModelName(id), systemImage: "checkmark")
              } else {
                Text(junoDisplayModelName(id))
              }
            }
          }
        }
        Section("Effort") {
          ForEach(["low", "medium", "high", "max"], id: \.self) { effort in
            Button {
              Task { await model.patchSession(deviceID: session.deviceID, sessionID: session.sessionID, reasoningEffort: effort) }
            } label: {
              if effort == session.reasoningEffort {
                Label(effort.capitalized, systemImage: "checkmark")
              } else {
                Text(effort.capitalized)
              }
            }
          }
        }
        Section("Permissions") {
          ForEach([("approvalRequired", "Ask before changes"), ("auto", "Auto"), ("readOnly", "Read only")], id: \.0) { mode, title in
            Button {
              Task { await model.patchSession(deviceID: session.deviceID, sessionID: session.sessionID, permissionMode: mode) }
            } label: {
              if mode == session.permissionMode {
                Label(title, systemImage: "checkmark")
              } else {
                Text(title)
              }
            }
          }
        }
      } label: {
        JunoIconView(.sliders, size: 16)
      }
      .tint(Color.primary)
      .accessibilityLabel("Session options")
      .accessibilityIdentifier("juno.mobile.code-remote-options")
    }
  }

  private var modelChoices: [String] {
    let ids = modelCatalog.filter { $0.isChatCapable }.map(\.id)
    return ids.contains(session.modelID) ? ids : [session.modelID] + ids
  }

  // MARK: Footer

  private var footer: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      if let approval = thread.pendingApproval {
        JunoMobileCodeApprovalCard(
          approval: approval,
          isBusy: model.isSendingCommand
        ) { approved in
          if approved { approveHaptic.fire() } else { denyHaptic.fire() }
          Task {
            await model.respondToApproval(
              deviceID: session.deviceID, sessionID: session.sessionID,
              requestID: approval.requestID, approved: approved
            )
          }
        }
        Divider()
      }
      HStack(spacing: JunoSpace.snug) {
        chip(junoDisplayModelName(session.modelID), icon: .models)
        if let effort = session.reasoningEffort {
          chip(effort.capitalized, icon: .sliders)
        }
        chip(permissionLabel, icon: .permission)
        Spacer(minLength: 0)
      }
      HStack(alignment: .bottom, spacing: JunoSpace.snug) {
        TextField(
          isRunning ? "Steer this session…" : "Reply to this session",
          text: $followUp, axis: .vertical
        )
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        .focused($composerFocused)
        .frame(minHeight: 44)
        .accessibilityIdentifier("juno.mobile.code-remote-followup")
        Button {
          send()
        } label: {
          JunoIconView(.send, size: 16)
            .foregroundStyle(canSend ? Color.junoOnAccent : Color.junoMutedForeground)
            .frame(width: 34, height: 34)
            .modifier(JunoComposerSendBackground(active: canSend))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel(isRunning ? "Queue message" : "Send")
        .accessibilityIdentifier("juno.mobile.code-remote-send")
      }
      if isRunning {
        Text("Sent while running, a message is queued and read between steps.")
          .junoFont(size: 11, relativeTo: .caption2)
          .junoMetaInk()
      }
    }
    .padding(JunoSpace.cozy + 2)
    .background(JunoGlassBackground(cornerRadius: JunoRadius.composer))
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.bottom, JunoSpace.snug)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: thread.pendingApproval)
  }

  private var permissionLabel: String {
    switch session.permissionMode {
    case "auto": "Auto"
    case "readOnly", "read_only": "Read only"
    default: "Ask first"
    }
  }

  private func chip(_ text: String, icon: JunoIcon) -> some View {
    HStack(spacing: 4) {
      JunoIconView(icon, size: 11)
      Text(text).lineLimit(1)
    }
    .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
    .foregroundStyle(Color.junoMutedForeground)
    .padding(.horizontal, JunoSpace.snug)
    .frame(minHeight: 22)
    .background(Capsule().fill(Color.junoMuted))
  }

  private var canSend: Bool {
    !followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSendingCommand
      && session.fresh != false
  }

  private func send() {
    let text = followUp
    guard canSend else { return }
    sendHaptic.fire()
    followUp = ""
    composerFocused = false
    Task { await model.send(deviceID: session.deviceID, sessionID: session.sessionID, text: text) }
  }
}

/// The content's bottom edge softens under the floating composer on iOS 26.
struct JunoMobileSoftBottomEdge: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.scrollEdgeEffectStyle(.soft, for: .bottom)
    } else {
      content
    }
  }
}

// MARK: - Thread items

struct JunoMobileCodeThreadItem: View {
  let item: CodeRemoteThread.Item
  var isSending = false
  var approve: (String, Bool) -> Void

  var body: some View {
    switch item {
    case .userMessage(_, let text, _):
      HStack {
        Spacer(minLength: 24)
        Text(text)
          .junoFont(size: 15, relativeTo: .body)
          .lineSpacing(4)
          .textSelection(.enabled)
          .padding(.horizontal, JunoSpace.regular)
          .padding(.vertical, JunoSpace.cozy)
          .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.message, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: JunoRadius.message, style: .continuous).strokeBorder(Color.junoHairline, lineWidth: 1))
      }
      .accessibilityLabel("You said, \(text)")
    case .assistantText(_, let text):
      JunoMarkdownText(text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    case .reasoning(_, let text):
      DisclosureGroup {
        Text(text)
          .junoFont(size: 13, relativeTo: .footnote)
          .junoSecondaryInk()
          .padding(.top, JunoSpace.hairline)
      } label: {
        JunoIconLabel("Thinking", icon: .models, size: 13)
          .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          .junoSecondaryInk()
      }
      .tint(Color.junoMutedForeground)
    case .workLog(_, let activities):
      JunoMobileCodeWorkLog(activities: activities)
    case .fileChange(let change):
      JunoMobileCodeFileChangeRow(change: change)
    case .approval(let approval):
      if approval.isPending {
        EmptyView() // The footer carries the live card.
      } else {
        HStack(spacing: JunoSpace.snug) {
          JunoIconView(approval.approved == true ? .check : .close, size: 13)
            .foregroundStyle(approval.approved == true ? Color.junoSuccess : Color.junoDanger)
          Text(approval.approved == true ? "You allowed: \(approval.summary)" : "You denied: \(approval.summary)")
            .junoFont(size: 13, relativeTo: .footnote)
            .junoSecondaryInk()
            .lineLimit(2)
        }
      }
    case .tests(_, let summary):
      JunoMobileCodeTestsCard(summary: summary, compact: true)
    case .git(_, let text):
      JunoIconLabel(verbatim: text, icon: .branch, size: 13)
        .junoFont(size: 13, relativeTo: .footnote)
        .junoSecondaryInk()
    case .subagent(let agent):
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.user, size: 13).foregroundStyle(Color.junoAccent)
        VStack(alignment: .leading, spacing: 1) {
          Text(agent.title).junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          if let status = agent.status ?? agent.summary {
            Text(status).junoFont(size: 12, relativeTo: .caption).junoSecondaryInk()
          }
        }
      }
    case .status(_, let status):
      if status == "completed" || status == "failed" || status == "interrupted" {
        Text(status == "completed" ? "Finished" : status == "failed" ? "Failed" : "Stopped")
          .junoFont(size: 12, relativeTo: .caption, weight: .medium)
          .foregroundStyle(status == "failed" ? Color.junoDanger : Color.junoMutedForeground)
      }
    case .error(_, let message):
      JunoInlineError(message: message)
    case .completed(_, let summary):
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.check, size: 13).foregroundStyle(Color.junoSuccess)
        Text(summary ?? "Session finished")
          .junoFont(size: 13, relativeTo: .footnote)
          .junoSecondaryInk()
      }
    }
  }
}

/// A group of tool activity, collapsed to one line per call.
struct JunoMobileCodeWorkLog: View {
  let activities: [CodeRemoteThread.ToolActivity]
  @State private var expanded: Set<String> = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(activities) { activity in
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
          Button {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
              if expanded.contains(activity.id) { expanded.remove(activity.id) } else { expanded.insert(activity.id) }
            }
          } label: {
            HStack(spacing: JunoSpace.snug) {
              Group {
                if activity.isFinished {
                  JunoIconView(activity.isError ? .error : .check, size: 12)
                    .foregroundStyle(activity.isError ? Color.junoDanger : Color.junoMutedForeground)
                } else {
                  ProgressView().controlSize(.mini)
                }
              }
              .frame(width: 14)
              Text(activity.summary ?? activity.name)
                .junoFont(size: 13, relativeTo: .footnote, design: .monospaced)
                .foregroundStyle(.primary)
                .lineLimit(1)
              Spacer(minLength: 0)
              if let code = activity.exitCode, code != 0 {
                JunoStatusPill(text: "exit \(code)", tint: Color.junoDanger)
              }
              if !activity.output.isEmpty || activity.input != nil {
                JunoIconView(.chevronDown, size: 10)
                  .junoMetaInk()
                  .rotationEffect(.degrees(expanded.contains(activity.id) ? 180 : 0))
              }
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(activity.summary ?? activity.name)
          if expanded.contains(activity.id) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
              if let input = activity.input, input != activity.summary {
                Text(input)
                  .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                  .junoSecondaryInk()
              }
              if !activity.output.isEmpty {
                Text(activity.output)
                  .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
                  .foregroundStyle(.primary)
                  .lineLimit(24)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(JunoSpace.snug)
                  .background(Color.junoTerminal, in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
              }
            }
            .padding(.leading, 22)
            .padding(.bottom, JunoSpace.snug)
            .transition(.junoInline)
          }
        }
      }
    }
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.vertical, JunoSpace.tight)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoMuted.opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoHairline, lineWidth: 1)
    )
  }
}

struct JunoMobileCodeQueuedPrompt: View {
  let text: String
  var body: some View {
    HStack {
      Spacer(minLength: 24)
      VStack(alignment: .trailing, spacing: 3) {
        Text(text)
          .junoFont(size: 15, relativeTo: .body)
          .padding(.horizontal, JunoSpace.regular)
          .padding(.vertical, JunoSpace.cozy)
          .background(Color.junoMuted.opacity(0.6), in: RoundedRectangle(cornerRadius: JunoRadius.message, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: JunoRadius.message, style: .continuous).strokeBorder(Color.junoBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        JunoShimmerText("Queued", font: .caption.weight(.medium))
      }
    }
    .accessibilityLabel("Queued: \(text)")
  }
}

struct JunoMobileCodeFileChangeRow: View {
  let change: CodeRemoteThread.FileChange
  @State private var showingDiff = false

  var body: some View {
    Button {
      if change.diff != nil { showingDiff = true }
    } label: {
      HStack(spacing: JunoSpace.snug) {
        JunoStatusPill(
          text: String(change.changeKind.prefix(1)).uppercased(),
          tint: change.changeKind == "delete" || change.changeKind == "deleted" ? Color.junoDanger : Color.junoAccent
        )
        Text(change.path)
          .junoFont(size: 13, relativeTo: .footnote, design: .monospaced)
          .foregroundStyle(.primary)
          .lineLimit(1)
          .truncationMode(.head)
        Spacer(minLength: 4)
        if let additions = change.additions, let deletions = change.deletions {
          HStack(spacing: 4) {
            Text("+\(additions)").foregroundStyle(Color.junoSuccess)
            Text("−\(deletions)").foregroundStyle(Color.junoDanger)
          }
          .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
          .monospacedDigit()
        }
        if change.diff != nil {
          JunoIconView(.chevronRight, size: 11).junoMetaInk()
        }
      }
      .padding(.horizontal, JunoSpace.cozy)
      .frame(minHeight: 44)
      .junoCard(cornerRadius: JunoRadius.well)
      .contentShape(Rectangle())
    }
    .buttonStyle(.junoPress)
    .disabled(change.diff == nil)
    .sheet(isPresented: $showingDiff) {
      NavigationStack {
        JunoMobileDiffView(diffText: change.diff ?? "", title: change.path)
      }
      .junoSheetSurface(.page)
    }
  }
}

struct JunoMobileCodeApprovalCard: View {
  let approval: CodeRemoteThread.Approval
  var isBusy = false
  let decide: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconLabel("code.approval.title", icon: .permission, size: 15)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .semibold)
          .foregroundStyle(Color.junoCaution)
        Spacer(minLength: 4)
        JunoStatusPill(
          text: approval.risk.uppercased(),
          tint: approval.risk == "high" || approval.risk == "destructive" ? Color.junoDanger : Color.junoCaution
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
      HStack(spacing: 10) {
        Button {
          decide(false)
        } label: {
          Text("code.approval.deny").fontWeight(.semibold).frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(Color.junoMutedForeground)
        .foregroundStyle(.primary)
        .controlSize(.large)
        .accessibilityIdentifier("juno.mobile.code-remote-deny")
        Button {
          decide(true)
        } label: {
          Text("code.approval.allow").fontWeight(.semibold).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .controlSize(.large)
        .accessibilityIdentifier("juno.mobile.code-remote-approve")
      }
      .disabled(isBusy)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.code-remote-approval")
  }
}

struct JunoMobileCodeTestsCard: View {
  let summary: CodeRemoteThread.TestSummary
  var compact = false

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(spacing: JunoSpace.snug) {
        Group {
          switch summary.status {
          case .passed: JunoIconView(.check, size: 15).foregroundStyle(Color.junoSuccess)
          case .failed: JunoIconView(.error, size: 15).foregroundStyle(Color.junoDanger)
          case .running: ProgressView().controlSize(.small)
          case .unknown: JunoIconView(.tools, size: 15).junoSecondaryInk()
          }
        }
        .frame(width: 20)
        Text(title)
          .junoFont(size: 14, relativeTo: .subheadline, weight: .semibold)
        Spacer(minLength: 0)
      }
      HStack(spacing: JunoSpace.regular) {
        if let passed = summary.passed { metric("Passed", passed, Color.junoSuccess) }
        if let failed = summary.failed { metric("Failed", failed, failed > 0 ? Color.junoDanger : Color.junoMutedForeground) }
        if let skipped = summary.skipped { metric("Skipped", skipped, Color.junoMutedForeground) }
        if let total = summary.total { metric("Total", total, Color.junoMutedForeground) }
      }
      if !compact, let detail = summary.detail, !detail.isEmpty {
        Text(detail)
          .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(JunoSpace.snug)
          .background(Color.junoTerminal, in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
      }
    }
    .padding(JunoSpace.cozy)
    .junoCard(cornerRadius: JunoRadius.card)
    .accessibilityElement(children: .combine)
  }

  private var title: String {
    switch summary.status {
    case .passed: "Tests passed"
    case .failed: "Tests failed"
    case .running: "Running tests"
    case .unknown: "Test run"
    }
  }

  private func metric(_ label: String, _ value: Int, _ tint: Color) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text("\(value)")
        .junoFont(size: 17, relativeTo: .title3, weight: .semibold)
        .monospacedDigit()
        .foregroundStyle(tint)
      Text(label)
        .junoFont(size: 10, relativeTo: .caption2, weight: .medium)
        .junoMetaInk()
    }
  }
}

// MARK: - Changes + diff

struct JunoMobileCodeChangesView: View {
  let changes: [CodeRemoteThread.FileChange]

  var body: some View {
    if changes.isEmpty {
      ContentUnavailableView {
        Label { Text("No changes yet") } icon: { JunoIconView(.file, size: 28) }
      } description: {
        Text("Files the agent creates, edits or deletes appear here with their diffs.")
      }
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: JunoSpace.snug) {
          HStack(spacing: JunoSpace.snug) {
            Text("^[\(changes.count) file](inflect: true)")
              .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
              .junoSecondaryInk()
            let added = changes.compactMap(\.additions).reduce(0, +)
            let removed = changes.compactMap(\.deletions).reduce(0, +)
            Text("+\(added)").foregroundStyle(Color.junoSuccess)
            Text("−\(removed)").foregroundStyle(Color.junoDanger)
            Spacer(minLength: 0)
          }
          .junoFont(size: 12, relativeTo: .caption, weight: .medium)
          .monospacedDigit()
          ForEach(changes) { change in
            JunoMobileCodeFileChangeRow(change: change)
          }
        }
        .padding(JunoSpace.regular)
      }
    }
  }
}

/// A real diff: files, hunks, a `+`/`−` gutter with line numbers, monospace,
/// and a file picker to jump between them.
struct JunoMobileDiffView: View {
  let diffText: String
  var title: String = "Changes"

  @State private var selectedFileID: String?
  @Environment(\.dismiss) private var dismiss

  private var diff: UnifiedDiff { UnifiedDiff.parse(diffText) }

  var body: some View {
    let parsed = diff
    ScrollViewReader { proxy in
      ScrollView([.vertical]) {
        LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
          ForEach(parsed.files) { file in
            VStack(alignment: .leading, spacing: 0) {
              fileHeader(file)
              if file.status == .binary {
                Text("Binary file")
                  .junoCaption()
                  .padding(JunoSpace.cozy)
              }
              ForEach(file.hunks) { hunk in
                hunkView(hunk)
              }
            }
            .background(Color.junoTerminal, in: RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).strokeBorder(Color.junoHairline, lineWidth: 1))
            .id(file.id)
          }
          if parsed.files.isEmpty {
            Text(diffText)
              .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
              .padding(JunoSpace.cozy)
          }
        }
        .padding(JunoSpace.regular)
      }
      .onChange(of: selectedFileID) { _, id in
        if let id { proxy.scrollTo(id, anchor: .top) }
      }
    }
    .junoScreenCanvas()
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Done") { dismiss() }
      }
      if parsed.files.count > 1 {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            ForEach(parsed.files) { file in
              Button(file.path) { selectedFileID = file.id }
            }
          } label: {
            JunoIconLabel(verbatim: "\(parsed.files.count) files", icon: .file, size: 13)
              .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
          }
          .tint(Color.primary)
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        HStack(spacing: 4) {
          Text("+\(parsed.additions)").foregroundStyle(Color.junoSuccess)
          Text("−\(parsed.deletions)").foregroundStyle(Color.junoDanger)
        }
        .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
        .monospacedDigit()
      }
    }
    .accessibilityIdentifier("juno.mobile.code-diff")
  }

  private func fileHeader(_ file: UnifiedDiff.File) -> some View {
    HStack(spacing: JunoSpace.snug) {
      JunoIconView(.file, size: 12).junoSecondaryInk()
      Text(file.path.isEmpty ? "Change" : file.path)
        .junoFont(size: 12, relativeTo: .caption, weight: .semibold, design: .monospaced)
        .lineLimit(1)
        .truncationMode(.head)
      Spacer(minLength: 4)
      switch file.status {
      case .added: JunoStatusPill(text: "New", tint: Color.junoSuccess)
      case .deleted: JunoStatusPill(text: "Deleted", tint: Color.junoDanger)
      case .renamed: JunoStatusPill(text: "Renamed", tint: Color.junoAccent)
      default: EmptyView()
      }
      Text("+\(file.additions) −\(file.deletions)")
        .junoFont(size: 11, relativeTo: .caption2, weight: .medium)
        .monospacedDigit()
        .junoMetaInk()
    }
    .padding(.horizontal, JunoSpace.cozy)
    .frame(minHeight: 38)
    .background(Color.junoMuted.opacity(0.7))
  }

  private func hunkView(_ hunk: UnifiedDiff.Hunk) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if !hunk.header.isEmpty {
        Text(hunk.header)
          .junoFont(size: 11, relativeTo: .caption2, design: .monospaced)
          .foregroundStyle(Color.junoAccent)
          .padding(.horizontal, JunoSpace.cozy)
          .padding(.vertical, JunoSpace.tight)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color.junoAccent.opacity(0.06))
      }
      // The indicator stays on here, unlike the hosts strip and filter row:
      // a diff line has no other cue that it continues past the edge, and a
      // clipped code line that looks complete is worse than a visible bar.
      ScrollView(.horizontal, showsIndicators: true) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(hunk.lines) { line in
            HStack(spacing: 0) {
              Text(line.oldNumber.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
              Text(line.newNumber.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
                .padding(.trailing, 6)
              Text(marker(line))
                .frame(width: 12)
                .foregroundStyle(tint(line))
              Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .marker ? Color.junoMutedForeground : Color.primary)
                .padding(.trailing, JunoSpace.cozy)
            }
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            .foregroundStyle(Color.junoMutedForeground)
            .frame(minHeight: 20)
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .background(background(line))
          }
        }
      }
    }
  }

  private func marker(_ line: UnifiedDiff.Line) -> String {
    switch line.kind {
    case .addition: "+"
    case .deletion: "−"
    case .context: " "
    case .marker: "\\"
    }
  }

  private func tint(_ line: UnifiedDiff.Line) -> Color {
    switch line.kind {
    case .addition: Color.junoSuccess
    case .deletion: Color.junoDanger
    default: Color.junoMutedForeground
    }
  }

  private func background(_ line: UnifiedDiff.Line) -> Color {
    switch line.kind {
    case .addition: Color.junoSuccess.opacity(0.12)
    case .deletion: Color.junoDanger.opacity(0.12)
    default: .clear
    }
  }
}

// MARK: - Terminal

/// The live log: monospace, auto-following the tail while the reader has not
/// scrolled up.
struct JunoMobileTerminalView: View {
  let lines: [String]
  var live = false

  @State private var isNearBottom = true
  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if lines.isEmpty {
      ContentUnavailableView {
        Label { Text("Terminal idle") } icon: { JunoIconView(.terminal, size: 28) }
      } description: {
        Text("Commands the agent runs stream here.")
      }
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            HStack(alignment: .top, spacing: JunoSpace.snug) {
              Text("\(index + 1)")
                .frame(width: 34, alignment: .trailing)
                .junoMetaInk()
              Text(line.isEmpty ? " " : line)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .junoFont(size: 12, relativeTo: .caption, design: .monospaced)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(minHeight: 20)
          }
          if live {
            JunoShimmerText("Running…", font: .caption.monospaced())
              .padding(.horizontal, JunoSpace.cozy)
              .padding(.top, JunoSpace.tight)
          }
        }
        .padding(.vertical, JunoSpace.cozy)
        .textSelection(.enabled)
      }
      .background(Color.junoTerminal)
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .defaultScrollAnchor(.top, for: .alignment)
      .scrollPosition($scrollPosition)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentSize.height <= geometry.containerSize.height
          || geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 80
      } action: { _, nearBottom in
        isNearBottom = nearBottom
      }
      .onChange(of: lines.count) { _, _ in
        guard isNearBottom else { return }
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
          scrollPosition.scrollTo(edge: .bottom)
        }
      }
      .accessibilityIdentifier("juno.mobile.code-terminal")
    }
  }
}

// MARK: - New session

/// Starts a session on a host: pick a shared folder, write the first prompt.
struct JunoMobileCodeRemoteNewSessionSheet: View {
  let host: CodeRemoteHostSummary
  let workspaces: [NativeCodeDevice.Workspace]
  let start: (NativeCodeDevice.Workspace?, String) async -> Void

  @State private var workspaceID: String = ""
  @State private var prompt = ""
  @State private var isStarting = false
  @FocusState private var focused: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section("Where") {
          Picker("Folder", selection: $workspaceID) {
            ForEach(workspaces) { workspace in
              Text(workspace.name).tag(workspace.id)
            }
          }
          LabeledContent("Computer", value: host.name)
        }
        Section("What") {
          TextField("Describe the task", text: $prompt, axis: .vertical)
            .lineLimit(3...10)
            .focused($focused)
            .accessibilityIdentifier("juno.mobile.code-remote-new-prompt")
        }
      }
      .scrollContentBackground(.hidden)
      .junoScreenCanvas()
      .navigationTitle("New session")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if isStarting {
            ProgressView()
          } else {
            Button("Start") {
              isStarting = true
              let workspace = workspaces.first { $0.id == workspaceID }
              let text = prompt
              Task {
                await start(workspace, text)
                isStarting = false
                dismiss()
              }
            }
            .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("juno.mobile.code-remote-new-start")
          }
        }
      }
      .onAppear {
        if workspaceID.isEmpty { workspaceID = workspaces.first?.id ?? "" }
        focused = true
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}
