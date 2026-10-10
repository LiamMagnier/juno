import JunoCodeCore
import JunoCodeRemote
import JunoCore
import JunoSync
import JunoDesignSystem
import SwiftUI

/// One session on a paired Mac, live. The thread is the screen: it streams
/// over the device link, approvals are answered at its foot, the changes it
/// made sit as one line at the end of it (the diff review opens from there),
/// and the rest (Terminal, Screens, Ship, Continue on) lives in the "…" menu.
struct JunoMobileLinkThreadView: View {
  @Bindable var model: CodeLinkRemoteModel

  @State private var sheet: JunoMobileLinkSurface?
  @State private var handoffNotice: JunoMobileHandoffNotice?
  @State private var attentionHaptic = JunoMobileHapticTrigger()
  @Environment(\.junoThreadSync) private var threadSync

  private var snapshot: CodeV2.SessionSnapshot? { model.openSnapshot }

  private var handoff: JunoHandoff? {
    guard let deviceID = model.selectedDeviceID, let sessionID = model.openSessionID else { return nil }
    return .code(deviceID: deviceID, sessionID: sessionID, title: snapshot?.title)
  }

  var body: some View {
    JunoMobileLinkThreadList(model: model, openChanges: { sheet = .changes })
      .junoScreenCanvas()
      .navigationTitle(snapshot?.title ?? "Session")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 0) {
            Text(snapshot?.title ?? "Session")
              .font(.subheadline.weight(.medium))
              .lineLimit(1)
            Text(placeLine)
              .font(.caption)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(1)
          }
          .accessibilityElement(children: .combine)
        }
        ToolbarItem(placement: .topBarTrailing) { menu }
      }
      .safeAreaInset(edge: .bottom) { JunoMobileLinkFooter(model: model) }
      .sheet(item: $sheet) { surface in
        JunoMobileLinkSurfaceSheet(model: model, surface: surface)
      }
      .junoHaptic(JunoMobileHaptic.attention, trigger: attentionHaptic)
      .junoHandoff(handoff)
      .junoHandoffNotice($handoffNotice)
      .modifier(JunoMobileLinkThreadSyncModifier(model: model))
      .onChange(of: model.pendingRequests.first?.id) { _, id in
        if id != nil { attentionHaptic.fire() }
      }
      .accessibilityIdentifier("juno.mobile.link-thread")
  }

  private var menu: some View {
    Menu {
      Section {
        ForEach(JunoMobileLinkSurface.allCases) { surface in
          Button {
            sheet = surface
          } label: {
            Label(surface.title, image: surface.icon.assetName(.regular))
          }
        }
      }
      if let handoff {
        JunoMobileContinueOnMenu(handoff: handoff, notice: $handoffNotice)
      }
    } label: {
      JunoIconView(.ellipsis, size: 18)
        .foregroundStyle(Color.primary)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("More")
    .accessibilityIdentifier("juno.mobile.link-thread-menu")
  }

  /// "Studio, shop" under the title: where this runs.
  private var placeLine: String {
    let mac = model.selectedMac?.name ?? "Mac"
    guard let cwd = snapshot?.cwd else { return mac }
    let folder = CodeLinkFolderBrowser.name(of: cwd)
    if let branch = snapshot?.worktree?.branch { return "\(mac), \(folder) on \(branch)" }
    return "\(mac), \(folder)"
  }
}

/// The surfaces that open over the thread.
enum JunoMobileLinkSurface: String, CaseIterable, Identifiable, Hashable {
  case changes, terminal, screens, ship
  var id: String { rawValue }
  var title: String {
    switch self {
    case .changes: "Changes"
    case .terminal: "Terminal"
    case .screens: "Screens"
    case .ship: "Commit and push"
    }
  }

  var icon: JunoIcon {
    switch self {
    case .changes: .fileDiff
    case .terminal: .terminal
    case .screens: .monitor
    case .ship: .gitCommit
    }
  }
}

