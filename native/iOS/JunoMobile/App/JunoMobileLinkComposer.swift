import JunoCodeCore
import JunoCodeRemote
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// The thread's foot, for a live session and for a new one alike (owner,
// Oct 11, after Codex): New session opens this same screen empty, with the
// computer and the project as two plain rows over the composer, and the first
// message turns it into the thread in place.
//
// Type: regular and medium only. Coral is for working and needs-you.

/// What opens over the composer: a glass panel growing out of its control.
enum JunoMobileLinkPanel: Equatable {
  case computer, project, mode, effort
}

/// The thread's foot: the pinned request (approval or question), the place
/// rows while a new session is being written, then the composer. Send makes
/// the session (new), starts a turn (idle) or queues (working); Steer now
/// speaks into the running turn; Stop ends it.
struct JunoMobileLinkFooter: View {
  @Bindable var model: CodeLinkRemoteModel
  /// Opens dictating (the home's microphone brought the person here).
  var dictateOnAppear = false
  /// Opens with this panel up: the offscreen snapshots only.
  var previewPanel: JunoMobileLinkPanel? = nil
  /// The screen's attachment surfaces, which the "+" presents.
  var attachments: JunoMobileAttachmentCoordinator? = nil

  @FocusState private var focused: Bool
  @State private var panel: JunoMobileLinkPanel?
  @State private var sendHaptic = JunoMobileHapticTrigger()
  @State private var stopHaptic = JunoMobileHapticTrigger()
  @State private var approveHaptic = JunoMobileHapticTrigger()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.junoStartCodeVoice) private var startCodeVoice
  @Environment(\.junoCodeVoiceSession) private var codeVoice

  private var typed: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var drafting: Bool { model.isDraftingNewSession }

  private var placeholder: String {
    if drafting { return "Work on \(model.selectedMac?.name ?? "your Mac")" }
    return model.isRunning ? "Queue a follow-up" : "Ask for a change"
  }

  private var canSend: Bool {
    guard typed || !model.draftAttachments.isEmpty, !model.isSending, model.composer.selection != nil else { return false }
    if drafting {
      guard let mac = model.selectedMac, model.linkError == nil else { return false }
      let reachable = mac.reachability == .online || mac.reachability == .unknown
      return reachable && model.newSession?.cwd != nil
    }
    return !model.isStartingNewSession
  }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if let panel {
        panelView(panel)
          .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
      } else if let request = model.pendingRequests.first {
        pinned(request)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      if panel == nil, model.isRunning, typed, model.canSteer {
        Button {
          let text = model.draft
          sendHaptic.fire()
          Task { await model.steer(text) }
        } label: {
          HStack(spacing: JunoSpace.hairline) {
            JunoIconView(.cornerDownRight, size: 13)
            Text("Steer now instead of queueing")
          }
          .font(.subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
          .padding(.horizontal, JunoSpace.cozy)
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.mobile.link-steer")
        .transition(.opacity)
      }
      if drafting {
        JunoMobileLinkPlaceRows(model: model, panel: $panel)
          .transition(.opacity)
      }
      JunoMobileCodeComposer(
        text: $model.draft,
        placeholder: placeholder,
        focused: $focused,
        voice: codeVoice,
        canSend: canSend,
        isRunning: model.isRunning,
        send: send,
        stop: {
          stopHaptic.fire()
          Task { await model.interrupt() }
        },
        startVoice: startCodeVoice.map { begin in
          { begin(JunoMobileCodeVoiceRelay.briefing(place: placeLine, turns: spokenTurns)) }
        },
        dictateOnAppear: dictateOnAppear,
        trailing: gauge,
        header: model.draftAttachments.isEmpty ? nil : AnyView(JunoMobileLinkAttachmentStrip(model: model))
      ) {
        if let attachments {
          JunoMobileLinkAttachMenu(coordinator: attachments, enabled: model.canAttachMore) {
            focused = false
            panel = nil
          }
        }
        JunoMobileLinkComposerControls(model: model, panel: $panel)
      }
      .accessibilityIdentifier("juno.mobile.link-composer")
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.bottom, JunoSpace.snug)
    .frame(maxWidth: JunoMobileMeasure.reading)
    .frame(maxWidth: .infinity)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: model.pendingRequests.first?.id)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: model.isRunning && typed)
    .animation(JunoMotion.panelOpen(reduceMotion: reduceMotion), value: panel)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: drafting)
    .junoHaptic(JunoMobileHaptic.send, trigger: sendHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: stopHaptic)
    .junoHaptic(JunoMobileHaptic.approve, trigger: approveHaptic)
    .junoCodeVoiceLink(codeVoice, isRunning: model.isRunning, latestReply: latestReply) { sentence in
      deliver(sentence)
    }
    .onChange(of: focused) { _, now in if now { panel = nil } }
    .onAppear {
      if let previewPanel { panel = previewPanel }
      // The empty thread opens ready to type, keyboard up, as Codex's does.
      if drafting, !dictateOnAppear, previewPanel == nil {
        Task {
          try? await Task.sleep(for: .milliseconds(350))
          focused = true
        }
      }
    }
  }

  // MARK: Panels

  @ViewBuilder
  private func panelView(_ which: JunoMobileLinkPanel) -> some View {
    Group {
      switch which {
      case .computer: JunoMobileLinkComputerPanel(model: model) { panel = nil }
      case .project: JunoMobileLinkProjectPanel(model: model) { panel = nil }
      case .mode: JunoMobileLinkModePanel(model: model) { panel = nil }
      case .effort: JunoMobileLinkEffortPanel(model: model)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .junoGlass(in: RoundedRectangle(cornerRadius: JunoMobileComposerPanelMetrics.radius, style: .continuous))
  }

  /// The effort gauge, on the row's right, when the model has levels.
  private var gauge: AnyView? {
    let levels = model.composer.effortLevels(in: model.catalogue)
    guard !levels.isEmpty else { return nil }
    let index = model.composer.selection?.effort.flatMap { levels.firstIndex(of: $0) }
    let fraction = index.map { Double($0) / Double(max(levels.count - 1, 1)) } ?? 0.5
    return AnyView(
      Button {
        focused = false
        panel = panel == .effort ? nil : .effort
      } label: {
        JunoDialGlyph(fraction: fraction, size: 19, lineWidth: 1.6)
          .foregroundStyle(panel == .effort ? Color.primary : Color.junoSecondaryInk)
          .frame(width: 40, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.junoQuietPress)
      .accessibilityLabel("Thinking")
      .accessibilityValue(model.composer.selection?.effort?.title ?? "")
      .accessibilityIdentifier("juno.mobile.link-effort")
    )
  }

  // MARK: Requests

  @ViewBuilder
  private func pinned(_ item: CodeV2.TurnItem) -> some View {
    switch item {
    case let .approvalRequest(request):
      JunoMobileLinkApprovalCard(request: request, isBusy: model.isSending) { decision in
        approveHaptic.fire()
        Task { await model.respond(to: request.requestId, decision: decision) }
      }
    case let .userInputRequest(request):
      JunoMobileLinkQuestionCard(request: request, isBusy: model.isSending) { answers in
        Task { await model.answer(request.requestId, answers: answers) }
      }
    default:
      EmptyView()
    }
  }

  // MARK: Sending

  private func send() {
    let text = typed ? model.draft : "See the attached files."
    guard typed || !model.draftAttachments.isEmpty else { return }
    sendHaptic.fire()
    panel = nil
    deliver(text)
  }

  private func deliver(_ text: String) {
    if model.isDraftingNewSession {
      Task { await model.startNewSession(text) }
    } else {
      focused = false
      Task { await model.send(text) }
    }
  }

  // MARK: Voice

  private var placeLine: String {
    let mac = model.selectedMac?.name ?? "your Mac"
    let cwd = model.openSnapshot?.cwd ?? model.newSession?.cwd
    return cwd.map { "\(CodeLinkFolderBrowser.name(of: $0)) on \(mac)" } ?? mac
  }

  private var spokenTurns: [(role: JunoVoiceTranscriptRole, text: String)] {
    (model.openSnapshot?.items ?? []).compactMap { item in
      switch item {
      case let .userMessage(message): (.user, message.text)
      case let .assistantMessage(message): (.assistant, message.text)
      default: nil
      }
    }
  }

  private var latestReply: String? { spokenTurns.last { $0.role == .assistant }?.text }
}

// MARK: - Where it runs

/// The computer and the project, as two plain rows over the composer: an
/// icon, the name, and an up-down chevron. No card, no heading.
struct JunoMobileLinkPlaceRows: View {
  @Bindable var model: CodeLinkRemoteModel
  @Binding var panel: JunoMobileLinkPanel?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      row(
        icon: .device,
        text: model.selectedMac?.name ?? "Choose a computer",
        muted: model.selectedMac?.reachability != .online,
        open: .computer,
        identifier: "juno.mobile.link-pick-computer"
      )
      row(
        icon: .projects,
        text: model.newSession?.cwd.map { CodeLinkFolderBrowser.name(of: $0) } ?? "Choose a project",
        muted: model.newSession?.cwd == nil,
        open: .project,
        identifier: "juno.mobile.link-pick-project"
      )
    }
    .padding(.leading, JunoSpace.snug)
  }

  private func row(icon: JunoIcon, text: String, muted: Bool, open: JunoMobileLinkPanel, identifier: String) -> some View {
    Button {
      panel = panel == open ? nil : open
    } label: {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(icon, size: 15)
          .frame(width: 20)
        Text(text)
          .lineLimit(1)
          .truncationMode(.middle)
        JunoIconView(.chevronsUpDown, size: 11)
          .foregroundStyle(Color.junoTertiaryInk)
      }
      .font(.subheadline)
      .foregroundStyle(panel == open ? Color.primary : (muted ? Color.junoTertiaryInk : Color.junoSecondaryInk))
      .frame(minHeight: 36)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }
}

