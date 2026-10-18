#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// The real Mac: ScreenCaptureKit for pictures, Accessibility for elements,
// NSWorkspace for apps, CGEvent for input. Reached only through
// `ScreenControlService`, after its checks; never constructed by a tool.

extension ScreenControlService {
    /// The app's one service. Juno Code and Juno Work both use this instance,
    /// which is what makes the lock and the stop app-wide.
    public static let shared = ScreenControlService(
        dependencies: .system,
        // One pointer across processes too: the env server's connected
        // agents and any second copy of the app (Code v2 SPEC §3.12).
        lock: ScreenControlLock(file: DesktopLockFile()),
        feed: .shared
    )
}

extension ScreenControlService.Dependencies {
    public static var system: Self {
        Self(
            capture: SystemScreenCapture(),
            environment: SystemScreenEnvironment(),
            accessibility: SystemAccessibility(),
            sink: SystemEventSink(),
            layout: { await MainActor.run { KeyboardLayoutMapper.current() ?? .usANSI } },
            stopTap: SystemEmergencyStopTap(),
            pointerLocation: {
                guard let location = CGEvent(source: nil)?.location else { return nil }
                return ScreenPoint(x: location.x, y: location.y)
            },
            // A locked Mac pauses every run; the display stays awake only
            // while one is working. Neither ever unlocks anything.
            sessionLock: SystemSessionLockMonitor(),
            displayAwake: SystemDisplayAwakeAssertion()
        )
    }
}

// MARK: - Apps, windows, displays

public struct SystemScreenEnvironment: ScreenEnvironment {
    public let ownProcess: OwnProcess

    public init(ownProcess: OwnProcess = .current) {
        self.ownProcess = ownProcess
    }

    /// Resolve Launch Services metadata on the main run loop. A just-launched
    /// app may have a bundle URL before NSRunningApplication fills its id.
    @MainActor
    static func identity(pid: Int32) -> RunningApp? {
        guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid })
            ?? NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
        let bundle = app.bundleURL.flatMap { Bundle(url: $0) }
        guard let id = app.bundleIdentifier ?? bundle?.bundleIdentifier, !id.isEmpty else { return nil }
        return RunningApp(
            pid: pid, bundleID: id, name: app.localizedName ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String ?? id,
            isActive: app.isActive, appStoreCategory: AppCategoryCache.category(of: app.bundleURL)
        )
    }

    public func runningApps() async -> [RunningApp] {
        let apps = await MainActor.run {
            NSWorkspace.shared.runningApplications.compactMap { app -> (Int32, String, String, Bool, URL?)? in
                guard app.activationPolicy != .prohibited, let id = app.bundleIdentifier else { return nil }
                return (app.processIdentifier, id, app.localizedName ?? id, app.isActive, app.bundleURL)
            }
        }
        return apps.map { pid, id, name, active, url in
            RunningApp(pid: pid, bundleID: id, name: name, isActive: active, appStoreCategory: AppCategoryCache.category(of: url))
        }
    }

    public func frontmostApp() async -> RunningApp? {
        let front = await MainActor.run { () -> (Int32, String, String, URL?)? in
            guard let app = NSWorkspace.shared.frontmostApplication, let id = app.bundleIdentifier else { return nil }
            return (app.processIdentifier, id, app.localizedName ?? id, app.bundleURL)
        }
        guard let front else { return nil }
        return RunningApp(pid: front.0, bundleID: front.1, name: front.2, isActive: true, appStoreCategory: AppCategoryCache.category(of: front.3))
    }

    public func installedApps() async -> [InstalledApp] {
        InstalledAppsCache.shared.apps()
    }

    public func windows(pid: Int32) async -> [WindowInfo] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
        else { return [] }
        guard let running = await Self.identity(pid: pid) else { return [] }
        let bundleID = running.bundleID
        let appName = running.name
        return list.compactMap { info -> WindowInfo? in
            guard (info[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let number = info[kCGWindowNumber as String] as? UInt32,
                  let boundsInfo = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsInfo),
                  bounds.width > 40, bounds.height > 40
            else { return nil }
            var display: CGDirectDisplayID = 0
            var count: UInt32 = 0
            CGGetDisplaysWithPoint(CGPoint(x: bounds.midX, y: bounds.midY), 1, &display, &count)
            return WindowInfo(
                windowID: number,
                pid: pid,
                bundleID: bundleID,
                appName: appName,
                title: info[kCGWindowName as String] as? String,
                frame: ScreenRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height),
                displayID: count > 0 ? display : CGMainDisplayID()
            )
        }
    }

    public func displays() async -> [DisplayInfo] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
        let names = await MainActor.run { () -> [CGDirectDisplayID: String] in
            var names: [CGDirectDisplayID: String] = [:]
            for screen in NSScreen.screens {
                if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                    names[CGDirectDisplayID(number.uint32Value)] = screen.localizedName
                }
            }
            return names
        }
        return ids.prefix(Int(count)).map { id in
            let bounds = CGDisplayBounds(id)
            var scale = 1.0
            if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
                scale = Double(mode.pixelWidth) / Double(mode.width)
            }
            return DisplayInfo(
                id: id,
                name: names[id] ?? "Display \(id)",
                frame: ScreenRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height),
                backingScale: scale,
                isMain: CGDisplayIsMain(id) != 0
            )
        }
    }

    public func activate(pid: Int32) async -> Bool {
        await MainActor.run {
            NSRunningApplication(processIdentifier: pid)?.activate() ?? false
        }
    }

    public func open(bundleID: String) async throws -> RunningApp {
        let running = await runningApps().first(where: { $0.bundleID.lowercased() == bundleID.lowercased() })
        // Running with a window: nothing to do. Running with none (Safari
        // after its last window closed): opening it again sends the reopen
        // event, which gives it a window, still without taking focus.
        if let running, await !windows(pid: running.pid).isEmpty {
            return running
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            if let running { return running }
            throw ScreenControlError.invalidInput("\(bundleID) is not installed.")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        // Background mode: the reader's focus stays where it is.
        configuration.activates = false
        configuration.addsToRecentItems = false
        let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        let id = app.bundleIdentifier ?? bundleID
        return RunningApp(pid: app.processIdentifier, bundleID: id, name: app.localizedName ?? id)
    }
}