/// One surface as a sheet: its own title bar and Done.
struct JunoMobileLinkSurfaceSheet: View {
  @Bindable var model: CodeLinkRemoteModel
  let surface: JunoMobileLinkSurface
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        switch surface {
        case .changes: JunoMobileLinkChangesView(model: model)
        case .terminal: JunoMobileLinkTerminalView(model: model)
        case .screens: JunoMobileLinkScreensView(model: model)
        case .ship: JunoMobileLinkShipView(model: model)
        }
      }
      .junoScreenCanvas()
      .navigationTitle(surface.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { JunoMobileSheetClose(label: "Done") { dismiss() } }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
  }
}

/// The app's thread sync for an open link session: one poller shared with
/// Chat, drafts and prefs through it, read on open, flushed on leave.
struct JunoMobileLinkThreadSyncModifier: ViewModifier {
  @Bindable var model: CodeLinkRemoteModel
  @Environment(\.junoThreadSync) private var threadSync

  func body(content: Content) -> some View {
    content
      .task(id: "\(model.threadKey ?? ""):\(threadSync != nil)") {
        guard let key = model.threadKey else { return }
        guard let threadSync else {
          await model.runThreadSync()
          return
        }
        model.externalSync = threadSync
        if let state = await threadSync.opened(key) {
          await model.applyRemote(state)
        }
        await threadSync.follow([key]) { state in
          await model.applyRemote(state)
        }
      }
      .onDisappear {
        guard let key = model.threadKey, let threadSync else { return }
        Task { await threadSync.flush(key) }
      }
  }
}

extension JunoMobileThreadSync: CodeLinkThreadSyncing {}

// MARK: - The thread

struct JunoMobileLinkThreadList: View {
  @Bindable var model: CodeLinkRemoteModel
  var openChanges: () -> Void

  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  @State private var isNearBottom = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var snapshot: CodeV2.SessionSnapshot? { model.openSnapshot }
  private var items: [CodeV2.TurnItem] { snapshot?.items ?? [] }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: JunoSpace.regular) {
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
          JunoMobileLinkItem(
            item: item,
            nextDate: index + 1 < items.count ? items[index + 1].createdDate : nil
          )
        }
        if let changes = changeSummary {
          JunoMobileLinkChangesRow(files: changes.files, additions: changes.additions, deletions: changes.deletions, open: openChanges)
        }
        ForEach(snapshot?.queue ?? []) { queued in
          JunoMobileCodeQueuedPrompt(text: queued.input.text)
        }
        if snapshot?.state == .running, !isStreamingText {
          JunoShimmerText(workingLine, font: .subheadline)
            .padding(.leading, JunoSpace.hairline)
            .accessibilityIdentifier("juno.mobile.link-working")
        }
        if let message = model.openThread?.stateMessage, snapshot?.state == .limited || snapshot?.state == .error {
          JunoMobileLinkNotice(icon: .clockAlert, text: message)
        }
        if model.openThread?.cursor == nil {
          JunoShimmerText("Opening the session on \(model.selectedMac?.name ?? "your Mac")", font: .subheadline)
        }
        if let error = model.lastError {
          JunoInlineError(message: error)
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .frame(maxWidth: JunoMobileMeasure.reading)
      .frame(maxWidth: .infinity)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: items.count)
    }
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
    .onChange(of: model.openThread?.cursor) { _, _ in
      guard isNearBottom else { return }
      withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) {
        scrollPosition.scrollTo(edge: .bottom)
      }
    }
    .accessibilityIdentifier("juno.mobile.link-thread-list")
  }

  /// Every file the session changed, merged by path: one line at the end of the thread.
  private var changeSummary: (files: Int, additions: Int, deletions: Int)? {
    if !model.threadDiff.isEmpty {
      return (model.threadDiff.count, model.threadDiff.reduce(0) { $0 + $1.additions }, model.threadDiff.reduce(0) { $0 + $1.deletions })
    }
    var merged: [String: (Int, Int)] = [:]
    for case let .fileChange(change) in items where change.status != .declined && change.status != .failed {
      for entry in change.changes {
        let old = merged[entry.path] ?? (0, 0)
        merged[entry.path] = (old.0 + (entry.additions ?? 0), old.1 + (entry.deletions ?? 0))
      }
    }
    guard !merged.isEmpty else { return nil }
    return (merged.count, merged.values.reduce(0) { $0 + $1.0 }, merged.values.reduce(0) { $0 + $1.1 })
  }

  private var isStreamingText: Bool {
    if case let .assistantMessage(message)? = items.last { return message.streaming }
    return false
  }

  /// What the agent is doing right now, in its own words when it has them.
  private var workingLine: String {
    for item in items.reversed() {
      if case let .subagent(agent) = item, agent.status == .running, let line = agent.liveLine { return line }
      if let row = CodeV2StepRow.make(item), row.state == .running, row.glyph != .plan {
        return [row.verb, row.object].compactMap { $0 }.joined(separator: " ")
      }
    }
    return "Working"
  }
}

