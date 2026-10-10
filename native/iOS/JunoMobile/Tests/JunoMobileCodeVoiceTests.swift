import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoVoiceKit
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Code on the phone (owner, 2026-10-10): the composer's dictation and voice,
/// a call that sends each finished sentence to the thread, and the mode chip.
/// With `JUNO_SNAPSHOT_DIR` set, offscreen pictures of the composer.
@MainActor
final class JunoMobileCodeVoiceTests: XCTestCase {
  private typealias Line = JunoRealtimeVoiceController.TranscriptLine

  func testEachFinishedSentenceGoesToTheThreadOnce() {
    var relay = JunoMobileCodeVoiceRelay()
    let first = Line(role: .user, text: "Run the tests", final: true)
    let partial = Line(role: .user, text: "and then", final: false)
    XCTAssertEqual(relay.requests(in: [first, partial]), ["Run the tests"])
    XCTAssertEqual(relay.requests(in: [first, partial]), [])
    let finished = Line(id: partial.id, role: .user, text: "and then fix what fails", final: true)
    XCTAssertEqual(relay.requests(in: [first, finished]), ["and then fix what fails"])
    XCTAssertEqual(relay.requests(in: [Line(role: .user, text: JunoMobileCodeVoiceRelay.readBackPrompt, final: true)]), [])
  }

  func testAReplyIsReadBackOnceWhenTheRunStops() {
    var relay = JunoMobileCodeVoiceRelay()
    XCTAssertNil(relay.reply(wasRunning: false, isRunning: true, latest: "x"))
    XCTAssertEqual(relay.reply(wasRunning: true, isRunning: false, latest: " Done. "), "Done.")
    XCTAssertNil(relay.reply(wasRunning: true, isRunning: false, latest: "Done."))
    let briefing = JunoMobileCodeVoiceRelay.briefing(place: "storefront", turns: [(.user, "hi")])
    XCTAssertTrue(briefing.first?.text.contains("working in storefront") == true)
  }

  func testTheModeLadderMatchesTheWebAndTheRoadsIntoARun() {
    XCTAssertEqual(CodeComposerModeLadder.allCases.map(\.title), ["Ask", "Accept edits", "Auto", "Plan", "Full access"])
    XCTAssertEqual(CodeComposerModeLadder.cloud.compactMap(\.cloudPermissionMode), ["auto-edit", "plan", "full"])
    XCTAssertNil(CodeComposerModeLadder.ask.cloudPermissionMode)
    XCTAssertEqual(CodeComposerModeLadder.full.remoteName, "full")
    XCTAssertEqual(CodeComposerModeLadder(remoteName: "fullAccess"), .full)
    XCTAssertEqual(CodeComposerModeLadder(remoteName: "approvalRequired"), .ask)
    XCTAssertEqual(CodeComposerModeLadder(remoteName: "auto"), .acceptEdits)
    XCTAssertEqual(CodeComposerModeLadder(remoteName: "readOnly"), .plan)
    for mode in CodeComposerModeLadder.allCases {
      XCTAssertFalse(mode.detail.contains("\u{2014}"), "no em-dashes: \(mode)")
    }
    let defaults = try! XCTUnwrap(UserDefaults(suiteName: "code-voice-tests"))
    CodeComposerModeLadder.plan.remember(project: "acme/shop", defaults: defaults)
    XCTAssertEqual(CodeComposerModeLadder.remembered(project: "acme/shop", offered: CodeComposerModeLadder.cloud, defaults: defaults), .plan)
    XCTAssertNil(CodeComposerModeLadder.remembered(project: "other", offered: CodeComposerModeLadder.cloud, defaults: defaults))
  }

  // MARK: - Snapshots

  private struct NoRelay: JunoVoiceRelayAuthorizing {
    func relayToken() async throws -> JunoVoiceRelayToken { throw CancellationError() }
  }

