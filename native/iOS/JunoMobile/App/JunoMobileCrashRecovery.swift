import JunoCore
import JunoDesignSystem
import Observation
import SwiftUI
#if DEBUG
  import JunoPreviewSupport
#endif

/// The phone's black box (docs/rea/designs/reliability-and-native.md §3.3),
/// on the rules the Mac uses (``JunoCrashRecovery`` in `JunoCore`), adapted
/// to the scene lifecycle.
///
/// iOS ends backgrounded apps as a matter of course, so reaching the
/// background with the snapshot saved marks the sentinel clean; only an
/// ending while in front — a crash, a watchdog kill — counts as unclean.
///
/// After one: the conversation and its unsent draft come back with a quiet
/// banner. After two inside ten minutes: safe mode too — background refresh
/// and custom motion off — with a banner and Turn Off Safe Mode, which turns
/// them back on in place (an iOS app cannot relaunch itself).
@MainActor
@Observable
final class JunoMobileCrashRecovery {
  static let shared = JunoMobileCrashRecovery()

  private(set) var showsRestoredBanner = false
  private(set) var showsSafeModeBanner = false
  /// Whether safe mode is on, observable so leaving it updates the shell.
  private(set) var isSafeMode = false

  @ObservationIgnored private var recovery: JunoCrashRecovery?
  @ObservationIgnored private var recorder: JunoSessionSnapshotRecorder?
  @ObservationIgnored private var pendingDraft: JunoSessionSnapshot.Draft?
  @ObservationIgnored private var restoreTarget: JunoSessionSnapshot?
  @ObservationIgnored private var heartbeat: Task<Void, Never>?
  @ObservationIgnored private var started = false

  /// UI tests stand in for a crash with this.
  static let simulateUncleanExitArgument = "--juno-simulate-unclean-exit"

  private init() {}

  // MARK: Lifecycle

  /// From `didFinishLaunching`, before background work is scheduled.
  func launch() {
    let environment = ProcessInfo.processInfo.environment
    guard !started, environment["XCTestConfigurationFilePath"] == nil,
      let location = JunoRecoveryLocation.applicationSupport(bundleIdentifier: nil)
    else { return }
    #if DEBUG
      if JunoPreviewEnvironment.isActive { return }
    #endif
    started = true
    let recovery = JunoCrashRecovery(location: location)
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains(Self.simulateUncleanExitArgument) {
        recovery.plantSentinel(version: version)
      }
    #endif
    let result = recovery.beginLaunch(version: version)
    self.recovery = recovery
    recorder = JunoSessionSnapshotRecorder(location: location)

    JunoSafeMode.set(active: result.isSafeMode)
    isSafeMode = result.isSafeMode
    showsSafeModeBanner = result.isSafeMode
    if result.isUnclean, let snapshot = result.snapshot {
      showsRestoredBanner = true
      restore(snapshot)
    }
    startHeartbeat()
  }

  /// The scene phase, from the app: the background is where the snapshot is
  /// saved and the sentinel marked clean; the foreground makes it live again.
  func scenePhaseChanged(_ phase: ScenePhase) {
    switch phase {
    case .background:
      recorder?.flushIfDirty()
      recovery?.didEnterBackground()
    case .active:
      recovery?.willEnterForeground()
    case .inactive:
      recorder?.flushIfDirty()
    @unknown default:
      break
    }
  }

  /// `applicationWillTerminate`, when iOS sends it.
  func endCleanly() {
    heartbeat?.cancel()
    recorder?.flushIfDirty()
    recovery?.endCleanly()
  }

  func dismissRestoredBanner() {
    showsRestoredBanner = false
  }

  /// Turns the optional subsystems back on now and forgets the crash count.
  func leaveSafeMode() {
    recovery?.resetCrashLoop()
    JunoSafeMode.set(active: false)
    isSafeMode = false
    showsSafeModeBanner = false
  }

  // MARK: Restore