/// `LSApplicationCategoryType` by bundle URL, read once per app.
enum AppCategoryCache {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [URL: String?] = [:]

    static func category(of url: URL?) -> String? {
        guard let url else { return nil }
        lock.lock()
        if let cached = cache[url] {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let value = Bundle(url: url)?.infoDictionary?["LSApplicationCategoryType"] as? String
        lock.lock()
        cache[url] = value
        lock.unlock()
        return value
    }
}

/// The apps in the usual folders, re-read at most once a minute.
final class InstalledAppsCache: @unchecked Sendable {
    static let shared = InstalledAppsCache()
    private let lock = NSLock()
    private var cached: [InstalledApp] = []
    private var readAt = Date.distantPast

    func apps() -> [InstalledApp] {
        lock.lock()
        defer { lock.unlock() }
        if Date().timeIntervalSince(readAt) < 60, !cached.isEmpty { return cached }
        var folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
        folders.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path)
        var apps: [InstalledApp] = []
        var seen = Set<String>()
        for folder in folders {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
            for name in names where name.hasSuffix(".app") {
                let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, seen.insert(id.lowercased()).inserted else {
                    continue
                }
                let display = (bundle.infoDictionary?["CFBundleDisplayName"] as? String)
                    ?? (bundle.infoDictionary?["CFBundleName"] as? String)
                    ?? String(name.dropLast(4))
                apps.append(InstalledApp(
                    bundleID: id,
                    name: display,
                    appStoreCategory: bundle.infoDictionary?["LSApplicationCategoryType"] as? String
                ))
            }
        }
        cached = apps.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        readAt = Date()
        return cached
    }
}

// MARK: - Capture

