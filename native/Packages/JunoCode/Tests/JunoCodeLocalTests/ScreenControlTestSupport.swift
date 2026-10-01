import CoreGraphics
import Foundation
import JunoCodeCore
import JunoScreenControl
@testable import JunoCodeLocal

// Inert fakes for the screen-control service, so the coordinator is tested
// against the real service without capturing the screen or posting events.

func solidImage(width: Int, height: Int, gray: Double = 0.95) -> CGImage {
    let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(CGColor(gray: gray, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}

struct LocalFakeCapture: ScreenCapturing {
    func capture(window: WindowInfo) async throws -> CapturedImage {
        CapturedImage(
            image: solidImage(width: Int(window.frame.width * 2), height: Int(window.frame.height * 2)),
            origin: ScreenPoint(x: window.frame.x, y: window.frame.y),
            pointWidth: window.frame.width, pointHeight: window.frame.height,
            backingScale: 2, displayID: 1, windowTitle: window.title
        )
    }

    func capture(display: DisplayInfo, excluding _: OwnProcess) async throws -> CapturedImage {
        CapturedImage(
            image: solidImage(width: 800, height: 500),
            origin: ScreenPoint(x: 0, y: 0), pointWidth: 400, pointHeight: 250, backingScale: 2, displayID: display.id
        )
    }
}

struct LocalFakeEnvironment: ScreenEnvironment {
    let ownProcess = OwnProcess(pid: 999, bundleID: "com.liammagnier.JunoDesktop.debug")
    static let textEdit = RunningApp(pid: 101, bundleID: "com.apple.TextEdit", name: "TextEdit")

    func runningApps() async -> [RunningApp] { [Self.textEdit] }
    func installedApps() async -> [InstalledApp] { [] }
    func frontmostApp() async -> RunningApp? { nil }
    func windows(pid: Int32) async -> [WindowInfo] {
        pid == 101
            ? [WindowInfo(windowID: 7, pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit", title: "Untitled",
                          frame: ScreenRect(x: 100, y: 100, width: 400, height: 300), displayID: 1)]
            : []
    }
    func displays() async -> [DisplayInfo] {
        [DisplayInfo(id: 1, name: "Display", frame: ScreenRect(x: 0, y: 0, width: 1512, height: 982), backingScale: 2, isMain: true)]
    }
    func open(bundleID: String) async throws -> RunningApp { Self.textEdit }
}

struct LocalFakeAccessibility: AccessibilityInspecting {
    func target(at _: ScreenPoint, within _: Int32?) async -> ScreenTarget? { nil }
    func focusedTarget(pid _: Int32) async -> ScreenTarget? { nil }
    func snapshot(pid _: Int32, maxDepth _: Int) async throws -> AXSnapshot {
        AXSnapshot(bundleID: "com.apple.TextEdit", appName: "TextEdit", windowTitle: "Untitled", elements: [])
    }
    func press(at _: ScreenPoint?, elementID _: String?, pid _: Int32) async throws -> Bool { true }
    func showMenu(at _: ScreenPoint?, elementID _: String?, pid _: Int32) async throws -> Bool { true }
    func setText(_: String, elementID _: String?, pid _: Int32, replace _: Bool) async throws -> Bool { true }
    func value(elementID _: String?, pid _: Int32) async -> String? { nil }
    func pressMenu(pid _: Int32, path: [String]) async throws -> [String] { path }
}

/// TCC answers, counting every request so a test can prove nothing prompted.
final class FakePermissions: ComputerUsePermissionChecking, @unchecked Sendable {
    let screen: ComputerUsePermissionState
    let accessibility: ComputerUsePermissionState
    private let lock = NSLock()
    private var count = 0

    init(screen: ComputerUsePermissionState = .granted, accessibility: ComputerUsePermissionState = .granted) {
        self.screen = screen
        self.accessibility = accessibility
    }

    var requests: Int { lock.withLock { count } }

    func screenCapturePermission() -> ComputerUsePermissionState { screen }
    func accessibilityPermission() -> ComputerUsePermissionState { accessibility }
    func requestScreenCapturePermission() -> ComputerUsePermissionState {
        lock.withLock { count += 1 }
        return screen
    }
    func requestAccessibilityPermission() -> ComputerUsePermissionState {
        lock.withLock { count += 1 }
        return accessibility
    }
}

func makeTestScreenService() -> ScreenControlService {
    ScreenControlService(
        dependencies: .init(
            capture: LocalFakeCapture(),
            environment: LocalFakeEnvironment(),
            accessibility: LocalFakeAccessibility(),
            sink: RecordingEventSink(),
            pause: { _ in await Task.yield() },
            settleTimeout: 0.05,
            settleInterval: .milliseconds(1),
            minimumInputGap: 0
        )
    )
}
