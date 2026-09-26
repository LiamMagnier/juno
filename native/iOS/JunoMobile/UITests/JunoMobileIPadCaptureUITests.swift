import XCTest

/// Captures the iPad review set: every scenario, in both orientations.
///
/// Not a behavioural test. It exists because `simctl` cannot rotate a
/// simulator and a windowed iPad scene refuses a programmatic orientation
/// change, so an XCUITest's `XCUIDevice.orientation` is the one headless way
/// to screenshot an iPad layout on its side.
///
/// Skipped unless a directory is named, so a normal test run never pays for
/// it:
///
///     TEST_RUNNER_JUNO_CAPTURE_DIR=/tmp/shots \
///     TEST_RUNNER_JUNO_CAPTURE_APPEARANCE=dark \
///     xcodebuild test -only-testing:JunoMobileUITests/JunoMobileIPadCaptureUITests …
///
/// `JUNO_CAPTURE_ONLY` (comma separated names) narrows the scenarios.
final class JunoMobileIPadCaptureUITests: XCTestCase {
  private struct Scenario {
    let name: String
    let arguments: [String]
  }

  private let scenarios: [Scenario] = [
    Scenario(name: "new-chat", arguments: ["--juno-preview-tab", "chat", "--juno-preview-chat-draft"]),
    Scenario(name: "conversation", arguments: ["--juno-preview-tab", "chat"]),
    Scenario(name: "incognito", arguments: ["--juno-preview-incognito"]),
    Scenario(name: "search", arguments: ["--juno-preview-tab", "search"]),
    Scenario(name: "projects", arguments: ["--juno-preview-tab", "projects"]),
    Scenario(
      name: "code-session",
      arguments: ["--juno-preview-tab", "code", "--juno-preview-code-remote-session", "rs-composer"]
    ),
  ]

  @MainActor
  func testCaptureReviewSet() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let directory = environment["JUNO_CAPTURE_DIR"] else {
      throw XCTSkip("Set TEST_RUNNER_JUNO_CAPTURE_DIR to capture the iPad review set.")
    }
    let appearance = environment["JUNO_CAPTURE_APPEARANCE"] ?? "light"
    let only = environment["JUNO_CAPTURE_ONLY"].map { Set($0.split(separator: ",").map(String.init)) }
    let orientations: [(String, UIDeviceOrientation)] =
      (environment["JUNO_CAPTURE_ORIENTATIONS"] ?? "landscape,portrait")
      .split(separator: ",")
      .map { $0 == "portrait" ? ("portrait", .portrait) : ("landscape", .landscapeLeft) }
    try FileManager.default.createDirectory(
      atPath: directory, withIntermediateDirectories: true
    )

    for (orientationName, orientation) in orientations {
      XCUIDevice.shared.orientation = orientation
      for scenario in scenarios where only?.contains(scenario.name) ?? true {
        let app = XCUIApplication()
        app.launchArguments =
          ["--juno-ui-preview", "--juno-preview-appearance", appearance] + scenario.arguments
        app.launch()
        // Entrance motion settles well inside this.
        Thread.sleep(forTimeInterval: 3.5)
        let shot = XCUIScreen.main.screenshot()
        let path = "\(directory)/\(scenario.name)-\(orientationName)-\(appearance).png"
        try shot.pngRepresentation.write(to: URL(fileURLWithPath: path))
        app.terminate()
      }
    }
    XCUIDevice.shared.orientation = .portrait
  }
}
