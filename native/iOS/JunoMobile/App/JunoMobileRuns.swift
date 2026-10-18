@preconcurrency import ActivityKit
import Foundation
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoSync
import Observation
import SwiftUI
import UIKit
import UserNotifications

// MARK: - Coordinator

/// The iPhone's supervisor seat for live agent runs (REA 8): Code sessions on
/// a paired Mac and Work tasks on a Mac or a cloud computer, with Stop and
/// Approve / Deny.
///
/// Built for a phone without remote push. Everything is fed by the
/// authenticated `/api/runs/live` feed while the app is in the foreground, and
/// for the background execution time iOS grants after it leaves (about 30 s).
/// Inside that window the Live Activity keeps updating and a newly pending
/// approval raises a local notification. After it, the Live Activity keeps its
/// last state and its system-drawn clock keeps counting; the next foreground
/// (or background refresh) catches it up. Remote Live Activity updates light
/// up through ``JunoMobileRunActivityPush`` once the account can send pushes.
@MainActor
@Observable
final class JunoMobileRunsCoordinator {
  static let shared = JunoMobileRunsCoordinator()

  /// Where the Runs screen should open: one run, and whether its Stop
  /// question should be up. Set by a deep link or a notification tap.
  struct Focus: Equatable {
    var runKey: String?
    var confirmStop: Bool
    var token = UUID()
  }

  private(set) var model: LiveRunsModel?
  var presentsRuns = false
  var focus: Focus?

  @ObservationIgnored private var client: (any LiveRunsServing)?
  @ObservationIgnored private var watchTask: Task<Void, Never>?
  @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  @ObservationIgnored private let activities = JunoMobileRunActivities()
  @ObservationIgnored private(set) var authenticator: any JunoMobileOwnerAuthenticating =
    JunoMobileDeviceOwnerAuthenticator()
  /// Which kinds of run may raise a notification on this pass. A background
  /// refresh leaves Code to `JunoMobileCodeNotifications`, which already
  /// notifies for a waiting Code session on that pass.
  @ObservationIgnored private var notifyKinds: Set<LiveRun.Kind> = [.code, .work]

  private init() {}

  /// Called once at launch, where the authenticated transport is built.
  func configure(client: any LiveRunsServing) {
    self.client = client
  }

  func start(for accountID: AccountID) {
    guard let client else { return }
    let model = self.model ?? LiveRunsModel(client: client)
    model.onChange = { [weak self] previous, current in
      self?.runsChanged(previous: previous, current: current)
    }
    model.start(for: accountID)
    self.model = model
    resume()
  }

  /// Sign-out: the feed closes, the list is forgotten and every run's Live
  /// Activity ends. Nothing of the account may stay on the Lock Screen.
  func stop() {
    watchTask?.cancel()
    watchTask = nil
    model?.stop()
    activities.endAll()
    endBackgroundTask()
    presentsRuns = false
    focus = nil
  }

  /// Opens the Runs screen, from a link, a Live Activity or a notification.
  func open(runKey: String?, confirmStop: Bool) {
    focus = Focus(runKey: runKey, confirmStop: confirmStop)
    presentsRuns = true
  }

  // MARK: Scene phase

  func sceneBecameActive() {
    endBackgroundTask()
    resume()
  }