public struct SystemScreenCapture: ScreenCapturing {
    private struct Content: @unchecked Sendable { let value: SCShareableContent }
    private let windows = CaptureContentCache<Content> {
        Content(value: try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false))
    }
    public init() {}

    public func capture(window: WindowInfo) async throws -> CapturedImage {
        var content = try await windows.value().value
        let currentBounds = CGRect(x: window.frame.x, y: window.frame.y, width: window.frame.width, height: window.frame.height)
        let candidate = content.windows.first { $0.windowID == window.windowID && $0.owningApplication?.processID == window.pid }
        // Moving across displays can change the backing scale. Refresh the
        // handle when live bounds change instead of reusing old geometry.
        if candidate?.frame != currentBounds {
            await windows.invalidate()
            content = try await windows.value().value
        }
        guard let scWindow = content.windows.first(where: { $0.windowID == window.windowID && $0.owningApplication?.processID == window.pid }) else {
            throw ScreenControlError.windowGone(app: window.appName)
        }
        let filter = SCContentFilter(desktopIndependentWindow: scWindow)
        let scale = Double(filter.pointPixelScale)
        let configuration = SCStreamConfiguration()
        // Geometry is read live by ScreenEnvironment, including moves and
        // resizes since discovery. Only the window handle is reused.
        configuration.width = max(1, Int((window.frame.width * scale).rounded()))
        configuration.height = max(1, Int((window.frame.height * scale).rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.capturesAudio = false
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            await windows.invalidate()
            throw error
        }
        return CapturedImage(
            image: image,
            origin: ScreenPoint(x: window.frame.minX, y: window.frame.minY),
            pointWidth: window.frame.width,
            pointHeight: window.frame.height,
            backingScale: scale,
            displayID: window.displayID,
            windowTitle: window.title
        )
    }

    public func capture(display: DisplayInfo, excluding own: OwnProcess) async throws -> CapturedImage {
        try await capture(display: display, excluding: own, alsoExcluding: [])
    }

    public func capture(display: DisplayInfo, excluding own: OwnProcess, alsoExcluding bundleIDs: Set<String>) async throws -> CapturedImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let scDisplay = content.displays.first(where: { $0.displayID == display.id }) else {
            throw ScreenControlError.driverFailed("That display is no longer connected.")
        }
        // Juno's own apps, every one: never `excludingWindows: []` (CU-01).
        // And every refused app, whatever the caller passed: a password
        // manager or a security prompt is never in a frame.
        let hidden = content.applications.filter {
            own.owns(pid: $0.processID, bundleID: $0.bundleIdentifier)
                || bundleIDs.contains($0.bundleIdentifier.lowercased())
                || AppCategories.category(bundleID: $0.bundleIdentifier) == .refused
        }
        let filter = SCContentFilter(display: scDisplay, excludingApplications: hidden, exceptingWindows: [])
        return try await shoot(display: display, filter: filter)
    }

    public func capture(display: DisplayInfo, excluding own: OwnProcess, showingOnly bundleIDs: Set<String>) async throws -> CapturedImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let scDisplay = content.displays.first(where: { $0.displayID == display.id }) else {
            throw ScreenControlError.driverFailed("That display is no longer connected.")
        }
        // The include list: only granted apps' windows are composited. Juno
        // and refused apps are dropped even if a grant somehow named them.
        let shown = content.applications.filter {
            bundleIDs.contains($0.bundleIdentifier.lowercased())
                && !own.owns(pid: $0.processID, bundleID: $0.bundleIdentifier)
                && AppCategories.category(bundleID: $0.bundleIdentifier) != .refused
        }
        let filter = SCContentFilter(display: scDisplay, including: shown, exceptingWindows: [])
        return try await shoot(display: display, filter: filter)
    }

    private func shoot(display: DisplayInfo, filter: SCContentFilter) async throws -> CapturedImage {
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((display.frame.width * display.backingScale).rounded()))
        configuration.height = max(1, Int((display.frame.height * display.backingScale).rounded()))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        return CapturedImage(
            image: image,
            origin: ScreenPoint(x: display.frame.minX, y: display.frame.minY),
            pointWidth: display.frame.width,
            pointHeight: display.frame.height,
            backingScale: display.backingScale,
            displayID: display.id,
            windowTitle: nil
        )
    }
}

// MARK: - Accessibility

/// A failed cross-process write can have taken effect. Only an explicitly
/// unsupported operation is safe to replace with another input mechanism.
enum AXWriteResult {
    static func accepted(_ status: AXError) throws -> Bool {
        switch status {
        case .success: return true
        case .actionUnsupported, .attributeUnsupported, .notImplemented: return false
        default:
            throw ScreenControlError.driverFailed(
                "The app did not confirm the Accessibility input (error \(status.rawValue)). Its result is unknown; inspect a fresh screenshot before trying another action. The input was not repeated."
            )
        }
    }
}