/// One thread item, in Alevr's iOS grammar.
struct JunoMobileLinkItem: View {
  let item: CodeV2.TurnItem
  var nextDate: Date?

  var body: some View {
    switch item {
    case let .userMessage(message):
      HStack {
        Spacer(minLength: JunoSpace.section)
        Text(message.text)
          .font(.body)
          .lineSpacing(3)
          .textSelection(.enabled)
          .padding(.horizontal, JunoSpace.regular)
          .padding(.vertical, JunoSpace.cozy)
          .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: JunoRadius.message, style: .continuous))
      }
      .accessibilityLabel("You said, \(message.text)")
    case let .assistantMessage(message):
      JunoMarkdownText(message.text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    case let .reasoning(reasoning):
      JunoMobileLinkDisclosure(
        icon: .brain,
        title: CodeV2StepRow.make(item, nextDate: nextDate)?.verb ?? "Thinking",
        live: reasoning.streaming
      ) {
        Text(reasoning.text)
          .font(.footnote)
          .foregroundStyle(Color.junoSecondaryInk)
      }
    case let .plan(plan):
      JunoMobileLinkPlanCard(title: plan.awaitingApproval == true ? "Plan, waiting for you" : "Plan", text: plan.text, steps: (plan.steps ?? []).map { ($0.text, $0.status) })
    case let .todoList(list):
      JunoMobileLinkPlanCard(title: "To do", text: nil, steps: list.todos.map { ($0.text, $0.status) })
    case let .commandExecution(command):
      JunoMobileLinkCommandRow(command: command)
    case .fileChange:
      // Summed into the changes line at the end of the thread.
      EmptyView()
    case let .approvalRequest(request):
      // A pending one is answered at the foot of the thread.
      if request.status != .pending { stepRow }
    case let .userInputRequest(request):
      if request.status != .pending { stepRow }
    case let .subagent(agent):
      JunoMobileLinkSubagentRow(agent: agent)
    case let .error(error):
      JunoInlineError(message: error.message)
    case .checkpoint:
      EmptyView()
    case let .conversationMessage(message):
      JunoMobileLinkStep(icon: .message, verb: message.direction == .received ? "From \(message.peerTitle)" : "To \(message.peerTitle)", object: message.text, state: .done)
    case let .computerAction(action):
      JunoMobileLinkStep(icon: .monitor, verb: action.summary ?? action.action.rawValue.replacingOccurrences(of: "_", with: " ").capitalized, object: action.app, state: action.status == .running ? .running : action.status == .failed ? .failed : .done)
    default:
      stepRow
    }
  }

  @ViewBuilder
  private var stepRow: some View {
    if let row = CodeV2StepRow.make(item, nextDate: nextDate) {
      JunoMobileLinkStep(icon: Self.icon(row.glyph), verb: row.verb, object: row.object, detail: row.detail, state: row.state)
    }
  }

  static func icon(_ glyph: CodeV2StepRow.Glyph) -> JunoIcon {
    switch glyph {
    case .reasoning: .brain
    case .plan: .listChecks
    case .edit: .pencil
    case .terminal: .terminal
    case .search: .search
    case .web: .web
    case .approval: .permission
    case .interrupt: .circleStop
    case .notice: .info
    case .error: .error
    case .compaction: .layers
    case .handoff: .arrowLeftRight
    case .question: .circleHelp
    case .file: .file
    case .message: .message
    }
  }
}