  private func restore(_ snapshot: JunoSessionSnapshot) {
    restoreTarget = snapshot
    recorder?.seed(snapshot)
    let requests = JunoMobileLaunchRequests.shared
    if let id = snapshot.conversationID {
      pendingDraft = snapshot.draft?.conversationID == id ? snapshot.draft : nil
      requests.request(.openConversation(id))
    } else if let text = snapshot.draftText(for: nil) {
      // The draft chat takes it as its text, ready to send — as "Ask Alevr".
      requests.request(.ask(text))
      restoreTarget = nil
    } else {
      restoreTarget = nil
    }
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(10))
      self?.restoreTarget = nil
    }
  }

  func takeRestoredDraft(for conversationID: String) -> String? {
    guard let draft = pendingDraft, draft.conversationID == conversationID else { return nil }
    pendingDraft = nil
    return draft.text
  }

  // MARK: Recording

  func noteScreen(isCode: Bool, conversationID: String?) {
    let product: JunoSessionSnapshot.Product = isCode ? .code : .chat
    let conversation = isCode ? nil : conversationID
    if let target = restoreTarget {
      guard target.product == product, target.conversationID == conversation else { return }
      restoreTarget = nil
    }
    recorder?.update { snapshot in
      snapshot.product = product
      snapshot.conversationID = conversation
      if snapshot.draft?.conversationID != conversation { snapshot.draft = nil }
    }
  }

  /// The composer's unsent words. Never called for an incognito chat.
  func noteDraft(_ text: String, conversationID: String?) {
    guard restoreTarget == nil else { return }
    recorder?.update { snapshot in
      snapshot.draft = text.isEmpty ? nil : .init(conversationID: conversationID, text: text)
    }
  }

  private func startHeartbeat() {
    heartbeat = Task { [weak self] in
      var stable = false
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(JunoSessionSnapshotRecorder.defaultDraftInterval))
        guard let self else { return }
        self.recorder?.flushIfDirty()
        if !stable, self.recovery?.markStable() == true { stable = true }
      }
    }
  }
}

// MARK: - Draft

/// Records a chat composer's draft in the snapshot and gives a restored
/// conversation's draft back to an empty field.
struct JunoMobileRecoveryDraft: ViewModifier {
  /// Nil for the new-chat draft.
  let conversationID: String?
  @Binding var text: String

  func body(content: Content) -> some View {
    content
      .onChange(of: conversationID, initial: true) { _, id in
        guard let id, text.isEmpty,
          let restored = JunoMobileCrashRecovery.shared.takeRestoredDraft(for: id)
        else { return }
        text = restored
      }
      .onChange(of: text) { _, value in
        JunoMobileCrashRecovery.shared.noteDraft(value, conversationID: conversationID)
      }
  }
}

// MARK: - Banner

/// The quiet line after an unclean exit, and the safe mode line, in the
/// offline banner's place and manner.
struct JunoMobileRecoveryBanner: View {
  @State private var recovery = JunoMobileCrashRecovery.shared

  var body: some View {
    VStack(spacing: 0) {
      if recovery.showsSafeModeBanner {
        line(icon: .shield, identifier: "juno.mobile.safe-mode-banner") {
          VStack(alignment: .leading, spacing: JunoSpace.micro) {
            Text("safeMode.title", tableName: "Shell").fontWeight(.semibold)
            Text("safeMode.body", tableName: "Shell")
          }
        } action: {
          Button {
            recovery.leaveSafeMode()
          } label: {
            Text("safeMode.leave", tableName: "Shell")
              .frame(minHeight: JunoLayout.touchTarget)
              .contentShape(.rect)
          }
        }
      }
      if recovery.showsRestoredBanner {
        line(icon: .history, identifier: "juno.mobile.recovery-banner") {
          Text("recovery.restored", tableName: "Shell")
        } action: {
          Button {
            recovery.dismissRestoredBanner()
          } label: {
            Text("recovery.dismiss", tableName: "Shell")
              .frame(minHeight: JunoLayout.touchTarget)
              .contentShape(.rect)
          }
        }
      }
    }
  }

  private func line(
    icon: JunoIcon,
    identifier: String,
    @ViewBuilder text: () -> some View,
    @ViewBuilder action: () -> some View
  ) -> some View {
    HStack(spacing: JunoSpace.close) {
      JunoIconView(icon, size: 16)
      text()
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: JunoSpace.snug)
      action()
        .modifier(JunoMobileWorkspaceActionStyle())
    }
    .font(.footnote)
    .padding(.horizontal, JunoSpace.regular)
    .padding(.vertical, JunoSpace.snug)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.thinMaterial)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(identifier)
  }
}