public final class SystemAccessibility: AccessibilityInspecting, @unchecked Sendable {
    private struct Node: Hashable {
        let element: AXUIElement
        static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
        func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
    }
    private let lock = NSLock()
    /// The elements behind the ids of each app's last snapshot.
    private var references: [Int32: [String: AXUIElement]] = [:]

    public init() {}

    /// One cross-process request for metadata, rather than one per field.
    /// Values are read separately, after the secure-role check.
    private func snapshotNode(_ element: AXUIElement, id: String, depth: Int, includeChildren: Bool) throws -> (AXElementInfo, [Node]) {
        AXUIElementSetMessagingTimeout(element, 0.15)
        var names = [
            kAXRoleAttribute, kAXSubroleAttribute, kAXRoleDescriptionAttribute,
            kAXTitleAttribute, kAXDescriptionAttribute, kAXPositionAttribute,
            kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
        ]
        if includeChildren { names.append(kAXChildrenAttribute) }
        var result: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &result) == .success,
              let values = result as? [AnyObject], values.count == names.count
        else { throw ScreenControlError.driverFailed("The app did not respond to an Accessibility read. Try a screenshot or a shallower control search.") }
        let fields = Dictionary(uniqueKeysWithValues: zip(names, values))
        let role = fields[kAXRoleAttribute] as? String ?? "AXUnknown"
        let subrole = fields[kAXSubroleAttribute] as? String
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        var value: String?
        if !secure, let raw = attribute(element, kAXValueAttribute) {
            value = (raw as? String) ?? (raw as? NSNumber)?.stringValue
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        if let position = fields[kAXPositionAttribute], let extent = fields[kAXSizeAttribute],
           CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(extent) == AXValueGetTypeID() {
            // swiftlint:disable:next force_cast
            AXValueGetValue(position as! AXValue, .cgPoint, &point)
            // swiftlint:disable:next force_cast
            AXValueGetValue(extent as! AXValue, .cgSize, &size)
        }
        let info = AXElementInfo(
            id: id, role: role, subrole: subrole,
            roleDescription: fields[kAXRoleDescriptionAttribute] as? String,
            title: fields[kAXTitleAttribute] as? String,
            label: fields[kAXDescriptionAttribute] as? String,
            value: value,
            frame: ScreenRect(x: point.x, y: point.y, width: size.width, height: size.height),
            enabled: (fields[kAXEnabledAttribute] as? NSNumber)?.boolValue ?? true,
            focused: (fields[kAXFocusedAttribute] as? NSNumber)?.boolValue ?? false,
            depth: depth, pressable: actions(element).contains(kAXPressAction)
        )
        let children = (fields[kAXChildrenAttribute] as? [AnyObject] ?? []).compactMap { child -> Node? in
            guard CFGetTypeID(child) == AXUIElementGetTypeID() else { return nil }
            // swiftlint:disable:next force_cast
            return Node(element: child as! AXUIElement)
        }
        return (info, children)
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }

    private func bool(_ element: AXUIElement, _ name: String) -> Bool? {
        (attribute(element, name) as? NSNumber)?.boolValue
    }

    private func frame(_ element: AXUIElement) -> ScreenRect? {
        var point = CGPoint.zero
        var size = CGSize.zero
        guard let positionValue = attribute(element, kAXPositionAttribute),
              let sizeValue = attribute(element, kAXSizeAttribute),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }
        // swiftlint:disable:next force_cast
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
        // swiftlint:disable:next force_cast
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        return ScreenRect(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names = names as? [String] else { return [] }
        return names
    }

