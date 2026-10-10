import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Offscreen stills for the release review, light and dark: the model
/// selector the composer opens and the Library, both over the preview world.
/// Drawn in a window of the hosted app; nothing is driven on screen.
///
/// Writes PNGs only when `JUNO_SNAPSHOT_DIR` is set (pass it to xcodebuild as
/// `TEST_RUNNER_JUNO_SNAPSHOT_DIR`); otherwise each case still renders and
/// asserts the image is not blank.
@MainActor
final class JunoMobileOwnerSnapshotTests: XCTestCase {
  private static let size = CGSize(width: 402, height: 874)

  func testModelSelector() async throws {
    try await shoot("model-selector") { world in
      JunoMobileModelSelectorView(
        models: world.conversationModel.composerCatalog,
        selectedModelID: "juno:auto",
        onSelect: { _ in }
      )
    }
  }

  func testLibrary() async throws {
    try await shoot("library", settle: 1.6) { world in
      NavigationStack {
        JunoMobileLibraryView(model: world.projectModel, accountID: world.accountID)
      }
    }
  }

  private func shoot<V: View>(
    _ name: String,
    settle: Double = 1.0,
    @ViewBuilder _ make: (PreviewWorld) -> V
  ) async throws {
    let world = try PreviewWorld(scenario: .normal)
    await world.activate()
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { throw XCTSkip("No window scene in the host app") }
    for style in [UIUserInterfaceStyle.light, .dark] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(origin: .zero, size: Self.size)
      window.overrideUserInterfaceStyle = style
      let host = UIHostingController(rootView: make(world).tint(Color.junoAccent))
      window.rootViewController = host
      window.isHidden = false
      try await Task.sleep(for: .seconds(settle))
      let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      window.isHidden = true
      window.rootViewController = nil
      let data = try XCTUnwrap(image.pngData())
      XCTAssertGreaterThan(data.count, 2_000, "\(name) rendered blank")
      if let directory = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] {
        let url = URL(fileURLWithPath: directory)
          .appendingPathComponent("ios-\(name)-\(style == .dark ? "dark" : "light").png")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
      }
    }
  }
}
