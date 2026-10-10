import JunoCodeCore
import JunoCodeRemote
import JunoDesignSystem
import SwiftUI

/// The thread's foot: the pinned request (approval or question), then the
/// composer. Send starts a turn when the session is idle and queues while it
/// works; Steer now speaks into the running turn; Stop ends it.
struct JunoMobileLinkFooter: View {
  @Bindable var model: CodeLinkRemoteModel

  @FocusState private var focused: Bool
  @State private var sendHaptic = JunoMobileHapticTrigger()
  @State private var stopHaptic = JunoMobileHapticTrigger()
  @State private var approveHaptic = JunoMobileHapticTrigger()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var typed: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if let request = model.pendingRequests.first {
        pinned(request)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      if model.isRunning, typed, model.canSteer {
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
      JunoMobileCodeComposer(
        text: $model.draft,
        placeholder: model.isRunning ? "Queue a follow-up" : "Ask for a change",
        focused: $focused,
        voice: nil,
        canSend: typed && !model.isSending && model.composer.selection != nil,
        isRunning: model.isRunning,
        send: send,
        stop: {
          stopHaptic.fire()
          Task { await model.interrupt() }
        }
      ) {
        JunoMobileLinkComposerControls(model: model)
      }
      .accessibilityIdentifier("juno.mobile.link-composer")
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.bottom, JunoSpace.snug)
    .frame(maxWidth: JunoMobileMeasure.reading)
    .frame(maxWidth: .infinity)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: model.pendingRequests.first?.id)
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: model.isRunning && typed)
    .junoHaptic(JunoMobileHaptic.send, trigger: sendHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: stopHaptic)
    .junoHaptic(JunoMobileHaptic.approve, trigger: approveHaptic)
  }

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

  private func send() {
    let text = model.draft
    guard typed else { return }
    sendHaptic.fire()
    focused = false
    Task { await model.send(text) }
  }
}

/// Model (with effort), Mode, and the rest (plan mode, team, skills) as
/// three quiet menus on the composer's row.
struct JunoMobileLinkComposerControls: View {
  @Bindable var model: CodeLinkRemoteModel

  private var catalogue: [CodeLinkModelGroup] { model.catalogue }

  var body: some View {
    modelMenu
    modeMenu
    moreMenu
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
      let levels = model.composer.effortLevels(in: catalogue)
      if !levels.isEmpty {
        Section("Effort") {
          ForEach(levels, id: \.self) { level in
            Button {
              model.composer.setEffort(level)
            } label: {
              if model.composer.selection?.effort == level {
                Label(level.title, image: JunoIcon.check.assetName(.regular))
              } else {
                Text(level.title)
              }
            }
          }
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

  /// "Opus 5.5" on the chip; the lab and the effort live in the menu.
  private var chipModelName: String {
    guard let selection = model.composer.selection else { return "Model" }
    let label = CodeLinkComposerState.model(selection, in: catalogue)?.1.label ?? CodeV2Formatting.modelName(selection.model)
    return JunoMobileCodeRemoteThreadView.shortModelName(label)
  }

  // MARK: Mode

  private var modeMenu: some View {
    Menu {
      Section {
        ForEach(CodeLinkComposerState.modes, id: \.self) { mode in
          Button {
            model.composer.runtimeMode = mode
          } label: {
            if model.composer.runtimeMode == mode {
              Label {
                Text(mode.title)
                Text(mode.summary)
              } icon: {
                Image(JunoIcon.check.assetName(.regular))
              }
            } else {
              Text(mode.title)
              Text(mode.summary)
            }
          }
        }
      } footer: {
        if model.composer.runtimeMode == .full {
          Text(CodeLinkComposerState.fullAccessWarning)
        } else {
          Text("Runs on your Mac with this mode. Approvals it asks for come to this iPhone.")
        }
      }
    } label: {
      HStack(spacing: JunoSpace.hairline + 2) {
        JunoIconView(Self.icon(model.composer.runtimeMode), size: 14)
        JunoIconView(.chevronDown, size: 10).foregroundStyle(Color.junoTertiaryInk)
      }
      .font(.subheadline)
      .foregroundStyle(model.composer.runtimeMode == .full ? Color.junoCaution : Color.junoSecondaryInk)
      .padding(.horizontal, JunoSpace.snug)
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .tint(Color.primary)
    .frame(minWidth: 44, minHeight: 44)
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

  /// A word on the chip when something beyond the defaults is on.
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
      Text(text).lineLimit(1)
      JunoIconView(.chevronDown, size: 10).foregroundStyle(Color.junoTertiaryInk)
    }
    .font(.subheadline)
    .foregroundStyle(Color.junoSecondaryInk)
    .padding(.horizontal, JunoSpace.snug)
    .frame(minHeight: 44)
    .contentShape(.rect)
  }
}