    private func target(of element: AXUIElement) async -> ScreenTarget? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        guard let app = await SystemScreenEnvironment.identity(pid: pid) else { return nil }
        let bundleID = app.bundleID
        guard let (info, _) = try? snapshotNode(element, id: "h", depth: 0, includeChildren: false) else { return nil }
        var defaultButton: String?
        let appElement = AXUIElementCreateApplication(pid)
        if let window = attribute(appElement, kAXFocusedWindowAttribute),
           CFGetTypeID(window) == AXUIElementGetTypeID()
        {
            // swiftlint:disable:next force_cast
            let windowElement = window as! AXUIElement
            if let button = attribute(windowElement, kAXDefaultButtonAttribute),
               CFGetTypeID(button) == AXUIElementGetTypeID()
            {
                // swiftlint:disable:next force_cast
                defaultButton = string(button as! AXUIElement, kAXTitleAttribute)
            }
        }
        return ScreenTarget(
            pid: pid,
            bundleID: bundleID,
            appName: app.name,
            appStoreCategory: app.appStoreCategory,
            element: info,
            defaultButtonTitle: defaultButton,
            actionTexts: pressedTexts(from: element, info: info)
        )
    }

    /// The words of what `AXPress` here would press: the nearest ancestor
    /// that takes it (as `perform` walks), and the hit element's own text
    /// when it is that control's label. The floor reads these too, because
    /// the label of a "Send" button is often a child static text with no
    /// title of its own.
    private func pressedTexts(from element: AXUIElement, info: AXElementInfo) -> [String] {
        var texts: [String] = []
        let role = info.role
        guard let pressable = info.pressable ? element : performable(element, action: kAXPressAction) else { return texts }
        if !CFEqual(pressable, element) {
            texts += [string(pressable, kAXTitleAttribute), string(pressable, kAXDescriptionAttribute)].compactMap { $0 }
            if let value = attribute(pressable, kAXValueAttribute) as? String { texts.append(value) }
        }
        if role == "AXStaticText" || role == "AXButton" || role == "AXLink" || role == "AXMenuItem",
           let value = attribute(element, kAXValueAttribute) as? String
        {
            texts.append(value)
        }
        return texts.filter { !$0.isEmpty }.map { String($0.prefix(200)) }
    }

    private func element(at point: ScreenPoint, within pid: Int32?) -> AXUIElement? {
        let root = pid.map { AXUIElementCreateApplication($0) } ?? AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(root, 1)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &element) == .success else {
            return nil
        }
        return element
    }

    public func target(at point: ScreenPoint, within pid: Int32?) async -> ScreenTarget? {
        guard let element = element(at: point, within: pid) else { return nil }
        return await target(of: element)
    }

    private func focused(pid: Int32) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        guard let focused = attribute(app, kAXFocusedUIElementAttribute),
              CFGetTypeID(focused) == AXUIElementGetTypeID()
        else { return nil }
        // swiftlint:disable:next force_cast
        return (focused as! AXUIElement)
    }

    public func focusedTarget(pid: Int32) async -> ScreenTarget? {
        guard let element = focused(pid: pid) else { return nil }
        return await target(of: element)
    }

    public func snapshot(pid: Int32, maxDepth: Int) async throws -> AXSnapshot {
        try Task.checkCancellation()
        // Never keep old ids usable after a failed or cancelled refresh.
        lock.withLock { references[pid] = nil }
        guard let running = await SystemScreenEnvironment.identity(pid: pid) else {
            lock.withLock { references[pid] = nil }
            throw ScreenControlError.driverFailed("macOS has not confirmed the app's identity. Take a fresh screenshot before reading its controls again.")
        }
        try Task.checkCancellation()
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.15)
        var windowValue = attribute(app, kAXFocusedWindowAttribute) ?? attribute(app, kAXMainWindowAttribute)
        if windowValue == nil, let windows = attribute(app, kAXWindowsAttribute) as? [AnyObject] {
            windowValue = windows.first
        }
        guard let windowValue, CFGetTypeID(windowValue) == AXUIElementGetTypeID() else {
            throw ScreenControlError.unsupported("The app exposes no window to Accessibility.")
        }
        // swiftlint:disable:next force_cast
        let window = windowValue as! AXUIElement
        var elements: [AXElementInfo] = []
        var refs: [String: AXUIElement] = [:]
        let completion = try BoundedAXTraversal<Node>().walk(root: Node(element: window), maxDepth: maxDepth) { node, depth in
            let id = "e\(elements.count + 1)"
            let (info, children) = try snapshotNode(node.element, id: id, depth: depth, includeChildren: depth < maxDepth)
            elements.append(info)
            refs[id] = node.element
            return children
        }
        try Task.checkCancellation()
        lock.withLock { references[pid] = refs }
        return AXSnapshot(
            bundleID: running.bundleID,
            appName: running.name,
            windowTitle: string(window, kAXTitleAttribute),
            elements: elements,
            truncationReason: completion == .timeLimit ? "the app exceeded the three-second read budget"
                : completion == .nodeLimit ? "the app exceeded the 1,500-element limit" : nil
        )
    }

    private func reference(_ id: String?, pid: Int32) -> AXUIElement? {
        guard let id else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return references[pid]?[id]
    }

    /// The element itself or the nearest ancestor that takes `action`: a
    /// click on a button's label presses the button.
    private func performable(_ element: AXUIElement, action: String) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0..<4 {
            guard let candidate = current else { return nil }
            if actions(candidate).contains(action) { return candidate }
            guard let parent = attribute(candidate, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else {
                return nil
            }
            // swiftlint:disable:next force_cast
            current = (parent as! AXUIElement)
        }
        return nil
    }

    private func perform(_ action: String, at point: ScreenPoint?, elementID: String?, pid: Int32) throws -> Bool {
        let base: AXUIElement?
        if let elementID {
            guard let known = reference(elementID, pid: pid) else { throw ScreenControlError.unknownElement(elementID) }
            base = known
        } else {
            base = point.flatMap { element(at: $0, within: pid) }
        }
        guard let base, let element = performable(base, action: action) else { return false }
        return try AXWriteResult.accepted(AXUIElementPerformAction(element, action as CFString))
    }

    public func press(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool {
        try perform(kAXPressAction, at: point, elementID: elementID, pid: pid)
    }

    public func showMenu(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool {
        try perform(kAXShowMenuAction, at: point, elementID: elementID, pid: pid)
    }

    public func setText(_ text: String, elementID: String?, pid: Int32, replace: Bool) async throws -> Bool {
        let target = elementID.flatMap { reference($0, pid: pid) }
        if let elementID, target == nil { throw ScreenControlError.unknownElement(elementID) }
        guard let element = target ?? focused(pid: pid) else { return false }
        let role = string(element, kAXRoleAttribute)
        let subrole = string(element, kAXSubroleAttribute)
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { throw ScreenControlError.secureField }
        // Insert goes through the selection, so it lands at the caret; only
        // replace may set the whole value — the overwrite guard (§3.6).
        let name = replace ? kAXValueAttribute : kAXSelectedTextAttribute
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue else {
            return false
        }
        return try AXWriteResult.accepted(AXUIElementSetAttributeValue(element, name as CFString, text as CFString))
    }

    public func value(elementID: String?, pid: Int32) async -> String? {
        guard let element = reference(elementID, pid: pid) ?? focused(pid: pid) else { return nil }
        let role = string(element, kAXRoleAttribute)
        let subrole = string(element, kAXSubroleAttribute)
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { return nil }
        return string(element, kAXValueAttribute)
    }

    public func pressMenu(pid: Int32, path: [String]) async throws -> [String] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
        guard let bar = attribute(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
            throw ScreenControlError.unsupported("The app has no menu bar \(ScreenControlBrand.productName) can read.")
        }
        // swiftlint:disable:next force_cast
        var container = bar as! AXUIElement
        var pressed: [String] = []
        for (index, title) in path.enumerated() {
            let items = menuItems(of: container)
            guard let match = items.first(where: { Self.sameTitle(string($0, kAXTitleAttribute), title) }) else {
                let available = items.compactMap { string($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
                throw ScreenControlError.invalidInput(
                    "No menu item “\(title)” after \(pressed.isEmpty ? "the menu bar" : pressed.joined(separator: " › ")). "
                        + "Available: \(available.prefix(30).joined(separator: ", "))."
                )
            }
            pressed.append(string(match, kAXTitleAttribute) ?? title)
            if index == path.count - 1 {
                guard bool(match, kAXEnabledAttribute) != false else {
                    throw ScreenControlError.invalidInput("“\(title)” is disabled right now.")
                }
                guard AXUIElementPerformAction(match, kAXPressAction as CFString) == .success else {
                    throw ScreenControlError.driverFailed("The menu item would not press.")
                }
            } else {
                container = match
            }
        }
        return pressed
    }

    private func menuItems(of element: AXUIElement) -> [AXUIElement] {
        guard let children = attribute(element, kAXChildrenAttribute) as? [AnyObject] else { return [] }
        var items: [AXUIElement] = []
        for child in children where CFGetTypeID(child) == AXUIElementGetTypeID() {
            // swiftlint:disable:next force_cast
            let childElement = child as! AXUIElement
            if string(childElement, kAXRoleAttribute) == "AXMenu" {
                items += menuItems(of: childElement)
            } else {
                items.append(childElement)
            }
        }
        return items
    }

    static func sameTitle(_ a: String?, _ b: String) -> Bool {
        guard let a else { return false }
        func normal(_ text: String) -> String {
            text.replacingOccurrences(of: "…", with: "...")
                .trimmingCharacters(in: .whitespaces)
                .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        }
        return normal(a) == normal(b)
    }
}

// MARK: - Input

/// Turns planned events into `CGEvent`s and posts them, each marked as
/// Juno's so the Esc tap lets them through.
public struct SystemEventSink: EventSink {
    public init() {}

    public func post(_ events: [SyntheticEvent], to target: EventTarget) async throws {
        // A private source: the flags on an event are exactly the ones Juno
        // set, never a modifier the reader happens to be holding.
        guard let source = CGEventSource(stateID: .privateState) else {
            throw ScreenControlError.driverFailed("macOS would not create an input source.")
        }
        source.userData = EmergencyStopTapLogic.syntheticMarker
        for event in events {
            guard let cgEvent = Self.make(event, source: source) else {
                throw ScreenControlError.driverFailed("macOS would not create the input event.")
            }
            cgEvent.setIntegerValueField(.eventSourceUserData, value: EmergencyStopTapLogic.syntheticMarker)
            switch target {
            case let .process(pid): cgEvent.postToPid(pid)
            case .global: cgEvent.post(tap: .cghidEventTap)
            }
        }
    }

    static func flags(_ modifiers: KeyModifiers) -> CGEventFlags {
        var flags: CGEventFlags = []
        if modifiers.contains(.shift) { flags.insert(.maskShift) }
        if modifiers.contains(.control) { flags.insert(.maskControl) }
        if modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if modifiers.contains(.command) { flags.insert(.maskCommand) }
        if modifiers.contains(.function) { flags.insert(.maskSecondaryFn) }
        return flags
    }

    static func make(_ event: SyntheticEvent, source: CGEventSource) -> CGEvent? {
        func point(_ p: ScreenPoint) -> CGPoint { CGPoint(x: p.x, y: p.y) }
        func cgButton(_ button: MouseButton) -> CGMouseButton {
            switch button {
            case .left: .left
            case .right: .right
            case .middle: .center
            }
        }
        switch event {
        case let .mouseMove(p):
            return CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point(p), mouseButton: .left)
        case let .mouseDown(button, p, count, modifiers), let .mouseUp(button, p, count, modifiers):
            let isDown: Bool = if case .mouseDown = event { true } else { false }
            let type: CGEventType = switch (button, isDown) {
            case (.left, true): .leftMouseDown
            case (.left, false): .leftMouseUp
            case (.right, true): .rightMouseDown
            case (.right, false): .rightMouseUp
            case (.middle, true): .otherMouseDown
            case (.middle, false): .otherMouseUp
            }
            let made = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point(p), mouseButton: cgButton(button))
            made?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            made?.flags = flags(modifiers)
            return made
        case let .mouseDrag(button, p):
            let type: CGEventType = button == .right ? .rightMouseDragged : (button == .middle ? .otherMouseDragged : .leftMouseDragged)
            return CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point(p), mouseButton: cgButton(button))
        case let .keyDown(code, modifiers, text), let .keyUp(code, modifiers, text):
            let isDown: Bool = if case .keyDown = event { true } else { false }
            let made = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: isDown)
            if !text.isEmpty {
                text.withUnsafeBufferPointer { buffer in
                    if let base = buffer.baseAddress {
                        made?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                    }
                }
            }
            made?.flags = flags(modifiers)
            return made
        case let .scroll(dx, dy, p, modifiers):
            let made = CGEvent(
                scrollWheelEvent2Source: source,
                units: .line,
                wheelCount: 2,
                wheel1: dy,
                wheel2: dx,
                wheel3: 0
            )
            made?.location = point(p)
            made?.flags = flags(modifiers)
            return made
        }
    }
}

#endif