/// One row of a composer panel: glyph, title, an optional line, and a check.
struct JunoMobileLinkPanelRow: View {
  let icon: JunoIcon?
  let title: String
  var detail: String?
  var checked = false
  var muted = false
  var tint: Color = .primary
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: JunoSpace.cozy) {
        if let icon {
          JunoIconView(icon, size: 16)
            .foregroundStyle(muted ? Color.junoTertiaryInk : tint)
            .frame(width: 22)
        }
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(title)
            .font(.body)
            .foregroundStyle(muted ? Color.junoTertiaryInk : tint)
            .lineLimit(1)
            .truncationMode(.middle)
          if let detail {
            Text(detail)
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: JunoSpace.snug)
        if checked {
          JunoIconView(.check, size: 14).foregroundStyle(Color.primary)
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.micro)
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// The paired Macs.
struct JunoMobileLinkComputerPanel: View {
  @Bindable var model: CodeLinkRemoteModel
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(model.macs) { mac in
        JunoMobileLinkPanelRow(
          icon: .device,
          title: mac.name,
          detail: detail(mac),
          checked: mac.id == model.selectedDeviceID,
          muted: mac.reachability != .online && mac.reachability != .unknown
        ) {
          close()
          Task { await model.chooseNewSessionMac(mac.id) }
        }
        .accessibilityIdentifier("juno.mobile.link-computer-\(mac.id)")
      }
      JunoMobileLinkPanelRow(icon: .scan, title: "Pair another Mac", muted: false, tint: Color.junoSecondaryInk) {
        close()
        junoMobileRequestPairing()
      }
    }
    .padding(.vertical, JunoSpace.snug)
    .accessibilityIdentifier("juno.mobile.link-computer-panel")
  }

  private func detail(_ mac: CodeLinkMac) -> String? {
    switch mac.reachability {
    case .online:
      let count = mac.info?.sharedFolders.count ?? 0
      return count == 1 ? "Shares 1 folder" : "Shares \(count) folders"
    case .unknown: return nil
    case .offline: return "Offline. Open Alevr on it to reach it."
    case .notPaired: return "Not paired with this iPhone"
    }
  }
}