/// Glyph, verb, object in mono: one line of the work log.
struct JunoMobileLinkStep: View {
  let icon: JunoIcon
  let verb: String
  var object: String?
  var detail: String?
  var state: CodeV2StepRow.State = .done

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
      Group {
        if state == .running {
          ProgressView().controlSize(.mini).tint(Color.junoAccent)
        } else {
          JunoIconView(icon, size: 13)
            .foregroundStyle(state == .failed ? Color.junoDanger : Color.junoTertiaryInk)
        }
      }
      .frame(width: 16)
      Text(verb)
        .font(.subheadline)
        .foregroundStyle(state == .failed ? Color.junoDanger : Color.primary)
        .layoutPriority(1)
      if let object, !object.isEmpty {
        Text(object)
          .font(.footnote.monospaced())
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if let detail {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(Color.junoTertiaryInk)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

struct JunoMobileLinkDisclosure<Content: View>: View {
  let icon: JunoIcon
  let title: String
  var live = false
  @ViewBuilder var content: Content
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      Button {
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { open.toggle() }
      } label: {
        HStack(spacing: JunoSpace.snug) {
          JunoIconView(icon, size: 13).foregroundStyle(Color.junoTertiaryInk).frame(width: 16)
          if live {
            JunoShimmerText(title, font: .subheadline)
          } else {
            Text(title).font(.subheadline).foregroundStyle(Color.junoSecondaryInk)
          }
          JunoIconView(.chevronDown, size: 10)
            .foregroundStyle(Color.junoTertiaryInk)
            .rotationEffect(.degrees(open ? 180 : 0))
          Spacer(minLength: 0)
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if open {
        content
          .padding(.leading, JunoSpace.section)
          .transition(.opacity)
      }
    }
  }
}



/// A command with its exit and, on tap, its output.
struct JunoMobileLinkCommandRow: View {
  let command: CodeV2.CommandExecution
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var running: Bool { command.status == .running || command.status == .pending }
  private var failed: Bool { command.status == .failed || (command.exitCode ?? 0) != 0 }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      Button {
        withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion)) { open.toggle() }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
          Group {
            if running {
              ProgressView().controlSize(.mini).tint(Color.junoAccent)
            } else {
              JunoIconView(.terminal, size: 13).foregroundStyle(failed ? Color.junoDanger : Color.junoTertiaryInk)
            }
          }
          .frame(width: 16)
          Text(command.command)
            .font(.footnote.monospaced())
            .foregroundStyle(Color.primary)
            .lineLimit(open ? 6 : 1)
            .truncationMode(.tail)
          Spacer(minLength: JunoSpace.hairline)
          if let exit = command.exitCode, exit != 0 {
            Text("exit \(exit)").font(.footnote).foregroundStyle(Color.junoDanger)
          } else if let ms = command.durationMs, !running {
            Text(CodeV2Formatting.duration(seconds: max(1, ms / 1000)))
              .font(.footnote)
              .monospacedDigit()
              .foregroundStyle(Color.junoTertiaryInk)
          }
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Command \(command.command)")
      let tail = CodeV2Formatting.tail(command.output, lines: open ? 40 : 3)
      if !tail.isEmpty, open || running {
        Text(tail.joined(separator: "\n"))
          .font(.caption.monospaced())
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(JunoSpace.snug)
          .background(Color.junoTerminal, in: RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
          .padding(.leading, JunoSpace.section)
          .textSelection(.enabled)
      }
    }
  }
}


struct JunoMobileLinkSubagentRow: View {
  let agent: CodeV2.Subagent

