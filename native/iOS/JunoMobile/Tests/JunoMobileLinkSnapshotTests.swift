import JunoChatKit
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

  func testSubagentSummaryAndFullTrace() async throws {
    let t = "2026-10-11T00:00:00Z"
    var reply = CodeV2.AssistantMessage(id: "child-reply", turnId: "t1", createdAt: t, text: "Startup delivery passed.")
    reply.agentId = "startup-audit"
    var command = CodeV2.CommandExecution(id: "child-tool", turnId: "t1", createdAt: t, callId: "check", command: "npm test", output: "3 tests passed", exitCode: 0, status: .completed)
    command.agentId = "startup-audit"
    let snapshot = CodeV2.SessionSnapshot(id: "s1", cwd: "/Users/liam/code/shop", selection: .init(instanceId: "alevr", model: "claude-sonnet-5-5"), items: [
      .subagent(.init(id: "agent-row", turnId: "t1", createdAt: t, agentId: "startup-audit", role: .worker,
        model: Self.sonnet, status: .completed, task: "Audit startup ordering and test first-message delivery", closingText: "Startup delivery passed.", title: "Audit subscription startup", elapsedMs: 120_000)),
      .commandExecution(command), .assistantMessage(reply)
    ])
    let model = Self.model(snapshot: snapshot)
    try await shoot("agents-summary") { JunoMobileLinkAgentsView(model: model, selectedID: .constant(nil)) }
    try await shoot("agent-full-trace") { JunoMobileLinkAgentsView(model: model, selectedID: .constant("startup-audit")) }
  }

  func testSessionList() async throws {
    let model = Self.model()
    try await shoot("link-sessions") {
      NavigationStack {
        JunoMobileLinkSessionsView(model: model, mac: model.macs[0], newSession: {})
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

  // MARK: The composer row at every width

  /// iPhone SE, the standard 6.3", Pro Max: Full access with a long model
  /// name, while a turn runs. Nothing on the row may overlap (Oct 11: "Full
  /// access" was drawn over the model's name); the name truncates instead,
  /// and the loose "Thinking" over the composer is gone.
  func testComposerRowAtEveryWidth() async throws {
    let widths: [(String, CGSize)] = [
      ("se", CGSize(width: 375, height: 667)),
      ("standard", CGSize(width: 402, height: 874)),
      ("promax", CGSize(width: 440, height: 956)),
    ]
    for (name, size) in widths {
      let model = Self.composerRowModel()
      try await Self.shoot("composer-row-\(name)", size: size) {
        NavigationStack { JunoMobileLinkThreadView(model: model) }
      }
    }
    // The largest accessibility sizes on the smallest phone: the same row,
    // one gauge for the model and its thinking.
    let model = Self.composerRowModel()
    try await Self.shoot("composer-row-se-ax", size: CGSize(width: 375, height: 667)) {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
        .environment(\.dynamicTypeSize, .accessibility2)
    }
  }

  /// A running thread on Full access with the longest model name we offer.
  static func composerRowModel(
    selection: CodeV2.ModelSelection? = nil, providers: [CodeV2.ProviderInstance]? = nil
  ) -> CodeLinkRemoteModel {
    let t = CodeV2Dates.string(Date())
    let long = selection ?? CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-haiku-5-5-long", effort: .high)
    let snapshot = CodeV2.SessionSnapshot(
      id: "s1", cwd: "/Users/liam/Desktop/test", title: "Code the best looking portfolio", selection: long,
      runtimeMode: .full, state: .running, activeTurnId: "t1", items: [
        .userMessage(CodeV2.UserMessage(id: "u1", turnId: "t1", createdAt: t, text: "Code the best looking portfolio using the brand kit")),
        .commandExecution(CodeV2.CommandExecution(id: "x1", turnId: "t1", createdAt: t, callId: "c1", command: "ls -la && (ls portfolio 2>/dev/null || true)", output: "", exitCode: 0, durationMs: 40, status: .completed)),
        .reasoning(CodeV2.Reasoning(id: "r2", turnId: "t1", createdAt: t, text: "Fixing the overflow first.", streaming: true)),
      ]
    )
    let model = Self.model(snapshot: snapshot, providers: providers)
    model.composer.selection = long
    model.composer.runtimeMode = .full
    model.setPreviewDraft("")
    return model
  }

  // MARK: New session, Codex's way: the empty thread itself

  func testNewSessionEmptyWithKeyboard() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-empty", settle: 1.6, keyboard: true) {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testNewSessionWithAttachments() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    let image = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120)).image { context in
      UIColor(red: 0.85, green: 0.45, blue: 0.35, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: 120, height: 120))
    }
    model.attach([
      CodeLinkDraftAttachment(name: "checkout.png", mediaType: "image/png", data: image.pngData() ?? Data()),
      CodeLinkDraftAttachment(name: "spec.pdf", mediaType: "application/pdf", data: Data([1, 2, 3])),
    ])
    model.setPreviewDraft("Match the checkout to this")
    try await shoot("new-session-attached") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testNewSessionComputerPicker() async throws {
    let model = Self.model(macs: 2)
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-computer") {
      NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .computer) }
    }
  }

  func testNewSessionProjectPicker() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-project") {
      NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .project) }
    }
  }

  func testNewSessionModeMenu() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-mode") {
      NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .mode) }
    }
  }

  func testNewSessionThinking() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-thinking") {
      NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .thinking) }
    }
  }

  // MARK: One model selector: Chat's, with Alevr's API models and the plans

  /// What a Mac whose env server has the Alevr session reports.
  static let pickerProviders: [CodeV2.ProviderInstance] = [
    CodeV2.ProviderInstance(
      id: "alevr", kind: .alevr, label: "Alevr", status: .ready,
      capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high, .xhigh]),
      models: [
        CodeV2.ProviderModel(id: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", effortLevels: [.low, .medium, .high, .max], defaultEffort: .high, isDefault: true),
        CodeV2.ProviderModel(id: "anthropic:claude-sonnet-5-5", label: "Claude Sonnet 5.5", effortLevels: [.low, .medium, .high, .max]),
        CodeV2.ProviderModel(id: "openai:gpt-6.1", label: "GPT-6.1", effortLevels: [.minimal, .low, .medium, .high, .xhigh]),
        CodeV2.ProviderModel(id: "zhipu:glm-5", label: "GLM-5", effortLevels: [.none, .high]),
        CodeV2.ProviderModel(id: "moonshot:kimi-k2.7", label: "Kimi K2.7"),
        CodeV2.ProviderModel(id: "google:gemini-3.5-pro", label: "Gemini 3.5 Pro", effortLevels: [.low, .high]),
      ]
    ),
    CodeV2.ProviderInstance(
      id: "claude-agent:default", kind: .claudeAgent, label: "Claude (your subscription)", status: .ready,
      capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high, .max]),
      models: [
        CodeV2.ProviderModel(id: "claude-opus-5-5", label: "Claude Opus 5.5", defaultEffort: .high),
        CodeV2.ProviderModel(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5"),
      ]
    ),
    CodeV2.ProviderInstance(
      id: "codex:default", kind: .codex, label: "ChatGPT (Codex)", status: .ready,
      capabilities: CodeV2.ProviderCapabilities(steering: true, effortLevels: [.low, .medium, .high]),
      models: [CodeV2.ProviderModel(id: "gpt-6.1-codex", label: "GPT-6.1 Codex")]
    ),
  ]

  static let gpt = CodeV2.ModelSelection(instanceId: "alevr", model: "openai:gpt-6.1", effort: .xhigh)

  static let pickerSizes: [(String, CGSize)] = [
    ("se", CGSize(width: 375, height: 667)),
    ("promax", CGSize(width: 440, height: 956)),
  ]

  /// A running thread on Alevr's GPT-6.1: the row is +, access, the gauge,
  /// the microphone and Stop; nothing to overlap at any width.
  func testRemotePickerClosed() async throws {
    for (name, size) in Self.pickerSizes {
      let model = Self.composerRowModel(selection: Self.gpt, providers: Self.pickerProviders)
      try await Self.shoot("remote-picker-closed-\(name)", size: size) {
        NavigationStack { JunoMobileLinkThreadView(model: model) }
      }
    }
    let model = Self.composerRowModel(selection: Self.gpt, providers: Self.pickerProviders)
    try await Self.shoot("remote-picker-closed-se-ax", size: CGSize(width: 375, height: 667)) {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
        .environment(\.dynamicTypeSize, .accessibility2)
    }
  }

  /// The selector: Alevr's labs, then the Mac's plans.
  func testRemotePickerOpen() async throws {
    for (name, size) in Self.pickerSizes {
      let model = Self.composerRowModel(selection: Self.gpt, providers: Self.pickerProviders)
      try await Self.shoot("remote-picker-open-\(name)", size: size) {
        JunoMobileLinkModelPicker(model: model, chatModels: []) {}
      }
    }
  }

  /// The gauge open on the chosen model's own levels.
  func testRemotePickerThinking() async throws {
    for (name, size) in Self.pickerSizes {
      let model = Self.composerRowModel(selection: Self.gpt, providers: Self.pickerProviders)
      try await Self.shoot("remote-picker-thinking-\(name)", size: size) {
        NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .thinking) }
      }
    }
    let model = Self.composerRowModel(
      selection: CodeV2.ModelSelection(instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: .max),
      providers: Self.pickerProviders
    )
    try await Self.shoot("remote-picker-thinking-plan-se", size: CGSize(width: 375, height: 667)) {
      NavigationStack { JunoMobileLinkThreadView(model: model, previewPanel: .thinking) }
    }
  }

  func testNewSessionFirstMessageSent() async throws {
    let model = Self.model()
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    model.setPreviewStarting("Add a dark mode toggle to the settings page")
    try await shoot("new-session-sent") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testNewSessionBecameTheThread() async throws {
    let t = CodeV2Dates.string(Date())
    let snapshot = CodeV2.SessionSnapshot(
      id: "s9", cwd: "/Users/liam/code/shop", title: "Add a dark mode toggle to the settings page", selection: Self.sonnet,
      runtimeMode: .ask, state: .running, activeTurnId: "t1", items: [
        .userMessage(CodeV2.UserMessage(id: "u1", turnId: "t1", createdAt: t, text: "Add a dark mode toggle to the settings page")),
        .reasoning(CodeV2.Reasoning(id: "r1", turnId: "t1", createdAt: t, text: "Looking at how settings are laid out.", streaming: false)),
        .search(CodeV2.Search(id: "f1", turnId: "t1", createdAt: t, callId: "c0", query: "SettingsPage", scope: .content, matches: 3, status: .completed)),
      ]
    )
    let model = Self.model(snapshot: snapshot)
    try await shoot("new-session-live") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
    }
  }

  func testNewSessionNothingPaired() async throws {
    let model = CodeLinkRemoteModel.preview(macs: [])
    model.beginNewSession()
    model.composer.selection = Self.sonnet
    try await shoot("new-session-not-paired") {
      NavigationStack { JunoMobileLinkThreadView(model: model) }
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
    open: Bool = false, approval: Bool = true, terminal: Bool = false, linkError: CodeLinkError? = nil,
    macs count: Int = 1, snapshot custom: CodeV2.SessionSnapshot? = nil,
    providers customProviders: [CodeV2.ProviderInstance]? = nil
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
        models: [
          CodeV2.ProviderModel(id: "claude-opus-5-5", label: "Claude Opus 5.5"),
          CodeV2.ProviderModel(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5"),
          CodeV2.ProviderModel(id: "claude-haiku-5-5-long", label: "Claude Haiku 5.5 Long Context Preview"),
        ]
      ),
      CodeV2.ProviderInstance(id: "alevr", kind: .alevr, label: "Alevr", status: .ready, models: [CodeV2.ProviderModel(id: "fable-2", label: "Fable 2")]),
    ]
    let git = CodeV2.GitStatusResult(
      branch: "fix/cart-rounding", upstream: "origin/fix/cart-rounding", ahead: 1, behind: 0,
      files: [CodeV2.GitFileStatus(path: "src/cart/total.ts", status: " M"), CodeV2.GitFileStatus(path: "src/cart/total.test.ts", status: " M")],
      isRepo: true, canOpenPr: true
    )
    var macs = [mac]
    if count > 1 {
      macs.append(CodeLinkMac(
        pair: RemotePair(id: "p2", kind: .phone, name: "iPhone", platform: "ios", deviceId: "mac2", deviceName: "mac.home", createdAt: Date(), lastUsedAt: Date()),
        info: CodeV2.HostInfo(name: "mac.home", sharedFolders: ["/Users/liam/Developer"], terminal: false, captures: []),
        reachability: .offline("mac.home is asleep.")
      ))
    }
    return CodeLinkRemoteModel.preview(
      macs: macs, sessions: sessions, open: custom ?? (open ? snapshot : nil), providers: customProviders ?? providers,
      diff: diff, terminal: terminal ? "$ npm test -- cart\r\n\r\n PASS  src/cart/total.test.ts\r\n  total\r\n    \u{2713} sums in cents (3 ms)\r\n    \u{2713} rounds to the cent (1 ms)\r\n\r\nTests: 2 passed, 2 total\r\n$ " : nil,
      git: git, linkError: linkError
    )
  }

  func shoot<V: View>(_ name: String, settle: Double = 0.9, keyboard: Bool = false, @ViewBuilder _ make: () -> V) async throws {
    try await Self.shoot(name, settle: settle, keyboard: keyboard, make)
  }

  /// Draws `make()` in a window of the hosted app, light then dark. With
  /// `keyboard`, the window is made key so a field that focuses itself
  /// raises the keyboard, and the keyboard's own windows are drawn on top.
  static func shoot<V: View>(
    _ name: String, settle: Double = 0.9, keyboard: Bool = false, size: CGSize = CGSize(width: 402, height: 874),
    @ViewBuilder _ make: () -> V
  ) async throws {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { throw XCTSkip("No window scene in the host app") }
    for style in [UIUserInterfaceStyle.light, .dark] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(origin: .zero, size: size)
      window.overrideUserInterfaceStyle = style
      let host = UIHostingController(rootView: make().tint(Color.junoAccent))
      window.rootViewController = host
      if keyboard { window.makeKeyAndVisible() } else { window.isHidden = false }
      try await Task.sleep(for: .seconds(settle))
      let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
      let image = renderer.image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        if keyboard {
          for other in scene.windows where other !== window && !other.isHidden
            && String(describing: type(of: other)).contains("Keyboard") {
            other.drawHierarchy(in: other.frame, afterScreenUpdates: false)
          }
        }
      }
      window.endEditing(true)
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