/// The folders the Mac shares with Remote (and their folders): recent first,
/// a tap chooses, the chevron goes inside. Never anything outside them.
struct JunoMobileLinkProjectPanel: View {
  @Bindable var model: CodeLinkRemoteModel
  let close: () -> Void

  private var browser: CodeLinkFolderBrowser? { model.browser }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let browser, !browser.isAtRoot, let path = browser.path {
        HStack(spacing: JunoSpace.snug) {
          Button {
            Task { await model.browseUp() }
          } label: {
            JunoIconView(.chevronLeft, size: 14)
              .foregroundStyle(Color.primary)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Up")
          Text(path)
            .font(.footnote.monospaced())
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(1)
            .truncationMode(.head)
          Spacer(minLength: 0)
          if model.isBrowsing { ProgressView().controlSize(.mini) }
        }
        .padding(.leading, JunoSpace.snug)
        .padding(.trailing, JunoSpace.regular)
        JunoMobileLinkPanelRow(icon: .check, title: "Work in \(CodeLinkFolderBrowser.name(of: path))", tint: Color.primary) {
          choose(path)
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if browser?.isAtRoot ?? true, !model.recentFolders.isEmpty {
            heading("Recent")
            ForEach(model.recentFolders, id: \.self) { path in
              folderRow(path: path, name: CodeLinkFolderBrowser.name(of: path), isRepo: nil, detail: parentLine(path))
            }
            heading("Shared with Remote")
          }
          ForEach(browser?.rows ?? []) { entry in
            folderRow(path: entry.path, name: entry.name, isRepo: entry.isRepo, detail: nil)
          }
          if let browser, browser.rows.isEmpty {
            Text(browser.isAtRoot
              ? "\(model.selectedMac?.name ?? "This Mac") shares no folders with Remote yet. Add one in Alevr on the Mac."
              : "No folders inside this one.")
              .font(.subheadline)
              .foregroundStyle(Color.junoSecondaryInk)
              .padding(JunoSpace.regular)
          }
        }
      }
      .frame(maxHeight: 300)
      .fixedSize(horizontal: false, vertical: true)
      Divider().padding(.horizontal, JunoSpace.regular)
      JunoMobileLinkPanelRow(
        icon: .branch,
        title: "Its own worktree",
        detail: "A fresh branch beside your checkout",
        checked: model.newSession?.worktree == true
      ) {
        model.setNewSessionWorktree(!(model.newSession?.worktree ?? false))
      }
      .accessibilityIdentifier("juno.mobile.link-worktree")
    }
    .padding(.vertical, JunoSpace.snug)
    .accessibilityIdentifier("juno.mobile.link-project-panel")
  }

  private func heading(_ text: String) -> some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(Color.junoTertiaryInk)
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.micro)
  }

  private func parentLine(_ path: String) -> String {
    ((path as NSString).deletingLastPathComponent as NSString).abbreviatingWithTildeInPath
  }

  private func folderRow(path: String, name: String, isRepo: Bool?, detail: String?) -> some View {
    HStack(spacing: 0) {
      JunoMobileLinkPanelRow(
        icon: isRepo == true ? .branch : .projects,
        title: name,
        detail: detail,
        checked: model.newSession?.cwd == path
      ) {
        choose(path)
      }
      Button {
        Task { await model.browse(path) }
      } label: {
        JunoIconView(.chevronRight, size: 12)
          .foregroundStyle(Color.junoTertiaryInk)
          .frame(width: 44, height: 48)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Folders inside \(name)")
      .padding(.trailing, JunoSpace.snug)
    }
  }

  private func choose(_ path: String) {
    model.chooseNewSessionFolder(path)
    close()
  }
}

