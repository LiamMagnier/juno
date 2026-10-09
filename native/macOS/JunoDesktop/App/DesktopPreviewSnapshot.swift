#if DEBUG
import AppKit
import Foundation
import ObjectiveC

/// The capture harness's own camera: the app draws its window — frame,
/// toolbar, sidebar and all — into a PNG and quits.
///
/// `--juno-ui-preview --juno-preview-snapshot <path.png>` renders the main
/// window after `--juno-preview-snapshot-delay <seconds>` (default 6) with
/// AppKit's own `cacheDisplay(in:to:)` on the window's frame view, so what is
/// written is this process's window and nothing else on the screen — no screen
/// recording, no other app, no desktop behind it. `--juno-preview-snapshot-window
/// <words>` picks another of the app's windows by title (Settings, a report).
///
/// DEBUG-only: the type does not exist in Stable or Next.
@MainActor
enum DesktopPreviewSnapshot {
    private static func value(_ flag: String) -> String? {
        let arguments = CommandLine.arguments
        guard arguments.contains("--juno-ui-preview"),
              let index = arguments.firstIndex(of: flag), index + 1 < arguments.count
        else { return nil }
        return arguments[index + 1]
    }

    private static var requestedSize: NSSize? {
        guard let raw = value("--juno-preview-size") else { return nil }
        let parts = raw.split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2 else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }

    /// Schedules the capture if the launch asked for one.
    static func scheduleIfRequested() {
        guard let path = value("--juno-preview-snapshot") else { return }
        let delay = value("--juno-preview-snapshot-delay").flatMap(Double.init) ?? 6
        let title = value("--juno-preview-snapshot-window")
        // In front, so the window is drawn as the key window a reader sees.
        for beat in [1.0, 2.5, delay - 1] {
            DispatchQueue.main.asyncAfter(deadline: .now() + beat) {
                // Never brought forward: the harness must not take the
                // keyboard from whoever is at the Mac. It is drawn as the key
                // window instead (``DesktopPreviewKeyAppearance``).
                DesktopPreviewKeyAppearance.install()
                guard let window = window(titled: title) else { return }
                window.orderFront(nil)
                NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
                NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
                window.contentView?.superview?.needsDisplay = true
                // One size for every picture, whatever the window last was.
                if title == nil, let size = requestedSize, window.frame.size != size {
                    window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                }
            }
        }
        // `--juno-preview-press <accessibility identifier>`: presses one of the
        // window's own controls through its accessibility element — the "+"
        // menu, a popover's button — so a menu or popover is in the picture.
        if let press = value("--juno-preview-press") {
            DispatchQueue.main.asyncAfter(deadline: .now() + max(1.5, delay - 2.5)) {
                var note = "press \(press): "
                if let window = window(titled: title), let element = find(press, in: window) as? NSObject {
                    note += "found \(type(of: element)) "
                    if element.responds(to: #selector(NSAccessibilityProtocol.accessibilityPerformPress)) {
                        note += "pressed=\((element as AnyObject).accessibilityPerformPress?() ?? false)"
                    }
                } else {
                    note += "not found"
                }
                try? note.write(toFile: path + ".press.txt", atomically: true, encoding: .utf8)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            capture(to: path, title: title)
            NSApp.terminate(nil)
        }
    }

    private static func window(titled title: String?) -> NSWindow? {
        let candidates = NSApp.windows.filter { $0.isVisible && $0.frame.width > 400 && $0.contentView != nil }
        if let title {
            return candidates.first { $0.title.localizedCaseInsensitiveContains(title) }
        }
        return candidates.first { $0.identifier?.rawValue.hasPrefix(JunoDesktopWindow.mainID) == true }
            ?? candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    static func capture(to path: String, title: String?) {
        guard let window = window(titled: title),
              let frameView = window.contentView?.superview
        else {
            let titles = NSApp.windows.map { "\($0.title) \($0.frame) visible=\($0.isVisible)" }.joined(separator: "\n")
            try? titles.write(toFile: path + ".windows.txt", atomically: true, encoding: .utf8)
            return
        }
        // The window server's own composite of this window — glass, the
        // sidebar's material and all — which an app may always take of its own
        // windows. AppKit's `cacheDisplay` is the fallback; it cannot draw
        // what the window server composites (Liquid Glass, the sidebar pane).
        if let image = windowServerImage(of: window) {
            let rep = NSBitmapImageRep(cgImage: image)
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: path))
                return
            }
        }
        let bounds = frameView.bounds
        guard let rep = frameView.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        frameView.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: URL(fileURLWithPath: path))
    }

    /// The first accessibility element under `window` with `identifier`.
    private static func find(_ identifier: String, in window: NSWindow) -> NSAccessibilityElementProtocol? {
        var queue: [Any] = window.accessibilityChildren() ?? []
        var visited = 0
        while !queue.isEmpty, visited < 20_000 {
            let next = queue.removeFirst()
            visited += 1
            guard let element = next as? NSAccessibilityElementProtocol else { continue }
            if let object = element as? NSObject,
               object.responds(to: #selector(NSAccessibilityProtocol.accessibilityIdentifier)),
               (object as AnyObject).accessibilityIdentifier?() == identifier
            {
                return element
            }
            if let object = element as? NSObject,
               object.responds(to: #selector(NSAccessibilityProtocol.accessibilityChildren)),
               let children = (object as AnyObject).accessibilityChildren?()
            {
                queue.append(contentsOf: children)
            }
        }
        return nil
    }

    private typealias WindowImageFunction = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// `CGWindowListCreateImage` for this one window, looked up at run time
    /// because the SDK no longer declares it.
    private static func windowServerImage(of window: NSWindow) -> CGImage? {
        guard let handle = dlopen(nil, RTLD_NOW) else { return nil }
        // This process's own windows above the main one — an open menu, a
        // popover — composited over it, inside the main window's bounds.
        // Popovers and sheets are windows of their own; the menus a
        // pressed control opens are too, but not in `NSApp.windows`.
        let pid = ProcessInfo.processInfo.processIdentifier
        let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        let menus = info.compactMap { entry -> CGWindowID? in
            guard (entry[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (entry[kCGWindowLayer as String] as? Int ?? 0) > 0,
                  (entry[kCGWindowLayer as String] as? Int ?? 0) < 25
            else { return nil }
            return (entry[kCGWindowNumber as String] as? NSNumber).map { CGWindowID($0.uint32Value) }
        }
        let children = NSApp.windows.filter {
            $0 !== window && $0.isVisible && $0.frame.intersects(window.frame) && $0.level.rawValue < 25
        }.map { CGWindowID($0.windowNumber) }
        let above = children + menus
        if !above.isEmpty, let symbol = dlsym(handle, "CGWindowListCreateImageFromArray"),
           let screen = NSScreen.screens.first
        {
            typealias FromArray = @convention(c) (CGRect, CFArray, UInt32) -> Unmanaged<CGImage>?
            let function = unsafeBitCast(symbol, to: FromArray.self)
            let frame = window.frame
            let rect = CGRect(x: frame.minX, y: screen.frame.height - frame.maxY, width: frame.width, height: frame.height)
            // Front to back, as the window list orders them: what floats
            // over the window first, the window last.
            let ids = (above + [CGWindowID(window.windowNumber)]).map { NSNumber(value: $0) } as CFArray
            if let image = function(rect, ids, (1 << 3))?.takeRetainedValue() { return image }
        }
        guard let symbol = dlsym(handle, "CGWindowListCreateImage") else { return nil }
        let function = unsafeBitCast(symbol, to: WindowImageFunction.self)
        // .null rect = the window's own bounds; option 1<<3 = including
        // window; image options: bestResolution (1<<3) | boundsIgnoreFraming (1<<0).
        return function(.null, 1 << 3, UInt32(window.windowNumber), (1 << 3) | (1 << 0))?.takeRetainedValue()
    }
}
#endif

#if DEBUG
/// Draws the harness's windows as the key window of the active app without
/// ever activating it — so a picture shows the window a reader sees (lit
/// traffic lights, an accent selection) while the person at the Mac keeps
/// their keyboard. Swaps three getters for ones that answer yes; installed
/// only by a `--juno-preview-snapshot` launch of a DEBUG build.
@MainActor
enum DesktopPreviewKeyAppearance {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        swap(NSWindow.self, #selector(getter: NSWindow.isKeyWindow), #selector(getter: NSWindow.previewAlwaysYes))
        swap(NSWindow.self, #selector(getter: NSWindow.isMainWindow), #selector(getter: NSWindow.previewAlwaysYes))
        swap(NSApplication.self, #selector(getter: NSApplication.isActive), #selector(getter: NSApplication.previewAlwaysYes))
        // AppKit's own frame (traffic lights, title, glass) asks these.
        for name in ["_hasKeyAppearance", "_hasMainAppearance", "_hasActiveAppearance", "_hasActiveAppearanceIgnoringKeyFocus", "hasKeyAppearance", "hasMainAppearance"] {
            let selector = NSSelectorFromString(name)
            if class_getInstanceMethod(NSWindow.self, selector) != nil {
                swap(NSWindow.self, selector, #selector(getter: NSWindow.previewAlwaysYes))
            }
        }
    }

    /// Points `original` at an implementation that answers yes.
    private static func swap(_ type: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let method = class_getInstanceMethod(type, original) else { return }
        let yes: @convention(block) (AnyObject) -> Bool = { _ in true }
        method_setImplementation(method, imp_implementationWithBlock(yes))
    }
}

extension NSWindow {
    @objc var previewAlwaysYes: Bool { true }
}

extension NSApplication {
    @objc var previewAlwaysYes: Bool { true }
}
#endif