  private var words: String {
    switch agent.status {
    case .running: agent.liveLine ?? "Working"
    case .waiting: "Needs you"
    case .completed: "Done"
    case .failed: "Stopped with an error"
    case .interrupted: "Stopped"
    }
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
      JunoIconView(.agents, size: 13).foregroundStyle(Color.junoTertiaryInk).frame(width: 16)
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(agent.label ?? agent.title ?? agent.role.rawValue.capitalized)
          .font(.subheadline)
        Text("\(CodeV2Team.shortModelName(agent.model.model)), \(words)")
          .font(.footnote)
          .foregroundStyle(agent.status == .running || agent.status == .waiting ? Color.junoAccent : Color.junoSecondaryInk)
          .lineLimit(2)
      }
    }
  }
}


/// The changes so far, one line: "2 files changed +20 −2". Opens the review.
struct JunoMobileLinkChangesRow: View {
  let files: Int
  let additions: Int
  let deletions: Int
  let open: () -> Void

  var body: some View {
    Button(action: open) {
      HStack(spacing: JunoSpace.snug) {
        JunoIconView(.fileDiff, size: 13).foregroundStyle(Color.junoTertiaryInk).frame(width: 16)
        Text(files == 1 ? "1 file changed" : "\(files) files changed")
          .foregroundStyle(Color.primary)
        Text("+\(additions)").foregroundStyle(Color.junoSuccess)
        Text("\u{2212}\(deletions)").foregroundStyle(Color.junoDanger)
        Spacer(minLength: 0)
        Text("Review").foregroundStyle(Color.junoSecondaryInk)
        JunoIconView(.chevronRight, size: 10).foregroundStyle(Color.junoTertiaryInk)
      }
      .font(.subheadline)
      .monospacedDigit()
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("juno.mobile.link-changes-row")
  }
}

/// A plan or a to-do list: a quiet list in the thread, no slab behind it.
struct JunoMobileLinkPlanCard: View {
  let title: String
  let text: String?
  let steps: [(String, CodeV2.StepStatus)]

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      Text(title)
        .font(.footnote)
        .foregroundStyle(Color.junoTertiaryInk)
      if let text, !text.isEmpty, steps.isEmpty {
        JunoMarkdownText(text)
      }
      ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
          Group {
            switch step.1 {
            case .completed: JunoIconView(.circleCheck, size: 12).foregroundStyle(Color.junoTertiaryInk)
            case .inProgress: JunoIconView(.circleDashed, size: 12).foregroundStyle(Color.junoAccent)
            case .pending: JunoIconView(.circle, size: 12).foregroundStyle(Color.junoTertiaryInk)
            }
          }
          .frame(width: 16)
          Text(step.0)
            .font(.footnote)
            .foregroundStyle(step.1 == .completed ? Color.junoTertiaryInk : Color.primary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Approvals and questions

/// What the Mac asks, at the thread's foot: the command in mono, its reason
/// on one line, and small answers (Deny, Allow; this session's standing
/// permission as a quiet text button).
struct JunoMobileLinkApprovalCard: View {
  let request: CodeV2.ApprovalRequest
  var isBusy = false
  let decide: (CodeV2.ApprovalDecision) -> Void

  private var heading: String {
    switch request.action {
    case .command: "Run this command?"
    case .fileChange: "Make these edits?"
    case .permissions: "Change its permissions?"
    case .tool: "Use this tool?"
    case .computer: "Use your Mac's screen?"
    }
  }

  private var offersSession: Bool { request.options?.contains(.acceptForSession) ?? false }

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.tight) {
      HStack(spacing: JunoSpace.snug) {
        Text(heading).font(.subheadline.weight(.medium)).foregroundStyle(Color.junoAccent)
        Spacer(minLength: 0)
        if let agent = request.agentLabel {
          Text(agent).font(.footnote).foregroundStyle(Color.junoSecondaryInk).lineLimit(1)
        }
      }
      Text(request.summary)
        .font(request.action == .command ? .footnote.monospaced() : .subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .lineLimit(3)
      if let why = request.justification, !why.isEmpty {
        Text(why).font(.footnote).foregroundStyle(Color.junoSecondaryInk).lineLimit(1)
      }
      HStack(spacing: JunoSpace.snug) {
        if offersSession {
          Button { decide(.acceptForSession) } label: {
            Text("Always this session")
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("juno.mobile.link-allow-session")
        }
        Spacer(minLength: 0)
        JunoMobileLinkSmallButton(title: "Deny", prominent: false) { decide(.decline) }
          .accessibilityIdentifier("juno.mobile.link-deny")
        JunoMobileLinkSmallButton(title: "Allow", prominent: true) { decide(.accept) }
          .accessibilityIdentifier("juno.mobile.link-allow")
      }
    }
    .disabled(isBusy)
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.top, JunoSpace.cozy)
    .padding(.bottom, JunoSpace.micro)
    .junoGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.link-approval")
  }
}

/// A 32pt capsule that still takes a 44pt touch.
struct JunoMobileLinkSmallButton: View {
  let title: String
  var prominent = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(prominent ? Color.junoCanvas : Color.primary)
        .padding(.horizontal, JunoSpace.regular)
        .frame(height: 32)
        .background {
          if prominent {
            Capsule().fill(Color.junoAccent)
          } else {
            Capsule().fill(Color.junoMuted)
          }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
    .buttonStyle(.junoPress)
  }
}


/// A question the agent asked: tap an option, or write an answer.
struct JunoMobileLinkQuestionCard: View {
  let request: CodeV2.UserInputRequest
  var isBusy = false
  let answer: ([String: [String]]) -> Void

