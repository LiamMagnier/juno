import Foundation
import JunoAuth
import JunoCore
import JunoSync
import Observation
import SwiftUI

/// What the thread-sync service talks to: the backend's `/api/sync/**`
/// routes in the app, a fake in tests.
protocol JunoMobileThreadSyncStore: Sendable {
  func thread(_ key: String) async throws -> ThreadSyncState?
  @discardableResult
  func write(_ key: String, _ update: ThreadSyncUpdate) async throws -> ThreadSyncState?
  func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> JunoMobileThreadSyncPage
  func handOff(_ handoff: JunoHandoff, to target: JunoHandoff.Target) async throws
}

/// One page of changed threads after a cursor.
struct JunoMobileThreadSyncPage: Sendable, Equatable {
  var threads: [ThreadSyncState]
  var cursor: String?
}

/// ``ThreadSyncClient`` bound to the signed-in account.
struct JunoMobileThreadSyncClientStore: JunoMobileThreadSyncStore {
  let client: ThreadSyncClient
  let accountID: AccountID

  func thread(_ key: String) async throws -> ThreadSyncState? {
    try await client.thread(key, for: accountID)
  }

  @discardableResult
  func write(_ key: String, _ update: ThreadSyncUpdate) async throws -> ThreadSyncState? {
    try await client.write(key, update, for: accountID)
  }

  func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> JunoMobileThreadSyncPage {
    let page = try await client.changes(after: cursor, waitMs: waitMs, keys: keys, for: accountID)
    return JunoMobileThreadSyncPage(threads: page.threads, cursor: page.cursor)
  }

  func handOff(_ handoff: JunoHandoff, to target: JunoHandoff.Target) async throws {
    try await client.handOff(handoff, to: target, for: accountID)
  }
}

/// Per-thread state shared with the Mac and the web (docs/code-v2/REMOTE-CONTROL.md §5):
/// the unsent draft, the composer's model and effort, read and needs-you.
///
/// One instance per signed-in account, published to the shell as
/// `\.junoThreadSync`. A thread screen uses it by key, so Chat
/// (`ThreadSyncKey.chat(id)`) and Code (`ThreadSyncKey.code(deviceID:sessionID:)`)
/// share the same rules:
///
/// - ``draftChanged(_:text:)`` on every keystroke; the write goes out 700 ms
///   after the last one (``ThreadDraftSyncer``).
/// - ``sent(_:)`` when a message goes: the draft clears everywhere at once.
/// - ``flush(_:)`` when the thread is left, ``flushAll()`` when the app goes
///   to the background.
/// - ``opened(_:)`` when the thread opens: marks it read; then
///   ``draftToRestore(_:currentDraft:)`` gives a remote draft for an empty
///   composer.
/// - ``follow(_:apply:)`` while it is open: long-polls the key and hands over
///   remote states this device should apply (not its own echo, not over
///   unsent typing).
/// - ``writePrefs(_:_:)`` when the person changes the model, effort, mode,
///   team or skills.
@MainActor
@Observable
final class JunoMobileThreadSync {
  /// What this device calls itself in `draftBy`.
  static let device = "iphone"

  @ObservationIgnored let store: any JunoMobileThreadSyncStore
  @ObservationIgnored let syncer: ThreadDraftSyncer
  /// The latest state seen per key, remote or written here.
  private(set) var states: [String: ThreadSyncState] = [:]
  /// A send just cleared these keys' drafts: the composer's own "" that
  /// follows is not new typing.
  @ObservationIgnored private var justSent: Set<String> = []
  @ObservationIgnored private let pollWaitMs: Int
  @ObservationIgnored private let retryDelay: Duration

  init(
    store: any JunoMobileThreadSyncStore,
    delay: Duration = .milliseconds(700),
    pollWaitMs: Int = 20_000,
    retryDelay: Duration = .seconds(3)
  ) {
    self.store = store
    self.pollWaitMs = pollWaitMs
    self.retryDelay = retryDelay
    syncer = ThreadDraftSyncer(device: Self.device, delay: delay) { key, update in
      _ = try await store.write(key, update)
    }
  }