/// The remote's entries in Chat's selector and thinking panel: Alevr's API
/// models as labs (with the account's Chat facts), the Mac's plans apart,
/// each with the levels the Mac sent, and a pick choosing source and model.
@MainActor
final class JunoMobileLinkModelOptionsTests: XCTestCase {
  func testTheSelectorListsAlevrsAPIModelsAndTheMacsPlans() throws {
    let model = JunoMobileLinkSnapshotTests.composerRowModel(
      selection: JunoMobileLinkSnapshotTests.gpt, providers: JunoMobileLinkSnapshotTests.pickerProviders
    )
    let picker = model.picker
    let manifest = [
      NativeChatModelOption(
        id: "openai:gpt-6.1", providerID: "openai", providerName: "OpenAI · GPT", displayName: "GPT-6.1",
        summary: "Strong all-round reasoning", minimumPlan: "pro", availability: "available", contextWindowTokens: 400_000,
        pricing: NativeModelPricing(priceClass: "premium", inputPerMillion: 2, outputPerMillion: 8, currency: "USD"),
        supportedReasoningEfforts: [.low], canDisableReasoning: false, supportsStreaming: true
      ),
    ]
    let labs = picker.api.map { JunoMobileLinkModelOptions.option($0, chatModels: manifest) }
    XCTAssertEqual(labs.map(\.id), [
      "alevr|anthropic:claude-opus-5-5", "alevr|anthropic:claude-sonnet-5-5", "alevr|openai:gpt-6.1",
      "alevr|zhipu:glm-5", "alevr|moonshot:kimi-k2.7", "alevr|google:gemini-3.5-pro",
    ])
    XCTAssertEqual(labs.map(\.providerID), ["anthropic", "anthropic", "openai", "zhipu", "moonshot", "google"])
    XCTAssertTrue(labs.allSatisfy(\.isAvailable), "every one can be picked")
    let gpt = labs[2]
    XCTAssertEqual(gpt.summary, "Strong all-round reasoning", "Chat's line for the same model")
    XCTAssertEqual(gpt.contextWindowTokens, 400_000)
    XCTAssertNotNil(gpt.pricing)
    XCTAssertEqual(gpt.supportedReasoningEfforts, [.minimal, .low, .medium, .high, .xhigh], "the Mac's levels, not Chat's")
    XCTAssertTrue(labs[3].canDisableReasoning, "GLM can think or not")
    XCTAssertEqual(NativeThinkingScale(model: labs[3]).stops.count, 2)
    XCTAssertEqual(labs[4].supportedReasoningEfforts, [.low, .medium, .high, .xhigh], "no levels of its own: the engine's")

    let plans = JunoMobileLinkModelOptions.plans(picker, chatModels: manifest)
    XCTAssertEqual(plans.map(\.title), ["Claude plan", "ChatGPT plan"])
    XCTAssertEqual(plans.map(\.providerID), ["anthropic", "openai"])
    XCTAssertEqual(plans[0].models.map(\.id), ["claude-agent:default|claude-opus-5-5", "claude-agent:default|claude-sonnet-5-5"])
    XCTAssertTrue(plans.flatMap(\.models).allSatisfy { $0.pricing == nil }, "a plan pays, never per token")
    XCTAssertEqual(plans[0].models[0].supportedReasoningEfforts, [.low, .medium, .high, .max])

    // Picking a row picks its source and model, effort kept where offered.
    model.composer.choose(try XCTUnwrap(picker.entry(labs[0].id)))
    XCTAssertEqual(model.composer.selection, CodeV2.ModelSelection(instanceId: "alevr", model: "anthropic:claude-opus-5-5", effort: .high))
    model.composer.choose(try XCTUnwrap(picker.entry(plans[0].models[0].id)))
    XCTAssertEqual(model.composer.selection?.instanceId, "claude-agent:default")
    XCTAssertEqual(JunoMobileLinkModelOptions.panelName(try XCTUnwrap(picker.entry(for: model.composer.selection))), "Opus 5.5 \u{00B7} Claude")

    // The panel's stops and the wire's levels.
    XCTAssertNil(JunoMobileLinkModelOptions.nativeEffort(CodeV2.EffortLevel.none))
    XCTAssertEqual(JunoMobileLinkModelOptions.nativeEffort(.xhigh), .xhigh)
    XCTAssertEqual(JunoMobileLinkModelOptions.codeEffort(nil, levels: [.none, .high]), CodeV2.EffortLevel.none)
    XCTAssertNil(JunoMobileLinkModelOptions.codeEffort(nil, levels: [.low, .high]))
    XCTAssertEqual(JunoMobileLinkModelOptions.codeEffort(.max, levels: [.low, .max]), .max)
  }
}
