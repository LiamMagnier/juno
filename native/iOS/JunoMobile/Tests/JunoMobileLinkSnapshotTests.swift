import JunoCodeCore
import JunoCodeKit
import JunoCodeRemote
import JunoDesignSystem
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Offscreen stills of the iPhone remote for Mac Alevr Code (v2 device link),
/// light and dark: the session list, a thread streaming with an approval
/// waiting, the diff review with per-hunk Revert, Ship, the new-session
/// folder browser and the not-paired state. Drawn in a window of the hosted
/// app so Liquid Glass and the web icon set render as on a phone; nothing is
/// driven on screen.
///
/// Writes `ios-link-*.png` when `JUNO_SNAPSHOT_DIR` is set
/// (`TEST_RUNNER_JUNO_SNAPSHOT_DIR` on xcodebuild).
@MainActor
final class JunoMobileLinkSnapshotTests: XCTestCase {
  private static let size = CGSize(width: 402, height: 874)

  func testSessionList() async throws {
    let model = Self.model()
    try await shoot("link-sessions") {
      NavigationStack {
        VStack(spacing: 0) {
          JunoMobileCodeHostsStrip(hosts: [], linkMacs: model.macs, selection: .constant(.host("mac1")), onPair: {})
          JunoMobileLinkSessionsView(model: model, mac: model.macs[0], newSession: {})
        }
        .junoScreenCanvas()
        .navigationTitle("Code")
        .navigationBarTitleDisplayMode(.inline)
      }
    }
  }

