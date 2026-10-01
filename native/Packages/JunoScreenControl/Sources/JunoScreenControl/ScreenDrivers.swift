import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The seams between the service and the real Mac. Production implements
// them with ScreenCaptureKit, Accessibility, NSWorkspace and CGEvent
// (`SystemScreenDrivers.swift`); tests implement them with offscreen bitmaps
// and recorders, so nothing in a test run captures the screen or posts an
// event (CODE_AGENT_SPEC §6.3).

/// A running app.
public struct RunningApp: Hashable, Sendable {
    public var pid: Int32
    public var bundleID: String
    public var name: String
    public var isActive: Bool
    public var appStoreCategory: String?

    public init(pid: Int32, bundleID: String, name: String, isActive: Bool = false, appStoreCategory: String? = nil) {
        self.pid = pid
        self.bundleID = bundleID
        self.name = name
        self.isActive = isActive
        self.appStoreCategory = appStoreCategory
    }
}

/// An app on disk.
public struct InstalledApp: Hashable, Sendable {
    public var bundleID: String
    public var name: String
    public var appStoreCategory: String?

    public init(bundleID: String, name: String, appStoreCategory: String? = nil) {
        self.bundleID = bundleID
        self.name = name
        self.appStoreCategory = appStoreCategory
    }
}

/// One window, as the window server lists it.
public struct WindowInfo: Hashable, Sendable {
    public var windowID: UInt32
    public var pid: Int32
    public var bundleID: String
    public var appName: String
    public var title: String?
    /// Global points.
    public var frame: ScreenRect
    public var displayID: UInt32

    public init(
        windowID: UInt32,
        pid: Int32,
        bundleID: String,
        appName: String,
        title: String?,
        frame: ScreenRect,
        displayID: UInt32
    ) {
        self.windowID = windowID
        self.pid = pid
        self.bundleID = bundleID
        self.appName = appName
        self.title = title
        self.frame = frame
        self.displayID = displayID
    }
}

/// One display.
public struct DisplayInfo: Hashable, Sendable {
    public var id: UInt32
    public var name: String
    /// Global points.
    public var frame: ScreenRect
    public var backingScale: Double
    public var isMain: Bool

    public init(id: UInt32, name: String, frame: ScreenRect, backingScale: Double, isMain: Bool) {
        self.id = id
        self.name = name
        self.frame = frame
        self.backingScale = backingScale
        self.isMain = isMain
    }
}

/// This process, so screen control can recognise Juno and never touch it.
public struct OwnProcess: Hashable, Sendable {
    public var pid: Int32
    public var bundleID: String

    public init(pid: Int32, bundleID: String) {
        self.pid = pid
        self.bundleID = bundleID
    }

    public static var current: OwnProcess {
        OwnProcess(
            pid: ProcessInfo.processInfo.processIdentifier,
            bundleID: Bundle.main.bundleIdentifier ?? AppCategories.junoBundlePrefix
        )
    }

    /// Whether a target belongs to Juno: this process, or any Juno bundle id.
    public func owns(pid otherPID: Int32, bundleID otherBundle: String) -> Bool {
        otherPID == pid
            || otherBundle.lowercased() == bundleID.lowercased()
            || otherBundle.lowercased().hasPrefix(AppCategories.junoBundlePrefix)
    }
}

/// Apps, windows and displays.
public protocol ScreenEnvironment: Sendable {
    var ownProcess: OwnProcess { get }
    func runningApps() async -> [RunningApp]
    func installedApps() async -> [InstalledApp]
    func frontmostApp() async -> RunningApp?
    /// The app's on-screen windows, front first.
    func windows(pid: Int32) async -> [WindowInfo]
    func displays() async -> [DisplayInfo]
    /// Launches an app or finds it running, without bringing it to the
    /// front: background mode leaves the reader's focus alone.
    func open(bundleID: String) async throws -> RunningApp
}

/// Reads and acts through the Accessibility API.
public protocol AccessibilityInspecting: Sendable {
    /// What is under `point`: system-wide (what a real click would hit), or
    /// within one app.
    func target(at point: ScreenPoint, within pid: Int32?) async -> ScreenTarget?
    /// The app's focused element, for typing and keys.
    func focusedTarget(pid: Int32) async -> ScreenTarget?
    /// The app's front window's tree.
    func snapshot(pid: Int32, maxDepth: Int) async throws -> AXSnapshot
    /// `AXPress` on the element at `point` in the app, or on a snapshot id.
    func press(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool
    /// `AXShowMenu`, for a right click.
    func showMenu(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool
    /// Sets text on an element (or the focused one): `insert` at the caret
    /// through `AXSelectedText`, `replace` through `AXValue`. False when the
    /// element takes neither.
    func setText(_ text: String, elementID: String?, pid: Int32, replace: Bool) async throws -> Bool
    /// The value of an element (or the focused one), for the read-back.
    func value(elementID: String?, pid: Int32) async -> String?
    /// Walks the menu bar by titles and presses the last item. Returns the
    /// path as pressed; throws when a title is not found.
    func pressMenu(pid: Int32, path: [String]) async throws -> [String]
}

#if canImport(CoreGraphics)

/// One captured image and where it came from.
public struct CapturedImage: @unchecked Sendable {
    public var image: CGImage
    /// Global points of the captured area's top-left.
    public var origin: ScreenPoint
    public var pointWidth: Double
    public var pointHeight: Double
    public var backingScale: Double
    public var displayID: UInt32
    public var windowTitle: String?

    public init(
        image: CGImage,
        origin: ScreenPoint,
        pointWidth: Double,
        pointHeight: Double,
        backingScale: Double,
        displayID: UInt32,
        windowTitle: String? = nil
    ) {
        self.image = image
        self.origin = origin
        self.pointWidth = pointWidth
        self.pointHeight = pointHeight
        self.backingScale = backingScale
        self.displayID = displayID
        self.windowTitle = windowTitle
    }
}

/// Takes pictures of the screen, at device pixels.
public protocol ScreenCapturing: Sendable {
    /// One window, even behind others (`desktopIndependentWindow`).
    func capture(window: WindowInfo) async throws -> CapturedImage
    /// A whole display, minus Juno's own windows and the presence overlay:
    /// `excludingApplications`, never `excludingWindows: []` (CU-01).
    func capture(display: DisplayInfo, excluding own: OwnProcess) async throws -> CapturedImage
}

#endif