/// How much it may do without asking: the modes, each with its line.
struct JunoMobileLinkModePanel: View {
  @Bindable var model: CodeLinkRemoteModel
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(CodeLinkComposerState.modes, id: \.self) { mode in
        JunoMobileLinkPanelRow(
          icon: JunoMobileLinkComposerControls.icon(mode),
          title: mode.title,
          detail: mode.summary,
          checked: model.composer.runtimeMode == mode
        ) {
          model.composer.runtimeMode = mode
          close()
        }
        .accessibilityIdentifier("juno.mobile.link-mode-\(mode.rawValue)")
      }
      Text(model.composer.runtimeMode == .full
        ? CodeLinkComposerState.fullAccessWarning
        : "Runs on your Mac with this mode. Approvals it asks for come to this iPhone.")
        .font(.footnote)
        .foregroundStyle(model.composer.runtimeMode == .full ? Color.junoCaution : Color.junoTertiaryInk)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, JunoSpace.snug)
        .padding(.bottom, JunoSpace.hairline)
    }
    .padding(.vertical, JunoSpace.snug)
    .accessibilityIdentifier("juno.mobile.link-mode-panel")
  }
}

/// The thinking slider: the shared effort track over the model's levels.
struct JunoMobileLinkEffortPanel: View {
  @Bindable var model: CodeLinkRemoteModel

