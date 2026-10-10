import JunoCodeKit
import JunoCore
import JunoDesignSystem
import SwiftUI
import UIKit
import XCTest
@testable import JunoMobile

/// Offscreen stills of the pairing sheet, light and dark: the scanner's
/// chrome over a stand-in for the camera, the approve screen, paired, and an
/// expired code. Drawn in a window of the hosted app so Liquid Glass and the
/// web icon set render as on a phone; nothing is driven on screen.
///
/// Writes PNGs only when `JUNO_SNAPSHOT_DIR` is set (pass it to xcodebuild as
/// `TEST_RUNNER_JUNO_SNAPSHOT_DIR`); otherwise each case still renders and
/// asserts the image is not blank.
@MainActor
final class JunoMobilePairingSnapshotTests: XCTestCase {
  private static let size = CGSize(width: 402, height: 874)
  private static let now = Date(timeIntervalSince1970: 1_800_000_000)
  private static let summary = RemotePairingSummary(
    id: "offer_1", kind: .phone, deviceId: "mac_1", deviceName: "Liam's MacBook Pro",
    expiresAt: now.addingTimeInterval(102)
  )

  func testScanner() async throws {
    try await shoot("pairing-scanner") {
      JunoMobilePairingScannerScreen(
        hint: nil, cameraOverride: AnyView(CameraStandIn()), accessOverride: .granted,
        scanned: { _ in }, close: {}
      )
    }
  }

  func testScannerHint() async throws {
    try await shoot("pairing-scanner-hint") {
      JunoMobilePairingScannerScreen(
        hint: JunoMobileRemotePairingModel.notAPairingCodeHint, cameraOverride: AnyView(CameraStandIn()),
        accessOverride: .granted, scanned: { _ in }, close: {}
      )
    }
  }

  func testScannerCameraDenied() async throws {
    try await shoot("pairing-camera-denied") {
      JunoMobilePairingScannerScreen(
        hint: nil, cameraOverride: AnyView(CameraStandIn()), accessOverride: .denied,
        scanned: { _ in }, close: {}
      )
    }
  }

  func testApprovePending() async throws {
    try await shoot("pairing-approve") {
      JunoMobilePairingApproveScreen(
        summary: Self.summary, busy: nil, now: Self.now,
        approve: {}, deny: {}, expired: {}, close: {}
      )
    }
  }

  func testPaired() async throws {
    try await shoot("pairing-success") {
      JunoMobilePairingResultScreen(
        result: .paired("Liam's MacBook Pro"),
        primary: ("Open Code", {}), secondary: ("Done", {}), close: {}
      )
    }
  }

  func testExpired() async throws {
    try await shoot("pairing-expired") {
      JunoMobilePairingResultScreen(
        result: .failed(.expired),
        primary: ("Scan again", {}), secondary: ("Close", {}), close: {}
      )
    }
  }

  private func shoot<V: View>(_ name: String, settle: Double = 0.8, @ViewBuilder _ make: () -> V) async throws {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { throw XCTSkip("No window scene in the host app") }
    for style in [UIUserInterfaceStyle.light, .dark] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(origin: .zero, size: Self.size)
      window.overrideUserInterfaceStyle = style
      let host = UIHostingController(rootView: make().tint(Color.junoAccent))
      host.view.backgroundColor = .clear
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
        let suffix = style == .dark ? "dark" : "light"
        let url = URL(fileURLWithPath: directory).appendingPathComponent("ios-\(name)-\(suffix).png")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
      }
    }
  }
}

/// A desk under a laptop's screen, standing in for the camera: dark, warm,
/// out of focus, with the Mac's QR glowing where the viewfinder looks.
private struct CameraStandIn: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color(red: 0.16, green: 0.15, blue: 0.14), Color(red: 0.07, green: 0.07, blue: 0.08)],
        startPoint: .top, endPoint: .bottom
      )
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .fill(Color(red: 0.86, green: 0.86, blue: 0.84))
        .frame(width: 420, height: 300)
        .blur(radius: 18)
        .offset(y: -60)
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.white)
        .frame(width: 170, height: 170)
        .overlay(
          Canvas { context, size in
            let cells = 21
            let cell = size.width / CGFloat(cells)
            var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
            for y in 0..<cells {
              for x in 0..<cells {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                let finder = (x < 7 && y < 7) || (x >= cells - 7 && y < 7) || (x < 7 && y >= cells - 7)
                let on = finder
                  ? (x % 6 == 0 || y % 6 == 0 || (x % 7 >= 2 && x % 7 <= 4 && y % 7 >= 2 && y % 7 <= 4)
                    || ((cells - 1 - x) % 6 == 0 && x >= cells - 7) || ((cells - 1 - y) % 6 == 0 && y >= cells - 7))
                  : (seed >> 33) & 1 == 1
                if on {
                  context.fill(
                    Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)),
                    with: .color(.black)
                  )
                }
              }
            }
          }
          .padding(12)
        )
        .blur(radius: 1.2)
        .offset(y: -40)
    }
  }
}