  func testSnapshotsOfTheCodeComposer() async throws {
    guard let dir = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] else {
      throw XCTSkip("Set JUNO_SNAPSHOT_DIR (TEST_RUNNER_JUNO_SNAPSHOT_DIR) to draw the Code composer.")
    }
    let out = URL(fileURLWithPath: dir).appendingPathComponent("code-voice").path
    let world = try PreviewWorld(scenario: .normal)
    await world.codeModel.start(for: world.accountID)
    let remote = world.remoteCodeModel
    remote.start(for: world.accountID)
    remote.updateHosts(from: world.codeModel.devices)
    await remote.refreshAllSessions()
    let session = try XCTUnwrap(
      remote.sessions.first { $0.sessionID == PreviewCodeRemoteFixtures.doneSessionID } ?? remote.sessions.first
    )
    remote.openSession(session.sessionID)
    await remote.pollEvents(deviceID: session.deviceID, sessionID: session.sessionID)

    let controller = JunoRealtimeVoiceController(authorization: NoRelay(), provider: .qwen)
    controller.beginPreviewSession(
      lines: [(.user, "Add a test for the cart totals"), (.assistant, "Sending that to the session.")],
      assistantSpeaking: true
    )
    let call = JunoMobileVoiceSession(
      controller: controller, accountID: world.accountID,
      attachmentContextClient: nil, saveTranscript: nil, close: {}
    )

    func thread(dictating: Bool = false, call: JunoMobileVoiceSession? = nil) -> some View {
      NavigationStack {
        JunoMobileCodeRemoteThreadView(model: remote, session: session, opensDictating: dictating)
      }
      .environment(\.junoStartCodeVoice, { _ in })
      .environment(\.junoCodeVoiceSession, call)
    }

    for style in [UIUserInterfaceStyle.light, .dark] {
      let suffix = style == .dark ? "dark" : "light"
      // The thread view closes the session when it leaves: reopen and
      // re-read before each picture so every one shows the conversation.
      for (name, dictating, live) in [("composer", false, false), ("dictation", true, false), ("voice", false, true)] {
        remote.openSession(session.sessionID)
        await remote.pollEvents(deviceID: session.deviceID, sessionID: session.sessionID)
        try render(thread(dictating: dictating, call: live ? call : nil), name: "ios-\(name)-\(suffix)", style: style, into: out)
      }
      try render(ModeMenuStandIn(current: .full), name: "ios-mode-menu-\(suffix)", style: style, into: out)
      try render(
        NavigationStack {
          JunoMobileCodeView(model: world.codeModel, remoteModel: remote, startConversation: { _ in })
        }
        .environment(\.junoStartCodeVoice, { _ in }),
        name: "ios-start-composer-\(suffix)", style: style, into: out
      )
    }
    controller.end()
  }

  private func render(_ view: some View, name: String, style: UIUserInterfaceStyle, into dir: String) throws {
    let size = CGSize(width: 402, height: 874)
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(origin: .zero, size: size)
    window.overrideUserInterfaceStyle = style
    let host = UIHostingController(rootView: view)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(1.2))
    let image = UIGraphicsImageRenderer(size: size).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try XCTUnwrap(image.pngData()).write(to: url)
    window.isHidden = true
  }
}

/// What the mode menu holds, as the system menu lists it: each rung's glyph,
/// name and line, the current one checked.
private struct ModeMenuStandIn: View {
  let current: CodeComposerModeLadder

  var body: some View {
    VStack {
      Spacer()
      VStack(alignment: .leading, spacing: 0) {
        ForEach(CodeComposerModeLadder.remote) { mode in
          HStack(alignment: .top, spacing: JunoSpace.snug) {
            JunoIconView(.check, size: 13).opacity(mode == current ? 1 : 0).padding(.top, 3)
            VStack(alignment: .leading, spacing: 2) {
              Text(mode.title).font(.body)
              Text(mode.detail).font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            JunoIconView(mode.icon, size: 16).padding(.top, 2)
          }
          .padding(.horizontal, JunoSpace.cozy)
          .padding(.vertical, 10)
          if mode != CodeComposerModeLadder.remote.last { Divider() }
        }
        Text("The phone can lower this session's mode. Raising it past what the Mac set is done on the Mac.")
          .font(.footnote).foregroundStyle(.secondary)
          .padding(JunoSpace.cozy)
      }
      .frame(width: 300)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.junoSurface))
      .shadow(color: .black.opacity(0.2), radius: 18, y: 8)
      .padding(.bottom, 120)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.junoCanvas)
  }
}