  /// Keeps the feed open for the background time iOS allows, so the Live
  /// Activity and the approval notification still work while the phone is in
  /// a pocket. When the time runs out the feed closes cleanly.
  func sceneEnteredBackground() {
    guard model?.isStarted == true, watchTask != nil, backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "alevr.live-runs") { [weak self] in
      // The expiration handler runs on the main thread.
      MainActor.assumeIsolated {
        self?.suspend()
      }
    }
  }

  /// One pass from the background refresh task: catches the Live Activities
  /// up and notifies for Work approvals (Code has its own pass).
  func backgroundRefresh() async {
    guard let model, model.isStarted else { return }
    notifyKinds = [.work]
    defer { notifyKinds = [.code, .work] }
    await model.refresh()
  }

  private func resume() {
    guard watchTask == nil, let model, model.isStarted else { return }
    watchTask = Task { [weak self] in
      await model.watch()
      self?.watchTask = nil
    }
  }

  private func suspend() {
    watchTask?.cancel()
    watchTask = nil
    endBackgroundTask()
  }

  private func endBackgroundTask() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  // MARK: Changes

  private func runsChanged(previous: [LiveRun], current: [LiveRun]) {
    activities.apply(current)
    let answered = Set(previous.flatMap { $0.approvals.map(\.id) })
      .subtracting(current.flatMap { $0.approvals.map(\.id) })
    if !answered.isEmpty {
      // Answered here, on the web or on the Mac: the notification goes too.
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: answered.map(Self.notificationID)
      )
    }
    guard UIApplication.shared.applicationState != .active else { return }
    guard UserDefaults.standard.object(forKey: JunoMobilePreferences.codeApprovalNotifications) as? Bool ?? true
    else { return }
    let fresh = LiveRunsModel.newlyPendingApprovals(previous: previous, current: current)
      .filter { notifyKinds.contains($0.run.kind) }
    for item in fresh {
      Self.notify(run: item.run, approval: item.approval)
    }
  }

  nonisolated static func notificationID(_ approvalID: String) -> String { "run-approval-\(approvalID)" }

  private static func notify(run: LiveRun, approval: LiveRunApproval) {
    let content = UNMutableNotificationContent()
    content.title = String(localized: "runs.notification.title", defaultValue: "A run needs your approval")
    content.body = "\(run.title): \(approval.summary)"
    content.sound = .default
    content.threadIdentifier = run.key
    // Opening it only navigates to the Runs screen; the answer is given there.
    content.userInfo = ["runKey": run.key]
    let request = UNNotificationRequest(identifier: notificationID(approval.id), content: content, trigger: nil)
    Task { try? await UNUserNotificationCenter.current().add(request) }
  }

  // MARK: Actions

  /// Approves or denies. A high-risk approve asks Face ID, Touch ID or the
  /// passcode first, through the same owner check the approval gate uses.
  func decide(_ approval: LiveRunApproval, on run: LiveRun, approve: Bool) async {
    guard let model else { return }
    let authenticator = self.authenticator
    await model.decide(approval, on: run, approve: approve) {
      await authenticator.authenticate(reason: Self.ownerReason(run: run)) == .confirmed
    }
  }

  static func ownerReason(run: LiveRun) -> String {
    String(
      localized: "runs.approval.gate",
      defaultValue: "Confirm it's you to allow this high-risk step in \(run.title)."
    )
  }
}

// MARK: - Live Activities

/// Whether a run's Live Activity can be updated by push when the app is not
/// running. That needs a paid Apple Developer account (the APNs key and the
/// push entitlement) and a server that sends Live Activity pushes, neither of
/// which this build has, so it is off and every update is local. Flipping
/// `serverSendsActivityPushes` after both exist requests activities with a
/// push token and hands each token to ``register(token:runKey:)``.
enum JunoMobileRunActivityPush {
  static let serverSendsActivityPushes = false

  @MainActor
  static var isAvailable: Bool {
    // A device token only exists when the push entitlement is present and
    // APNs registration succeeded, which a free account's build never does.
    serverSendsActivityPushes && NativePushRegistrar.shared.tokenHex != nil
  }

  /// Where a Live Activity push token will go once the server accepts them
  /// (alongside `/api/v1/devices/apns`). Deliberately a no-op until then.
  static func register(token _: Data, runKey _: String) async {}
}

/// One Live Activity per live run (up to two at once), started, updated and
/// ended from the live list.
@MainActor
final class JunoMobileRunActivities {
  private var activities: [String: Activity<JunoAgentRunActivityAttributes>] = [:]
  private var tokenTasks: [String: Task<Void, Never>] = [:]

  init() {
    // Activities outlive the process. Adopt the ones a previous launch left,
    // so the first list either updates them or ends them.
    for activity in Activity<JunoAgentRunActivityAttributes>.activities {
      activities[activity.attributes.runKey] = activity
    }
  }