  func testThreadStreamingWithApproval() async throws {
    let model = Self.model(open: true)
    try await shoot("link-thread") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testThreadComposerWhileWorking() async throws {
    let model = Self.model(open: true, approval: false)
    model.setPreviewDraft("Also cover the empty cart")
    try await shoot("link-thread-working") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testDiffReview() async throws {
    let model = Self.model(open: true)
    try await shoot("link-diff") {
      JunoMobileLinkSurfaceSheet(model: model, surface: .changes)
    }
  }

  func testShip() async throws {
    let model = Self.model(open: true)
    try await shoot("link-ship") {
      JunoMobileLinkSurfaceSheet(model: model, surface: .ship)
    }
  }

  func testTerminal() async throws {
    let model = Self.model(open: true, terminal: true)
    try await shoot("link-terminal") {
      JunoMobileLinkSurfaceSheet(model: model, surface: .terminal)
    }
  }

  func testNewSessionFolders() async throws {
    let model = Self.model()
    model.beginNewSession()
    try await shoot("link-new-session") {
      JunoMobileLinkNewSessionSheet(model: model) { _ in }
    }
  }

  func testNotPaired() async throws {
    let model = Self.model(linkError: .notPaired(message: "Not allowed"))
    try await shoot("link-not-paired") {
      NavigationStack {
        JunoMobileLinkSessionsView(model: model, mac: model.macs[0], newSession: {})
          .junoScreenCanvas()
          .navigationTitle("Code")
          .navigationBarTitleDisplayMode(.inline)
      }
    }
  }

  // MARK: - Fixtures

  static let sonnet = CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: .high)

  static func model(
    open: Bool = false, approval: Bool = true, terminal: Bool = false, linkError: CodeLinkError? = nil
  ) -> CodeLinkRemoteModel {
    let pair = RemotePair(
      id: "p1", kind: .phone, name: "iPhone", platform: "ios", deviceId: "mac1", deviceName: "Studio",
      createdAt: Date(), lastUsedAt: Date()
    )
    let mac = CodeLinkMac(
      pair: pair,
      info: CodeV2.HostInfo(name: "Studio", sharedFolders: ["/Users/liam/code", "/Users/liam/Sites"], terminal: true, captures: [.preview, .simulator]),
      reachability: linkError == nil ? .online : .notPaired("Not allowed")
    )
    let now = Date()
    func ago(_ minutes: Double) -> String { CodeV2Dates.string(now.addingTimeInterval(-minutes * 60)) }
    let sessions = [
      CodeV2.SessionSummary(id: "s1", cwd: "/Users/liam/code/shop", title: "Fix the cart total rounding", state: .waiting, selection: sonnet, updatedAt: ago(1), lastSequence: 40),
      CodeV2.SessionSummary(id: "s2", cwd: "/Users/liam/code/alevr", title: "Add retries to the sync client", state: .running, selection: sonnet, updatedAt: ago(3), lastSequence: 12),
      CodeV2.SessionSummary(id: "s3", cwd: "/Users/liam/Sites/portfolio", title: "Move the blog to MDX", state: .idle, selection: sonnet, updatedAt: ago(52), lastSequence: 80),
      CodeV2.SessionSummary(id: "s4", cwd: "/Users/liam/code/shop", title: "Upgrade to Next 16", state: .limited, selection: sonnet, updatedAt: ago(180), lastSequence: 220),
      CodeV2.SessionSummary(id: "s5", cwd: "/Users/liam/code/alevr", title: "Explain the pairing flow", state: .idle, selection: sonnet, updatedAt: ago(60 * 26), lastSequence: 9),
    ]
    let t = ago(4)
    var items: [CodeV2.TurnItem] = [
      .userMessage(CodeV2.UserMessage(id: "u1", turnId: "t1", createdAt: t, text: "The cart total is off by a cent on some orders. Find out why and fix it, with a test.")),
      .reasoning(CodeV2.Reasoning(id: "r1", turnId: "t1", createdAt: t, text: "Totals are summed as floats.", streaming: false)),
      .search(CodeV2.Search(id: "f1", turnId: "t1", createdAt: t, callId: "c0", query: "total(", scope: .content, matches: 6, status: .completed)),
      .commandExecution(CodeV2.CommandExecution(id: "x1", turnId: "t1", createdAt: t, callId: "c1", command: "npm test -- cart", output: "FAIL src/cart/total.test.ts\n  expected 19.99, received 19.990000000000002", exitCode: 1, durationMs: 4200, status: .completed)),
      .fileChange(CodeV2.FileChange(id: "e1", turnId: "t1", createdAt: t, callId: "c2", changes: [
        CodeV2.FileChangeEntry(path: "src/cart/total.ts", change: .modify, additions: 6, deletions: 2),
        CodeV2.FileChangeEntry(path: "src/cart/total.test.ts", change: .modify, additions: 14, deletions: 0),
      ], status: .completed)),
      .todoList(CodeV2.TodoList(id: "td", turnId: "t1", createdAt: t, todos: [
        CodeV2.TodoEntry(text: "Sum in integer cents", status: .completed),
        CodeV2.TodoEntry(text: "Cover the rounding case", status: .completed),
        CodeV2.TodoEntry(text: "Run the cart suite", status: .inProgress),
      ])),
      .assistantMessage(CodeV2.AssistantMessage(id: "m1", turnId: "t1", createdAt: t, text: "Totals were summed as floating point, so three items at 6.663 came to 19.990000000000002. I switched the sum to integer cents and added a test for", streaming: !approval)),
    ]
    if approval {
      items.append(.approvalRequest(CodeV2.ApprovalRequest(
        id: "a1", turnId: "t1", createdAt: t, callId: "c3", requestId: "req1", action: .command,
        summary: "npm test -- cart --coverage", justification: "Checks the fix against the whole cart suite.",
        options: [.accept, .acceptForSession, .decline], status: .pending
      )))
    }
    let snapshot = CodeV2.SessionSnapshot(
      id: "s1", cwd: "/Users/liam/code/shop", title: "Fix the cart total rounding", selection: sonnet,
      runtimeMode: .autoEdit, state: approval ? .waiting : .running, activeTurnId: "t1", items: items,
      queue: approval ? [] : [CodeV2.QueuedInput(id: "q1", input: CodeV2.UserInput(text: "Then update the changelog"), queuedAt: t)]
    )
    let diff = CodeV2UnifiedDiff.parse("""
    diff --git a/src/cart/total.ts b/src/cart/total.ts
    --- a/src/cart/total.ts
    +++ b/src/cart/total.ts
    @@ -1,6 +1,8 @@
     import type { Item } from "./types"

    -export function total(items: Item[]): number {
    -  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
    +export function total(items: Item[]): number {
    +  const cents = items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.qty, 0)
    +  return cents / 100
     }
    +
    +export const currency = "EUR"
    @@ -20,3 +22,4 @@ export function tax(amount: number) {
       const rate = 0.2
    -  return amount * rate
    +  const cents = Math.round(amount * 100)
    +  return Math.round(cents * rate) / 100
     }
    diff --git a/src/cart/total.test.ts b/src/cart/total.test.ts
    --- a/src/cart/total.test.ts
    +++ b/src/cart/total.test.ts
    @@ -8,2 +8,6 @@
     })
    +
    +it("rounds to the cent", () => {
    +  expect(total([{ price: 6.663, qty: 3 }])).toBe(19.99)
    +})
    """)
    let providers = [
      CodeV2.ProviderInstance(
        id: "claude-agent:default", kind: .claudeAgent, label: "Claude (your subscription)", status: .ready,
        capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high, .max]),
        models: [CodeV2.ProviderModel(id: "claude-opus-5-5", label: "Claude Opus 5.5"), CodeV2.ProviderModel(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5")]
      ),
      CodeV2.ProviderInstance(id: "alevr", kind: .alevr, label: "Alevr", status: .ready, models: [CodeV2.ProviderModel(id: "fable-2", label: "Fable 2")]),
    ]
    let git = CodeV2.GitStatusResult(
      branch: "fix/cart-rounding", upstream: "origin/fix/cart-rounding", ahead: 1, behind: 0,
      files: [CodeV2.GitFileStatus(path: "src/cart/total.ts", status: " M"), CodeV2.GitFileStatus(path: "src/cart/total.test.ts", status: " M")],
      isRepo: true, canOpenPr: true
    )
    return CodeLinkRemoteModel.preview(
      macs: [mac], sessions: sessions, open: open ? snapshot : nil, providers: providers,
      diff: diff, terminal: terminal ? "$ npm test -- cart\r\n\r\n PASS  src/cart/total.test.ts\r\n  total\r\n    \u{2713} sums in cents (3 ms)\r\n    \u{2713} rounds to the cent (1 ms)\r\n\r\nTests: 2 passed, 2 total\r\n$ " : nil,
      git: git, linkError: linkError
    )
  }

  private func shoot<V: View>(_ name: String, settle: Double = 0.9, @ViewBuilder _ make: () -> V) async throws {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { throw XCTSkip("No window scene in the host app") }
    for style in [UIUserInterfaceStyle.light, .dark] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(origin: .zero, size: Self.size)
      window.overrideUserInterfaceStyle = style
      let host = UIHostingController(rootView: make().tint(Color.junoAccent))
      window.rootViewController = host
      window.isHidden = false
      try await Task.sleep(for: .seconds(settle))
      let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
      let image = renderer.image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      window.isHidden = true
      window.rootViewController = nil
      let data = try XCTUnwrap(image.pngData())
      XCTAssertGreaterThan(data.count, 2_000, "\(name) rendered blank")
      if let directory = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] {
        let url = URL(fileURLWithPath: directory).appendingPathComponent("ios-\(name)-\(style == .dark ? "dark" : "light").png")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
      }
    }
  }
}
