import CoreGraphics
import Foundation
@testable import JunoScreenControl

// Fakes for every seam the service has with the Mac. Nothing here captures
// the screen, reads the accessibility tree of a real app or posts an event.

/// A solid image with optional coloured rectangles, in device pixels.
func makeImage(
    width: Int,
    height: Int,
    background: (Double, Double, Double) = (0.96, 0.96, 0.95),
    rects: [(CGRect, (Double, Double, Double))] = []
) -> CGImage {
    let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setFillColor(CGColor(srgbRed: background.0, green: background.1, blue: background.2, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    for (rect, color) in rects {
        context.setFillColor(CGColor(srgbRed: color.0, green: color.1, blue: color.2, alpha: 1))
        // Rects are given top-left origin; CoreGraphics draws bottom-left.
        context.fill(CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height))
    }
    return context.makeImage()!
}

final class FakeCapture: ScreenCapturing, @unchecked Sendable {
    private let lock = NSLock()
    private var windowImages: [UInt32: CGImage] = [:]
    var displayImage: CGImage?
    private(set) var excludedOwn: [OwnProcess] = []
    private(set) var windowCaptures = 0
    /// Called before each window capture, so a test can change the screen
    /// "while" an action waits.
    var beforeCapture: (@Sendable () async -> Void)?
    var backingScale = 2.0
    var windowFrames: [UInt32: ScreenRect] = [:]

    func setImage(_ image: CGImage, window: UInt32, frame: ScreenRect) {
        lock.withLock {
            windowImages[window] = image
            windowFrames[window] = frame
        }
    }

    func capture(window: WindowInfo) async throws -> CapturedImage {
        await beforeCapture?()
        let (image, frame) = lock.withLock { (windowImages[window.windowID], windowFrames[window.windowID]) }
        lock.withLock { windowCaptures += 1 }
        guard let image else { throw ScreenControlError.windowGone(app: window.appName) }
        let rect = frame ?? window.frame
        return CapturedImage(
            image: image,
            origin: ScreenPoint(x: rect.x, y: rect.y),
            pointWidth: rect.width,
            pointHeight: rect.height,
            backingScale: backingScale,
            displayID: window.displayID,
            windowTitle: window.title
        )
    }

    func capture(display: DisplayInfo, excluding own: OwnProcess) async throws -> CapturedImage {
        lock.withLock { excludedOwn.append(own) }
        let image = displayImage ?? makeImage(width: Int(display.frame.width * display.backingScale), height: Int(display.frame.height * display.backingScale))
        return CapturedImage(
            image: image,
            origin: ScreenPoint(x: display.frame.x, y: display.frame.y),
            pointWidth: display.frame.width,
            pointHeight: display.frame.height,
            backingScale: display.backingScale,
            displayID: display.id
        )
    }
}

final class FakeEnvironment: ScreenEnvironment, @unchecked Sendable {
    let ownProcess = OwnProcess(pid: 999, bundleID: "com.liammagnier.JunoDesktop.debug")
    private let lock = NSLock()
    var apps: [RunningApp] = []
    var installed: [InstalledApp] = []
    var front: RunningApp?
    var windowsByPID: [Int32: [WindowInfo]] = [:]
    var screens: [DisplayInfo] = [
        DisplayInfo(id: 1, name: "Built-in Retina Display", frame: ScreenRect(x: 0, y: 0, width: 1512, height: 982), backingScale: 2, isMain: true),
    ]
    private(set) var opened: [String] = []

    func runningApps() async -> [RunningApp] { lock.withLock { apps } }
    func installedApps() async -> [InstalledApp] { lock.withLock { installed } }
    func frontmostApp() async -> RunningApp? { lock.withLock { front } }
    func windows(pid: Int32) async -> [WindowInfo] { lock.withLock { windowsByPID[pid] ?? [] } }
    func displays() async -> [DisplayInfo] { lock.withLock { screens } }
    private(set) var activated: [Int32] = []
    func activate(pid: Int32) async -> Bool {
        lock.withLock {
            activated.append(pid)
            guard let app = apps.first(where: { $0.pid == pid }) else { return false }
            front = app
            return true
        }
    }
    func open(bundleID: String) async throws -> RunningApp {
        lock.withLock { opened.append(bundleID) }
        guard let app = lock.withLock({ apps.first { $0.bundleID == bundleID } }) else {
            throw ScreenControlError.invalidInput("\(bundleID) is not installed.")
        }
        return app
    }
}

final class FakeAccessibility: AccessibilityInspecting, @unchecked Sendable {
    private let lock = NSLock()
    /// Regions of the screen and what is there.
    var regions: [(ScreenRect, ScreenTarget)] = []
    var focused: [Int32: ScreenTarget] = [:]
    var snapshots: [Int32: AXSnapshot] = [:]
    var pressSucceeds = true
    var settableText = true
    var values: [Int32: String] = [:]
    private(set) var presses: [ScreenPoint?] = []
    private(set) var menus: [[String]] = []
    private(set) var setTexts: [(String, Bool)] = []

    func target(at point: ScreenPoint, within pid: Int32?) async -> ScreenTarget? {
        lock.withLock {
            regions.last { $0.0.contains(point) && (pid == nil || $0.1.pid == pid) }?.1
        }
    }

    func focusedTarget(pid: Int32) async -> ScreenTarget? { lock.withLock { focused[pid] } }

    func snapshot(pid: Int32, maxDepth: Int) async throws -> AXSnapshot {
        guard let snapshot = lock.withLock({ snapshots[pid] }) else {
            throw ScreenControlError.unsupported("No tree.")
        }
        return snapshot
    }

    func press(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool {
        lock.withLock { presses.append(point) }
        return pressSucceeds
    }

    func showMenu(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool { false }

    func setText(_ text: String, elementID: String?, pid: Int32, replace: Bool) async throws -> Bool {
        lock.withLock {
            setTexts.append((text, replace))
            guard settableText else { return false }
            values[pid] = replace ? text : (values[pid] ?? "") + text
            return true
        }
    }

    func value(elementID: String?, pid: Int32) async -> String? { lock.withLock { values[pid] } }

    func pressMenu(pid: Int32, path: [String]) async throws -> [String] {
        lock.withLock { menus.append(path) }
        return path
    }
}

final class FakeStopTap: EmergencyStopTapping, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var started = 0
    private(set) var stopped = 0
    private(set) var watches = false
    private var onEscape: (@Sendable () -> Void)?
    private var onReaderInput: (@Sendable () -> Void)?

    func start(watchReaderInput: Bool, onEscape: @escaping @Sendable () -> Void, onReaderInput: @escaping @Sendable () -> Void) -> Bool {
        lock.withLock {
            started += 1
            watches = watchReaderInput
            self.onEscape = onEscape
            self.onReaderInput = onReaderInput
        }
        return true
    }

    func setWatchesReaderInput(_ watches: Bool) { lock.withLock { self.watches = watches } }
    func stop() { lock.withLock { stopped += 1 } }

    func pressEscape() { lock.withLock { onEscape }?() }
    func readerMovesMouse() { lock.withLock { onReaderInput }?() }
}

/// A Mac with TextEdit, Terminal and Juno running, TextEdit's window at a
/// known place, its Save button at a known point.
struct ScreenFixture {
    let capture = FakeCapture()
    let environment = FakeEnvironment()
    let accessibility = FakeAccessibility()
    let sink = RecordingEventSink()
    let tap = FakeStopTap()
    let clock = TestClock()
    /// Runs inside every pause the service or driver takes, so a test can
    /// press Esc in the middle of an action.
    let pauseHook = PauseHook()
    let service: ScreenControlService

    static let textEdit = RunningApp(pid: 101, bundleID: "com.apple.TextEdit", name: "TextEdit")
    static let terminal = RunningApp(pid: 102, bundleID: "com.apple.Terminal", name: "Terminal")
    static let safari = RunningApp(pid: 103, bundleID: "com.apple.Safari", name: "Safari")
    static let mail = RunningApp(pid: 104, bundleID: "com.apple.mail", name: "Mail")
    static let juno = RunningApp(pid: 999, bundleID: "com.liammagnier.JunoDesktop.debug", name: "Juno")
    static let windowFrame = ScreenRect(x: 200, y: 100, width: 800, height: 600)
    /// TextEdit's Save button, in global points.
    static let saveButton = ScreenRect(x: 900, y: 620, width: 80, height: 30)
    static let nameField = ScreenRect(x: 300, y: 200, width: 300, height: 24)

    init(layout: KeyboardLayout = .usANSI) {
        environment.apps = [Self.textEdit, Self.terminal, Self.safari, Self.mail, Self.juno]
        environment.front = Self.juno
        for app in [Self.textEdit, Self.terminal, Self.safari, Self.mail] {
            environment.windowsByPID[app.pid] = [
                WindowInfo(windowID: UInt32(app.pid), pid: app.pid, bundleID: app.bundleID, appName: app.name,
                           title: "Untitled", frame: Self.windowFrame, displayID: 1),
            ]
            capture.setImage(makeImage(width: 1600, height: 1200), window: UInt32(app.pid), frame: Self.windowFrame)
        }
        accessibility.regions = [
            (Self.windowFrame, ScreenTarget(pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
                                           element: AXElementInfo(id: "h", role: "AXTextArea", roleDescription: "text entry area", frame: Self.windowFrame))),
            (Self.saveButton, ScreenTarget(pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
                                          element: AXElementInfo(id: "h", role: "AXButton", roleDescription: "button", title: "Save", frame: Self.saveButton, pressable: true))),
            (Self.nameField, ScreenTarget(pid: 101, bundleID: "com.apple.TextEdit", appName: "TextEdit",
                                         element: AXElementInfo(id: "h", role: "AXTextField", roleDescription: "text field", title: "Name", frame: Self.nameField))),
        ]
        let clock = self.clock
        let hook = self.pauseHook
        service = ScreenControlService(
            dependencies: .init(
                capture: capture,
                environment: environment,
                accessibility: accessibility,
                sink: sink,
                layout: { layout },
                stopTap: tap,
                now: { clock.now },
                pause: { duration in
                    clock.advance(Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18)
                    await hook.run()
                    await Task.yield()
                },
                pointerLocation: { ScreenPoint(x: 400, y: 300) },
                settleTimeout: 0.5,
                settleInterval: .milliseconds(1),
                minimumInputGap: 0
            )
        )
    }

    /// Activates a session and grants it the named apps at their caps.
    func start(session: String = "s1", title: String = "Fix the export sheet", grant apps: [String] = ["com.apple.TextEdit"]) async throws {
        try await service.activate(sessionID: session, title: title)
        await service.setImageBudget(sessionID: session, budget: .anthropicHighResolution)
        if !apps.isEmpty {
            let proposal = try await service.proposeGrants(sessionID: session, apps: apps, reason: nil, clipboardRead: false, clipboardWrite: false)
            _ = try await service.applyGrants(sessionID: session, proposalID: proposal.id)
        }
    }

    /// The frame coordinate of a global point in TextEdit's window.
    func framePoint(_ point: ScreenPoint, scale: Double) -> [Double] {
        [(point.x - Self.windowFrame.x) * 2 * scale, (point.y - Self.windowFrame.y) * 2 * scale]
    }
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_790_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

/// A closure run inside the fixture's pauses, counting them.
final class PauseHook: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable (Int) async -> Void)?
    private var count = 0

    /// `action` gets the 1-based number of the pause it runs in.
    func set(_ action: @escaping @Sendable (Int) async -> Void) {
        lock.withLock {
            self.action = action
            count = 0
        }
    }

    func run() async {
        let (action, number) = lock.withLock { () -> ((@Sendable (Int) async -> Void)?, Int) in
            count += 1
            return (self.action, count)
        }
        await action?(number)
    }
}