  func apply(_ runs: [LiveRun]) {
    let plan = LiveRunActivityPlan.plan(active: Set(activities.keys), runs: runs)
    for key in plan.end { end(key) }
    for summary in plan.update {
      guard let activity = activities[summary.runKey] else { continue }
      let content = Self.content(summary)
      Task { await activity.update(content) }
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let byKey = Dictionary(runs.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    for summary in plan.start {
      guard let run = byKey[summary.runKey] else { continue }
      let attributes = JunoAgentRunActivityAttributes(
        runKey: run.key, title: run.title, hostName: run.target == .cloud ? "Cloud" : run.hostName,
        startedAt: run.startedAt
      )
      let pushes = JunoMobileRunActivityPush.isAvailable
      guard
        let activity = try? Activity.request(
          attributes: attributes, content: Self.content(summary), pushType: pushes ? .token : nil
        )
      else { continue }
      activities[run.key] = activity
      if pushes {
        let key = run.key
        tokenTasks[key] = Task {
          for await token in activity.pushTokenUpdates {
            await JunoMobileRunActivityPush.register(token: token, runKey: key)
          }
        }
      }
    }
  }

  /// Ends one run's activity with a final "Finished" card that the system
  /// keeps briefly, so the person sees how it ended.
  func end(_ key: String) {
    guard let activity = activities.removeValue(forKey: key) else { return }
    tokenTasks.removeValue(forKey: key)?.cancel()
    var state = activity.content.state
    state.finished = true
    state.needsYou = false
    state.pendingApprovals = 0
    state.statusLine = String(localized: "runs.activity.finished", defaultValue: "Finished")
    let final = ActivityContent(state: state, staleDate: nil)
    Task { await activity.end(final, dismissalPolicy: .after(.now + 60)) }
  }

  func endAll() {
    for key in Array(activities.keys) {
      guard let activity = activities.removeValue(forKey: key) else { continue }
      tokenTasks.removeValue(forKey: key)?.cancel()
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }

  private static func content(
    _ summary: LiveRunActivitySummary
  ) -> ActivityContent<JunoAgentRunActivityAttributes.ContentState> {
    ActivityContent(
      state: JunoAgentRunActivityAttributes.ContentState(
        statusLine: summary.statusLine,
        steps: summary.steps,
        currentAction: summary.currentAction,
        costUSD: summary.costUSD,
        pendingApprovals: summary.pendingApprovals,
        needsYou: summary.needsYou,
        usesComputer: summary.usesComputer,
        finished: false
      ),
      // Without pushes nothing can update it once the app is suspended; past
      // this the system marks the card as out of date instead of letting it
      // claim a step count from an hour ago is current.
      staleDate: Date(timeIntervalSinceNow: 15 * 60)
    )
  }
}

// MARK: - Runs screen

/// Every live run, needs-you first: what it is doing, for how long, at what
/// cost, with its pending approvals answered in place and a Stop that asks
/// once.
struct JunoMobileRunsView: View {
  let model: LiveRunsModel
  var coordinator: JunoMobileRunsCoordinator = .shared

  @State private var pendingStop: LiveRun?
  @State private var stopHaptic = JunoMobileHapticTrigger()
  @State private var decideHaptic = JunoMobileHapticTrigger()

  var body: some View {
    ScrollViewReader { proxy in
      List {
        if model.runs.isEmpty {
          Section {
            emptyState
          }
        } else {
          ForEach(model.runs) { run in
            Section {
              JunoMobileRunRow(run: run, stopState: model.stopStates[run.key] ?? .idle) {
                pendingStop = run
              }
              ForEach(run.approvals) { approval in
                JunoMobileRunApprovalCard(
                  approval: approval,
                  state: model.approvalStates[approval.id] ?? .idle
                ) { approve in
                  decideHaptic.fire()
                  Task { await coordinator.decide(approval, on: run, approve: approve) }
                }
              }
            }
            .id(run.key)
          }
        }
        if case .failed(let message) = model.phase {
          Section {
            Text(message).junoCaption()
          }
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .junoScreenCanvas()
      .navigationTitle("Live runs")
      .navigationBarTitleDisplayMode(.inline)
      .refreshable { await model.refresh() }
      .junoHaptic(.warning, trigger: stopHaptic)
      .junoHaptic(.impact(weight: .light), trigger: decideHaptic)
      .task(id: coordinator.focus?.token) { applyFocus(proxy) }
      .onChange(of: model.runs.map(\.key)) { _, _ in applyFocus(proxy) }
    }
    .confirmationDialog(
      pendingStop.map { "Stop \($0.title)?" } ?? "",
      isPresented: Binding(get: { pendingStop != nil }, set: { if !$0 { pendingStop = nil } }),
      titleVisibility: .visible,
      presenting: pendingStop
    ) { run in
      Button("Stop run", role: .destructive) {
        pendingStop = nil
        stopHaptic.fire()
        Task { await model.stop(run) }
      }
      .contentShape(.rect)
      Button("Keep running", role: .cancel) { pendingStop = nil }
        .contentShape(.rect)
    } message: { run in
      Text(run.kind == .code
        ? "The Mac stops this session at its next step. Changes already made stay."
        : "The task stops and cannot be resumed. Anything it already did stays done.")
    }
    .task { await model.refresh() }
    .accessibilityIdentifier("juno.mobile.runs")
  }

  private var emptyState: some View {
    VStack(alignment: .leading, spacing: JunoSpace.micro) {
      Text("Nothing is running").junoRowLabel()
      Text("Code sessions on your Mac and Work tasks show here while they run, with their approvals.")
        .junoCaption()
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, JunoSpace.micro)
  }

  /// Scrolls to the focused run and puts its Stop question up, once the run
  /// is in the list (a link can arrive before the first snapshot).
  private func applyFocus(_ proxy: ScrollViewProxy) {
    guard let focus = coordinator.focus, let key = focus.runKey else { return }
    guard let run = model.run(withKey: key) else { return }
    proxy.scrollTo(key, anchor: .top)
    if focus.confirmStop { pendingStop = run }
    coordinator.focus = nil
  }
}

private struct JunoMobileRunRow: View {
  let run: LiveRun
  let stopState: LiveRunsModel.StopState
  let onStop: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(alignment: .top, spacing: JunoSpace.cozy) {
        JunoIconView(run.usesComputer ? JunoIcon.monitor : (run.kind == .code ? JunoIcon.code : JunoIcon.work), size: 17)
          .foregroundStyle(run.needsYou ? Color.junoCaution : Color.junoSecondaryInk)
          .frame(width: 26)
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(run.title).junoRowLabel().lineLimit(2)
          Text(LiveRunActivitySummary(run).statusLine)
            .junoCaption()
            .foregroundStyle(run.needsYou ? Color.junoCaution : Color.junoSecondaryInk)
          if let action = run.currentAction {
            Text(action)
              .junoFont(size: 13, relativeTo: .footnote)
              .lineLimit(2)
          }
          metaLine
        }
        Spacer(minLength: 0)
      }
      stopControl
    }
    .padding(.vertical, JunoSpace.micro)
    .accessibilityElement(children: .contain)
  }

  private var metaLine: some View {
    HStack(spacing: JunoSpace.micro) {
      Text(run.target == .cloud ? "Cloud" : (run.hostName ?? "Mac"))
      Text("·")
      Text(run.steps == 1 ? "1 step" : "\(run.steps) steps")
      Text("·")
      Text(timerInterval: run.startedAt...Date.distantFuture, countsDown: false)
        .monospacedDigit()
      if let cost = run.costUSD {
        Text("·")
        Text(cost, format: .currency(code: "USD").precision(.fractionLength(2)))
      }
    }
    .junoFont(size: 11, relativeTo: .caption2)
    .junoMetaInk()
    .lineLimit(1)
  }

  @ViewBuilder private var stopControl: some View {
    switch stopState {
    case .idle, .failed:
      HStack {
        if case .failed(let message) = stopState {
          Text(message).junoCaption().foregroundStyle(Color.junoCaution)
        }
        Spacer(minLength: 0)
        Button(role: .destructive, action: onStop) {
          Label("Stop", image: JunoIcon.circleStop.assetName(.regular))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .disabled(!run.canStop)
        .accessibilityIdentifier("juno.mobile.runs.stop.\(run.key)")
      }
    case .stopping:
      HStack {
        Spacer(minLength: 0)
        ProgressView().controlSize(.small)
        Text("Stopping…").junoCaption()
      }
      .frame(minHeight: 44)
    case .requested:
      Text(run.hostOnline ? "Stop sent. It ends at the next step." : "Stop queued. It ends when the Mac is back.")
        .junoCaption()
        .frame(minHeight: 44, alignment: .leading)
    case .stopped:
      Text("Stopped").junoCaption().frame(minHeight: 44, alignment: .leading)
    }
  }
}

private struct JunoMobileRunApprovalCard: View {
  let approval: LiveRunApproval
  let state: LiveRunsModel.ApprovalState
  let onDecide: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      HStack(spacing: JunoSpace.micro) {
        JunoIconView(.permission, size: 15)
          .foregroundStyle(Color.junoCaution)
        Text(approval.requiresOwnerToApprove ? "High-risk approval" : "Approval")
          .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
          .foregroundStyle(approval.requiresOwnerToApprove ? Color.junoCaution : Color.junoSecondaryInk)
      }
      Text(approval.summary).junoRowLabel().fixedSize(horizontal: false, vertical: true)
      if let detail = approval.detail {
        Text(detail)
          .junoFont(size: 12, relativeTo: .caption)
          .junoMetaInk()
          .lineLimit(4)
      }
      controls
    }
    .padding(.vertical, JunoSpace.micro)
  }

  @ViewBuilder private var controls: some View {
    switch state {
    case .idle, .failed, .refused:
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        if case .failed(let message) = state { Text(message).junoCaption().foregroundStyle(Color.junoCaution) }
        if case .refused(let message) = state { Text(message).junoCaption() }
        HStack(spacing: JunoSpace.cozy) {
          Button {
            onDecide(false)
          } label: {
            Text("Deny").frame(maxWidth: .infinity, minHeight: 44).contentShape(.rect)
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("juno.mobile.runs.deny.\(approval.id)")
          Button {
            onDecide(true)
          } label: {
            Text(approval.requiresOwnerToApprove ? "Approve with Face ID" : "Approve")
              .frame(maxWidth: .infinity, minHeight: 44)
              .contentShape(.rect)
          }
          .buttonStyle(.bordered)
          .tint(Color.junoAccent)
          .accessibilityIdentifier("juno.mobile.runs.approve.\(approval.id)")
        }
      }
    case .confirming:
      Text("Confirm it's you…").junoCaption().frame(minHeight: 44, alignment: .leading)
    case .sending:
      HStack(spacing: JunoSpace.micro) {
        ProgressView().controlSize(.small)
        Text("Sending…").junoCaption()
      }
      .frame(minHeight: 44)
    case .sent:
      Text("Answer sent").junoCaption().frame(minHeight: 44, alignment: .leading)
    }
  }
}

/// The strip on Code's home while anything runs: how many, and how many need
/// you. Tapping it opens the Runs screen.
struct JunoMobileRunsStrip: View {
  let model: LiveRunsModel
  let open: () -> Void

  var body: some View {
    if !model.runs.isEmpty {
      Button(action: open) {
        HStack(spacing: JunoSpace.cozy) {
          JunoIconView(model.pendingApprovalCount > 0 ? .permission : .agents, size: 16)
            .foregroundStyle(model.pendingApprovalCount > 0 ? Color.junoCaution : Color.junoAccent)
          Text(title).junoRowLabel()
          Spacer(minLength: 0)
          JunoIconView(.chevronRight, size: 13).foregroundStyle(Color.junoSecondaryInk)
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("juno.mobile.runs-strip")
    }
  }

  private var title: String {
    let running = model.runs.count == 1 ? "1 run going" : "\(model.runs.count) runs going"
    switch model.pendingApprovalCount {
    case 0: return running
    case 1: return "\(running) · 1 needs you"
    default: return "\(running) · \(model.pendingApprovalCount) need you"
    }
  }
}
