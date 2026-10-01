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
    public static let shared = ScreenControlService(dependencies: .system)
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
            }
        )
    }
}

// MARK: - Apps, windows, displays

public struct SystemScreenEnvironment: ScreenEnvironment {
    public let ownProcess: OwnProcess

    public init(ownProcess: OwnProcess = .current) {
        self.ownProcess = ownProcess
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
        let running = NSRunningApplication(processIdentifier: pid)
        let bundleID = running?.bundleIdentifier ?? ""
        let appName = running?.localizedName ?? bundleID
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
        if let app = await runningApps().first(where: { $0.bundleID.lowercased() == bundleID.lowercased() }) {
            return app
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
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
    public init() {}

    public func capture(window: WindowInfo) async throws -> CapturedImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let scWindow = content.windows.first(where: { $0.windowID == window.windowID }) else {
            throw ScreenControlError.windowGone(app: window.appName)
        }
        let filter = SCContentFilter(desktopIndependentWindow: scWindow)
        let scale = Double(filter.pointPixelScale)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((scWindow.frame.width * scale).rounded()))
        configuration.height = max(1, Int((scWindow.frame.height * scale).rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        return CapturedImage(
            image: image,
            origin: ScreenPoint(x: scWindow.frame.minX, y: scWindow.frame.minY),
            pointWidth: scWindow.frame.width,
            pointHeight: scWindow.frame.height,
            backingScale: scale,
            displayID: window.displayID,
            windowTitle: scWindow.title
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

public final class SystemAccessibility: AccessibilityInspecting, @unchecked Sendable {
    private let lock = NSLock()
    /// The elements behind the ids of each app's last snapshot.
    private var references: [Int32: [String: AXUIElement]] = [:]

    public init() {}

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

    private func info(_ element: AXUIElement, id: String, depth: Int) -> AXElementInfo {
        let role = string(element, kAXRoleAttribute) ?? "AXUnknown"
        let subrole = string(element, kAXSubroleAttribute)
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        var value: String?
        if !secure, let raw = attribute(element, kAXValueAttribute) {
            value = (raw as? String) ?? (raw as? NSNumber)?.stringValue
        }
        return AXElementInfo(
            id: id,
            role: role,
            subrole: subrole,
            roleDescription: string(element, kAXRoleDescriptionAttribute),
            title: string(element, kAXTitleAttribute),
            label: string(element, kAXDescriptionAttribute),
            value: value,
            frame: frame(element) ?? ScreenRect(x: 0, y: 0, width: 0, height: 0),
            enabled: bool(element, kAXEnabledAttribute) ?? true,
            focused: bool(element, kAXFocusedAttribute) ?? false,
            depth: depth,
            pressable: actions(element).contains(kAXPressAction)
        )
    }

    private func target(of element: AXUIElement) -> ScreenTarget? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        let bundleID = app?.bundleIdentifier ?? ""
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
            appName: app?.localizedName ?? bundleID,
            appStoreCategory: AppCategoryCache.category(of: app?.bundleURL),
            element: info(element, id: "h", depth: 0),
            defaultButtonTitle: defaultButton,
            actionTexts: pressedTexts(from: element)
        )
    }

    /// The words of what `AXPress` here would press: the nearest ancestor
    /// that takes it (as `perform` walks), and the hit element's own text
    /// when it is that control's label. The floor reads these too, because
    /// the label of a "Send" button is often a child static text with no
    /// title of its own.
    private func pressedTexts(from element: AXUIElement) -> [String] {
        var texts: [String] = []
        let role = string(element, kAXRoleAttribute)
        guard let pressable = performable(element, action: kAXPressAction) else { return texts }
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
        element(at: point, within: pid).flatMap(target(of:))
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
        focused(pid: pid).flatMap(target(of:))
    }

    public func snapshot(pid: Int32, maxDepth: Int) async throws -> AXSnapshot {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
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
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var counter = 0
        while !queue.isEmpty, counter < 1_500 {
            let (element, depth) = queue.removeFirst()
            counter += 1
            let id = "e\(counter)"
            elements.append(info(element, id: id, depth: depth))
            refs[id] = element
            guard depth < maxDepth, let children = attribute(element, kAXChildrenAttribute) as? [AnyObject] else { continue }
            for child in children where CFGetTypeID(child) == AXUIElementGetTypeID() {
                // swiftlint:disable:next force_cast
                queue.append((child as! AXUIElement, depth + 1))
            }
        }
        lock.withLock { references[pid] = refs }
        let running = NSRunningApplication(processIdentifier: pid)
        return AXSnapshot(
            bundleID: running?.bundleIdentifier ?? "",
            appName: running?.localizedName ?? "",
            windowTitle: string(window, kAXTitleAttribute),
            elements: elements
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

    private func perform(_ action: String, at point: ScreenPoint?, elementID: String?, pid: Int32) -> Bool {
        let base = reference(elementID, pid: pid) ?? point.flatMap { element(at: $0, within: pid) }
        guard let base, let element = performable(base, action: action) else { return false }
        return AXUIElementPerformAction(element, action as CFString) == .success
    }

    public func press(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool {
        perform(kAXPressAction, at: point, elementID: elementID, pid: pid)
    }

    public func showMenu(at point: ScreenPoint?, elementID: String?, pid: Int32) async throws -> Bool {
        perform(kAXShowMenuAction, at: point, elementID: elementID, pid: pid)
    }

    public func setText(_ text: String, elementID: String?, pid: Int32, replace: Bool) async throws -> Bool {
        guard let element = reference(elementID, pid: pid) ?? focused(pid: pid) else { return false }
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
        return AXUIElementSetAttributeValue(element, name as CFString, text as CFString) == .success
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
            throw ScreenControlError.unsupported("The app has no menu bar Juno can read.")
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