  private var catalogue: [CodeLinkModelGroup] { model.catalogue }
  private var current: CodeV2.ProviderModel? { CodeLinkComposerState.model(model.composer.selection, in: catalogue)?.1 }
  private var levels: [CodeV2.EffortLevel] { model.composer.effortLevels(in: catalogue) }

  private var ladder: JunoThinkingLadder {
    JunoThinkingLadder(
      stops: levels.map { JunoThinkingStop(id: $0.rawValue, label: $0.title, accessibilityLabel: "Effort \($0.title.lowercased())") },
      modelName: current?.label ?? "",
      defaultStopID: current?.defaultEffort?.rawValue
    )
  }

  private var stopID: Binding<String?> {
    Binding(
      get: { (model.composer.selection?.effort ?? current?.defaultEffort ?? levels.first)?.rawValue },
      set: { id in model.composer.setEffort(id.flatMap(CodeV2.EffortLevel.init(rawValue:))) }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .firstTextBaseline) {
        Text(model.composer.selection?.effort?.title ?? current?.defaultEffort?.title ?? "Thinking")
          .font(.headline.weight(.medium))
          .contentTransition(.opacity)
        Spacer(minLength: JunoSpace.snug)
        Text(JunoMobileCodeRemoteThreadView.shortModelName(current?.label ?? "Model"))
          .font(.subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
      }
      JunoEffortSlider(ladder: ladder, stopID: stopID)
        .padding(.vertical, JunoSpace.hairline)
        .accessibilityIdentifier("juno.mobile.link-effort-slider")
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.cozy)
    .accessibilityIdentifier("juno.mobile.link-effort-panel")
  }
}

// MARK: - The composer's row

/// Mode, model and the rest (plan, team, skills): quiet controls on the
/// composer's row. Effort is the gauge on the right.
struct JunoMobileLinkComposerControls: View {
  @Bindable var model: CodeLinkRemoteModel
  @Binding var panel: JunoMobileLinkPanel?

  private var catalogue: [CodeLinkModelGroup] { model.catalogue }

  var body: some View {
    modeButton
    modelMenu
    moreMenu
  }

  // MARK: Mode