  static func live(sender: any NativeAuthenticatedRequestSending, accountID: AccountID) -> JunoMobileThreadSync {
    JunoMobileThreadSync(
      store: JunoMobileThreadSyncClientStore(client: ThreadSyncClient(sender: sender), accountID: accountID)
    )
  }

  // MARK: Drafts

  /// The composer's text changed.
  func draftChanged(_ key: String, text: String) {
    if text.isEmpty, justSent.remove(key) != nil { return }
    justSent.remove(key)
    let syncer = syncer
    Task { await syncer.draftChanged(key, text: text) }
  }

  /// A message went: the draft is cleared on every device.
  func sent(_ key: String) {
    justSent.insert(key)
    states[key]?.draft = ""
    let syncer = syncer
    Task { await syncer.cleared(key) }
  }

  func flush(_ key: String) async {
    await syncer.flush(key)
  }

  func flushAll() async {
    await syncer.flushAll()
  }

  // MARK: Opening and following

  /// Marks the thread read and returns what the backend holds for it (see
  /// ``draftToRestore(_:currentDraft:)`` for the draft).
  func opened(_ key: String) async -> ThreadSyncState? {
    let remote = try? await store.thread(key)
    if let remote { states[key] = remote }
    let read = try? await store.write(key, ThreadSyncUpdate(read: true, device: Self.device))
    if let read { states[key] = read }
    return remote
  }

  /// The draft to put in an empty composer on opening, if any.
  func draftToRestore(_ state: ThreadSyncState?, currentDraft: String) async -> String? {
    guard let state, currentDraft.isEmpty, !state.draft.isEmpty else { return nil }
    guard await syncer.shouldApply(state) else { return nil }
    return state.draft
  }

  /// Whether a remote state should replace what this device shows.
  func shouldApply(_ state: ThreadSyncState) async -> Bool {
    await syncer.shouldApply(state)
  }

  /// Follows one or more keys until the task is cancelled, handing over each
  /// remote state this device should apply.
  func follow(_ keys: [String], apply: @MainActor (ThreadSyncState) async -> Void) async {
    var cursor: String?
    // The first page only positions the cursor: what is already there was
    // read by ``opened(_:)``.
    if let first = try? await store.changes(after: nil, waitMs: 0, keys: keys) {
      cursor = first.cursor
    }
    while !Task.isCancelled {
      do {
        let page = try await store.changes(after: cursor, waitMs: pollWaitMs, keys: keys)
        if Task.isCancelled { return }
        cursor = page.cursor ?? cursor
        for state in page.threads where keys.contains(state.key) {
          states[state.key] = state
          if await syncer.shouldApply(state) {
            await apply(state)
          }
        }
      } catch {
        if Task.isCancelled { return }
        try? await Task.sleep(for: retryDelay)
      }
    }
  }

  // MARK: Prefs and state

  /// The person changed the composer's model, effort, mode, team or skills.
  func writePrefs(_ key: String, _ prefs: ThreadSyncPrefs, at date: Date = Date()) {
    let store = store
    Task {
      let state = try? await store.write(
        key, ThreadSyncUpdate(prefs: prefs, prefsUpdatedAt: date, device: Self.device)
      )
      if let state { states[key] = state }
    }
  }

  /// Marks a thread read (it is on screen).
  func markRead(_ key: String) {
    let store = store
    Task {
      let state = try? await store.write(key, ThreadSyncUpdate(read: true, device: Self.device))
      if let state { states[key] = state }
    }
  }

  // MARK: Hand-off

  /// "Continue on Mac": a notification on the Mac that opens this thread.
  func handOff(_ handoff: JunoHandoff, to target: JunoHandoff.Target) async throws {
    try await store.handOff(handoff, to: target)
  }
}

extension EnvironmentValues {
  /// The signed-in account's thread sync, nil while signed out.
  @Entry var junoThreadSync: JunoMobileThreadSync? = nil
}
