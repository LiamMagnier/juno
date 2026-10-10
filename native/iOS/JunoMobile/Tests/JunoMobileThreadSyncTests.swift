import Foundation
import JunoCore
import JunoSync
import XCTest
@testable import JunoMobile

/// The chat composer's draft sync: debounced writes, cleared on send, a
/// remote draft only into an empty composer, this device's echo ignored.
@MainActor
final class JunoMobileThreadSyncTests: XCTestCase {
  private let key = ThreadSyncKey.chat("conv_1")

  func testKeystrokesAreDebouncedIntoOneWrite() async throws {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store, delay: .milliseconds(80))
    for text in ["H", "He", "Hel", "Hello"] {
      sync.draftChanged(key, text: text)
      try await Task.sleep(for: .milliseconds(10))
    }
    try await Task.sleep(for: .milliseconds(300))
    let writes = await store.writes
    XCTAssertEqual(writes.map(\.update.draft), ["Hello"])
    XCTAssertEqual(writes.first?.update.device, "iphone")
    XCTAssertEqual(writes.first?.key, "chat:conv_1")
  }

  func testSendingClearsTheDraftAtOnceAndTheComposersEmptyIsNotTyping() async throws {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store, delay: .milliseconds(60))
    sync.draftChanged(key, text: "Ship it")
    sync.sent(key)
    // The composer then empties itself: that is the send, not typing.
    sync.draftChanged(key, text: "")
    try await Task.sleep(for: .milliseconds(250))
    let drafts = await store.writes.map(\.update.draft)
    XCTAssertEqual(drafts, [""], "one immediate clear, no debounced write after it")
  }

  func testFlushWritesPendingTypingNow() async {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store, delay: .seconds(30))
    sync.draftChanged(key, text: "Half a thought")
    // Let the syncer receive it, then leave the chat.
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(20))
    await sync.flush(key)
    let drafts = await store.writes.map(\.update.draft)
    XCTAssertEqual(drafts, ["Half a thought"])
  }

  func testOpeningMarksReadAndRestoresARemoteDraftIntoAnEmptyComposer() async {
    let remote = ThreadSyncState(key: key, draft: "From the Mac", draftUpdatedAt: Date(), draftBy: "macos", updatedAt: Date())
    let store = FakeThreadSyncStore(stored: remote)
    let sync = JunoMobileThreadSync(store: store)
    let state = await sync.opened(key)
    XCTAssertEqual(state, remote)
    let writes = await store.writes
    XCTAssertEqual(writes.map(\.update.read), [true])
    let restored = await sync.draftToRestore(state, currentDraft: "")
    XCTAssertEqual(restored, "From the Mac")
    let kept = await sync.draftToRestore(state, currentDraft: "Typed here")
    XCTAssertNil(kept, "never over typing")
  }

  func testOwnEchoIsIgnoredButAnotherDevicesDraftApplies() async throws {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store, delay: .milliseconds(30))
    sync.draftChanged(key, text: "Mine")
    try await Task.sleep(for: .milliseconds(150))
    let echo = ThreadSyncState(key: key, draft: "Mine", draftUpdatedAt: Date(), draftBy: "iphone", updatedAt: Date())
    let applyEcho = await sync.shouldApply(echo)
    XCTAssertFalse(applyEcho)
    let mac = ThreadSyncState(key: key, draft: "Mine, and more", draftUpdatedAt: Date(), draftBy: "macos", updatedAt: Date())
    let applyMac = await sync.shouldApply(mac)
    XCTAssertTrue(applyMac)
  }

  func testUnsentTypingIsNeverOverwritten() async {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store, delay: .seconds(30))
    sync.draftChanged(key, text: "Still typing")
    try? await Task.sleep(for: .milliseconds(20))
    let mac = ThreadSyncState(key: key, draft: "Other", draftUpdatedAt: Date(), draftBy: "macos", updatedAt: Date())
    let apply = await sync.shouldApply(mac)
    XCTAssertFalse(apply)
  }

  func testFollowHandsOverOtherDevicesChanges() async throws {
    let mac = ThreadSyncState(key: key, draft: "Live from the Mac", draftUpdatedAt: Date(), draftBy: "macos", updatedAt: Date())
    let store = FakeThreadSyncStore(pages: [JunoMobileThreadSyncPage(threads: [mac], cursor: "c2")])
    let sync = JunoMobileThreadSync(store: store, pollWaitMs: 1, retryDelay: .milliseconds(10))
    let applied = AppliedDrafts()
    let key = key
    let follow = Task { @MainActor in
      await sync.follow([key]) { state in applied.drafts.append(state.draft) }
    }
    try await Task.sleep(for: .milliseconds(150))
    follow.cancel()
    XCTAssertEqual(applied.drafts, ["Live from the Mac"])
    XCTAssertEqual(sync.states[key]?.draft, "Live from the Mac")
  }

  func testPrefsAreWrittenWithTheirOwnClock() async throws {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store)
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    sync.writePrefs(key, ThreadSyncPrefs(model: "claude-opus", effort: "high"), at: at)
    try await Task.sleep(for: .milliseconds(50))
    let writes = await store.writes
    XCTAssertEqual(writes.first?.update.prefs, ThreadSyncPrefs(model: "claude-opus", effort: "high"))
    XCTAssertEqual(writes.first?.update.prefsUpdatedAt, at)
  }

  func testContinueOnMacGoesThroughTheStore() async throws {
    let store = FakeThreadSyncStore()
    let sync = JunoMobileThreadSync(store: store)
    try await sync.handOff(.chat("conv_1", title: "Trip"), to: .macos)
    let handoffs = await store.handoffs
    XCTAssertEqual(handoffs.first?.0, .chat("conv_1", title: "Trip"))
    XCTAssertEqual(handoffs.first?.1, .macos)
  }
}

@MainActor
private final class AppliedDrafts {
  var drafts: [String] = []
}

actor FakeThreadSyncStore: JunoMobileThreadSyncStore {
  struct Write: Sendable {
    let key: String
    let update: ThreadSyncUpdate
  }

  private let stored: ThreadSyncState?
  private var pages: [JunoMobileThreadSyncPage]
  private(set) var writes: [Write] = []
  private(set) var handoffs: [(JunoHandoff, JunoHandoff.Target)] = []

  init(stored: ThreadSyncState? = nil, pages: [JunoMobileThreadSyncPage] = []) {
    self.stored = stored
    self.pages = pages
  }

  func thread(_ key: String) async throws -> ThreadSyncState? { stored }

  @discardableResult
  func write(_ key: String, _ update: ThreadSyncUpdate) async throws -> ThreadSyncState? {
    writes.append(Write(key: key, update: update))
    return nil
  }

  func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> JunoMobileThreadSyncPage {
    if cursor == nil, waitMs == 0 { return JunoMobileThreadSyncPage(threads: [], cursor: "c1") }
    if !pages.isEmpty { return pages.removeFirst() }
    try await Task.sleep(for: .milliseconds(20))
    return JunoMobileThreadSyncPage(threads: [], cursor: cursor)
  }

  func handOff(_ handoff: JunoHandoff, to target: JunoHandoff.Target) async throws {
    handoffs.append((handoff, target))
  }
}
