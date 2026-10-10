import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoVoiceKit
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Offscreen stills of the composer's voice states, light and dark: empty
/// (the voice face), typed (Send), dictating mid-sentence, and a call
/// listening and speaking. Drawn in a window of the hosted app, so Liquid
/// Glass and the web icon set render as they do on a phone; nothing is
/// driven on screen.
///
/// Writes PNGs only when `JUNO_SNAPSHOT_DIR` is set (pass it to xcodebuild as
/// `TEST_RUNNER_JUNO_SNAPSHOT_DIR`); otherwise each case still renders, so a
/// layout that traps is caught, and asserts the image is not blank.
@MainActor
final class JunoMobileVoiceSnapshotTests: XCTestCase {
  private static let size = CGSize(width: 402, height: 320)

  override func tearDown() {
    JunoComposerPreviewFlags.overrides = [:]
    super.tearDown()
  }

  func testComposerEmptyShowsVoice() async throws {
    try await shoot("composer-empty") { world in
      ComposerHarness(world: world, prompt: "")
    }
  }

  func testComposerTypedShowsSend() async throws {
    try await shoot("composer-typed") { world in
      ComposerHarness(world: world, prompt: "Summarise the design review notes")
    }
  }

  func testComposerDictating() async throws {
    JunoComposerPreviewFlags.overrides["--juno-preview-dictation"] = "transcribed"
    try await shoot("composer-dictating", settle: 1.6) { world in
      ComposerHarness(world: world, prompt: "")
    }
  }

  func testVoiceListening() async throws {
    try await shoot("voice-listening", settle: 1.4) { world in
      ComposerHarness(world: world, prompt: "", voice: Self.call(speaking: false))
    }
  }

  func testVoiceSpeaking() async throws {
    try await shoot("voice-speaking", settle: 1.4) { world in
      ComposerHarness(world: world, prompt: "", voice: Self.call(speaking: true))
    }
  }

  func testDictationRowAlone() async throws {
    let samples = (0..<72).map { index -> Double in
      let t = Double(index) / 30 + 1.3
      return 0.22 + 0.62 * (0.5 + 0.5 * sin(t * 1.9) * sin(t * 0.7 + 1)) * (0.55 + 0.45 * (0.5 + 0.5 * sin(t * 13)))
    }
    try await shoot("dictation-row", size: CGSize(width: 402, height: 72)) { _ in
      JunoMobileDictationRow(samples: samples)
        .padding(.horizontal, 22)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.junoCanvas)
    }
  }

  // MARK: - Fixtures

  private static func call(speaking: Bool) -> JunoMobileVoiceSession {
    let controller = JunoRealtimeVoiceController(authorization: NoRelay())
    var lines: [(role: JunoVoiceTranscriptRole, text: String)] = [
      (role: .user, text: "What changed in the review?"),
      (role: .assistant, text: "Two things moved to Thursday."),
    ]
    if speaking { lines.append((role: .user, text: "Tell the team.")) }
    controller.beginPreviewSession(lines: lines, assistantSpeaking: speaking)
    return JunoMobileVoiceSession(
      controller: controller,
      accountID: try! AccountID("snapshot"),
      attachmentContextClient: nil,
      saveTranscript: nil,
      close: {}
    )
  }

  private func shoot<V: View>(
    _ name: String,
    size: CGSize = JunoMobileVoiceSnapshotTests.size,
    settle: Double = 0.8,
    @ViewBuilder _ make: (PreviewWorld) -> V
  ) async throws {
    let world = try PreviewWorld(scenario: .normal)
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { throw XCTSkip("No window scene in the host app") }
    for style in [UIUserInterfaceStyle.light, .dark] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(origin: .zero, size: size)
      window.overrideUserInterfaceStyle = style
      let host = UIHostingController(rootView: make(world).tint(Color.junoAccent))
      host.view.backgroundColor = .clear
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
        let suffix = style == .dark ? "dark" : "light"
        let url = URL(fileURLWithPath: directory).appendingPathComponent("ios-\(name)-\(suffix).png")
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: url)
      }
    }
  }
}

private struct NoRelay: JunoVoiceRelayAuthorizing {
  func relayToken() async throws -> JunoVoiceRelayToken {
    throw URLError(.notConnectedToInternet)
  }
}

/// The real chat composer over a short exchange, as it sits at the foot of a
/// conversation.
private struct ComposerHarness: View {
  let world: PreviewWorld
  @State var prompt: String
  var voice: JunoMobileVoiceSession?

  @State private var modelID = "juno:auto"
  @State private var effort: NativeReasoningEffort?
  @State private var notice: String?
  @State private var tools = JunoMobileComposerTools(
    defaults: UserDefaults(suiteName: "juno.voice.snapshots") ?? .standard
  )
  @State private var coordinator = JunoMobileAttachmentCoordinator()
  @State private var swell = JunoMobileSendSwell()
  @FocusState private var focused: Bool

  init(world: PreviewWorld, prompt: String, voice: JunoMobileVoiceSession? = nil) {
    self.world = world
    _prompt = State(initialValue: prompt)
    self.voice = voice
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Spacer(minLength: 0)
      Text(verbatim: "Thursday works. I moved the design review to 2 pm and kept the agenda as it was.")
        .junoFont(size: 17, relativeTo: .body)
        .foregroundStyle(Color.junoForeground)
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
      JunoMobileComposer(
        model: world.conversationModel,
        prompt: $prompt,
        selectedModelID: $modelID,
        reasoningEffort: $effort,
        thinkingNotice: $notice,
        tools: tools,
        attachmentCoordinator: coordinator,
        openVoiceMode: {},
        composerFocused: $focused,
        sendSwell: swell
      )
      .padding(.bottom, 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.junoCanvas)
    .environment(\.junoVoiceSession, voice)
  }
}