  private var modeButton: some View {
    Button {
      panel = panel == .mode ? nil : .mode
    } label: {
      HStack(spacing: JunoSpace.hairline + 2) {
        JunoIconView(Self.icon(model.composer.runtimeMode), size: 16)
        if model.composer.runtimeMode == .full {
          Text(model.composer.runtimeMode.title).lineLimit(1).fixedSize()
        }
      }
      .font(.subheadline)
      .foregroundStyle(model.composer.runtimeMode == .full ? Color.junoCaution : (panel == .mode ? Color.primary : Color.junoSecondaryInk))
      .frame(minWidth: 40, minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Mode, \(model.composer.runtimeMode.title)")
    .accessibilityHint(model.composer.runtimeMode.summary)
    .accessibilityIdentifier("juno.mobile.link-mode")
  }

  static func icon(_ mode: CodeV2.RuntimeMode) -> JunoIcon {
    switch mode {
    case .readOnly: .eye
    case .ask: .hand
    case .autoEdit: .pencil
    case .auto: .shield
    case .full: .lockOpen
    }
  }

  // MARK: Model

  private var modelMenu: some View {
    Menu {
      ForEach(catalogue) { group in
        Section {
          ForEach(group.models, id: \.id) { option in
            Button {
              model.composer.choose(instance: group.instance, model: option)
            } label: {
              if model.composer.selection?.instanceId == group.instance.id, model.composer.selection?.model == option.id {
                Label(option.label, image: JunoIcon.check.assetName(.regular))
              } else {
                Text(option.label)
              }
            }
          }
        } header: {
          Text(group.title)
        } footer: {
          Text(group.note)
        }
      }
    } label: {
      JunoMobileLinkChipLabel(text: chipModelName)
    }
    .tint(Color.primary)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Model, \(model.composer.modelLabel(in: catalogue))")
    .accessibilityIdentifier("juno.mobile.link-model")
  }

  /// "Opus 5.5" on the chip; the lab lives in the menu, effort on the gauge.
  private var chipModelName: String {
    guard let selection = model.composer.selection else { return "Model" }
    let label = CodeLinkComposerState.model(selection, in: catalogue)?.1.label ?? CodeV2Formatting.modelName(selection.model)
    return JunoMobileCodeRemoteThreadView.shortModelName(label)
  }

  // MARK: Plan, team, skills

  private var moreMenu: some View {
    Menu {
      Section {
        Toggle(isOn: Binding(
          get: { model.composer.interactionMode == .plan },
          set: { model.composer.interactionMode = $0 ? .plan : .default }
        )) {
          Text("Plan first")
          Text("It proposes a plan and waits for you before it changes anything.")
        }
      }
      Section("Team") {
        ForEach(CodeV2Team.Preset.allCases, id: \.self) { preset in
          Button {
            model.composer.team = preset
          } label: {
            if model.composer.team == preset {
              Label {
                Text(preset.title)
                Text(preset.line)
              } icon: {
                Image(JunoIcon.check.assetName(.regular))
              }
            } else {
              Text(preset.title)
              Text(preset.line)
            }
          }
        }
      }
      Section("Skills") {
        if model.skills.isEmpty {
          Text("No skills on this Mac")
        }
        ForEach(model.skills, id: \.name) { skill in
          Toggle(isOn: Binding(
            get: { model.composer.skills.contains(skill.name) },
            set: { on in
              if on { model.composer.skills.append(skill.name) } else { model.composer.skills.removeAll { $0 == skill.name } }
            }
          )) {
            Text(skill.name)
            Text(skill.description)
          }
        }
      }
    } label: {
      HStack(spacing: JunoSpace.hairline + 2) {
        JunoIconView(.sliders, size: 14)
        if let summary = moreSummary {
          Text(summary).lineLimit(1).fixedSize()
        }
      }
      .font(.subheadline)
      .foregroundStyle(Color.junoSecondaryInk)
      .padding(.horizontal, JunoSpace.snug)
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .tint(Color.primary)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Plan, team and skills")
    .accessibilityIdentifier("juno.mobile.link-more")
  }

  /// A word on the control when something beyond the defaults is on.
  private var moreSummary: String? {
    var parts: [String] = []
    if model.composer.interactionMode == .plan { parts.append("Plan") }
    if model.composer.team != .solo { parts.append(model.composer.team.shortTitle) }
    if !model.composer.skills.isEmpty { parts.append(model.composer.skills.count == 1 ? "1 skill" : "\(model.composer.skills.count) skills") }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
  }
}

/// Plain text with a chevron: the chat composer's control, not a capsule.
struct JunoMobileLinkChipLabel: View {
  let text: String
  var body: some View {
    HStack(spacing: JunoSpace.hairline) {
      Text(text).lineLimit(1).fixedSize()
      JunoIconView(.chevronDown, size: 10).foregroundStyle(Color.junoTertiaryInk)
    }
    .font(.subheadline)
    .foregroundStyle(Color.junoSecondaryInk)
    .padding(.horizontal, JunoSpace.snug)
    .frame(minHeight: 44)
    .contentShape(.rect)
  }
}