  @State private var picks: [String: Set<String>] = [:]
  @State private var typed: [String: String] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      Text("It asks you").font(.subheadline.weight(.medium)).foregroundStyle(Color.junoAccent)
      ForEach(request.questions, id: \.id) { question in
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          Text(question.prompt).font(.callout)
          if let options = question.options, !options.isEmpty {
            ForEach(options, id: \.self) { option in
              let chosen = picks[question.id, default: []].contains(option)
              Button {
                toggle(option, in: question)
              } label: {
                HStack {
                  Text(option).font(.subheadline)
                  Spacer(minLength: 0)
                  if chosen { JunoIconView(.check, size: 13) }
                }
                .padding(.horizontal, JunoSpace.cozy)
                .frame(height: 36)
                .background(Color.junoMuted.opacity(chosen ? 1 : 0.5), in: Capsule())
                .padding(.vertical, 4)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
          } else {
            TextField("Your answer", text: Binding(get: { typed[question.id] ?? "" }, set: { typed[question.id] = $0 }), axis: .vertical)
              .font(.body)
              .padding(.horizontal, JunoSpace.cozy)
              .frame(minHeight: 44)
              .background(Color.junoMuted.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
      }
      HStack {
        Spacer(minLength: 0)
        JunoMobileLinkSmallButton(title: "Answer", prominent: true) { answer(answers) }
          .disabled(isBusy || answers.isEmpty)
      }
    }
    .padding(.horizontal, JunoSpace.cozy)
    .padding(.top, JunoSpace.cozy)
    .padding(.bottom, JunoSpace.micro)
    .junoGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .accessibilityIdentifier("juno.mobile.link-question")
  }

  private var answers: [String: [String]] {
    var result: [String: [String]] = [:]
    for question in request.questions {
      if let set = picks[question.id], !set.isEmpty {
        result[question.id] = question.options?.filter(set.contains) ?? Array(set)
      } else if let text = typed[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
        result[question.id] = [text]
      }
    }
    return result
  }

  private func toggle(_ option: String, in question: CodeV2.UserInputQuestion) {
    var set = picks[question.id, default: []]
    if question.multiSelect == true {
      if set.contains(option) { set.remove(option) } else { set.insert(option) }
    } else {
      set = [option]
    }
    picks[question.id] = set
  }
}
