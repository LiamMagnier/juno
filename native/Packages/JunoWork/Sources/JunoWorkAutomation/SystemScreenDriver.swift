import Foundation
import JunoWorkCore
import JunoWorkRuntime

#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Sees the screen with ScreenCaptureKit and touches it with `CGEvent`.
///
/// ### The two permissions, and why both are demanded up front
///
/// Screen Recording is what lets ScreenCaptureKit hand back anything but a
/// desktop picture; Accessibility is what lets a synthesised event reach another
/// application. macOS grants them separately and a person routinely grants one.
/// Every method here preflights the one it needs and *refuses by name* when it
/// is missing, because the alternative is the failure this tier is worst at
/// producing: `CGEvent.post` without Accessibility does not error — it returns
/// normally and nothing happens, so a run reports eight successful clicks that
/// never landed.
///
/// ### One display
///
/// Capture, ``displayBounds()`` and every click are the main display, and they
/// agree on purpose. ``VisualControl`` refuses a coordinate outside the bounds
/// this returns, so a capture wider than those bounds would offer the model
/// buttons it is then refused permission to press, and a capture narrower than
/// them would let it click at a point it has never seen. A second display is
/// therefore out of scope rather than half in it.
///
/// ### Points, not pixels
///
/// The capture is configured at the display's *point* size rather than its
/// backing pixel size. Redaction rectangles come from the accessibility tree in
/// screen points, and ``CoreGraphicsScreenRedactor`` paints them using the
/// image's own dimensions — so on a Retina Mac an image captured at pixel size
/// puts every black box at half the position and half the size of the field it
/// was meant to cover, which is a redaction that leaves the password visible
/// beside it.
public struct SystemScreenDriver: VisualScreenDriving {
    /// Depth and node ceilings for the tree walk that finds sensitive fields.
    /// The same ceilings ``SystemAccessibilityDriver`` uses, for the same
    /// reason: an unbounded accessibility tree turns a capture into a hang.
    public static let maximumDepth = 8
    public static let maximumNodes = 600

    /// The most UTF-16 units put into a single synthesised key event.
    ///
    /// `keyboardSetUnicodeString` is documented for short strings, and a long
    /// one is silently truncated by the receiving application rather than
    /// rejected. Chunking is what stops a hundred-character message arriving as
    /// its first twenty characters with nothing to say so.
    public static let keystrokeChunk = 16

    private let screenRecordingAuthorized: @Sendable () -> Bool
    private let accessibilityAuthorized: @Sendable () -> Bool
    private let frontmostApplication: @Sendable () -> (name: String, pid: pid_t)?

    /// - Parameters:
    ///   - screenRecordingAuthorized: TCC's answer for Screen Recording. Comes
    ///     from ``SystemScreenPreflight``, which is the same preflight the
    ///     settings card reads, so the switch a person sees and the refusal a
    ///     run produces cannot disagree.
    ///   - accessibilityAuthorized: TCC's answer for Accessibility, likewise.
    public init(
        screenRecordingAuthorized: @escaping @Sendable () -> Bool = SystemScreenPreflight
            .screenRecordingAuthorized,
        accessibilityAuthorized: @escaping @Sendable () -> Bool = SystemScreenPreflight
            .accessibilityAuthorized,
        frontmostApplication: @escaping @Sendable () -> (name: String, pid: pid_t)? = {
            guard let application = NSWorkspace.shared.frontmostApplication else { return nil }
            return (application.bundleIdentifier ?? "", application.processIdentifier)
        }
    ) {
        self.screenRecordingAuthorized = screenRecordingAuthorized
        self.accessibilityAuthorized = accessibilityAuthorized
        self.frontmostApplication = frontmostApplication
    }

    // MARK: VisualScreenDriving

    public func isAvailable() async -> Bool {
        screenRecordingAuthorized() && accessibilityAuthorized()
    }

    public func displayBounds() async throws -> AutomationRect {
        SystemScreenPreflight.mainDisplayBounds()
    }

    public func frontmostBundleIdentifier() async throws -> String? {
        guard let application = frontmostApplication(), !application.name.isEmpty else {
            return nil
        }
        return application.name
    }

    /// The fields on the front application that must be painted over before an
    /// image of the screen is kept.
    ///
    /// Read from the accessibility tree, which is the only source on macOS that
    /// says "this is a secure entry field" *and* where it is. Every descriptor
    /// carries its frame, because ``ScreenshotPolicy`` treats a sensitive
    /// surface with no rectangle as a reason to refuse the capture entirely — so
    /// a walk that found the password box but not its position would turn every
    /// login screen into a refused capture rather than a redacted one.
    public func sensitiveSurfaces() async throws -> [SensitiveSurface] {
        guard accessibilityAuthorized() else {
            // Refusing rather than returning an empty list. Empty means "nothing
            // sensitive is on screen", the capture proceeds, and the stored
            // image is the one with the password in it.
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno cannot tell what is on screen without macOS Accessibility permission, so it did not take a picture of it."
            )
        }
        guard let application = frontmostApplication() else { return [] }
        let element = AXUIElementCreateApplication(application.pid)
        var fields: [AccessibilityFieldDescriptor] = []
        var visited = 0
        Self.walk(element, path: [], depth: 0, visited: &visited, into: &fields)
        return SensitiveSurfaceDetector.classify(fields: fields)
    }

    public func capture() async throws -> Data {
        guard screenRecordingAuthorized() else {
            throw AutomationRefusal(
                .screenshotNotPermitted,
                "Juno does not have macOS Screen Recording permission, so it cannot see this Mac's screen. Grant it in System Settings → Privacy & Security → Screen Recording."
            )
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            // ScreenCaptureKit reports a revoked permission as a plain error
            // from this call rather than through the preflight, because TCC can
            // change between the two. Naming it as the permission problem it
            // almost always is beats reporting "the screen did not respond".
            throw AutomationRefusal(
                .screenshotNotPermitted,
                "macOS would not let Juno see this Mac's screen. Check System Settings → Privacy & Security → Screen Recording."
            )
        }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
        else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not find this Mac's main display."
            )
        }
        let configuration = SCStreamConfiguration()
        // Point size, not pixel size — see the note on this type.
        configuration.width = display.width
        configuration.height = display.height
        // The pointer is drawn by the window server at whatever position it
        // happens to be in, which is not information about the page and is one
        // more thing to have to redact.
        configuration.showsCursor = false
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(
                    display: display,
                    excludingApplications: [],
                    exceptingWindows: []
                ),
                configuration: configuration
            )
        } catch {
            throw AutomationRefusal(
                .driverUnavailable,
                "This Mac's screen did not give Juno a picture."
            )
        }
        return try Self.encode(image)
    }

    public func click(at point: AutomationPoint) async throws {
        try requireInputPermission()
        let position = CGPoint(x: point.x, y: point.y)
        // Moved first. A click posted without a move lands on an application
        // that never saw the pointer arrive, so anything that only appears on
        // hover — a menu, a disclosure control, a row's own buttons — is not
        // there yet when the button goes down.
        try Self.post(.mouseMoved, at: position)
        try Self.post(.leftMouseDown, at: position)
        try Self.post(.leftMouseUp, at: position)
    }

    public func type(_ text: String) async throws {
        try requireInputPermission()
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not send keystrokes to this Mac."
            )
        }
        let units = Array(text.utf16)
        var start = units.startIndex
        while start < units.endIndex {
            let end = min(start + Self.keystrokeChunk, units.endIndex)
            try Self.post(Array(units[start..<end]), from: source)
            start = end
        }
    }

    // MARK: - Permission

    private func requireInputPermission() throws {
        guard accessibilityAuthorized() else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno does not have macOS Accessibility permission, so it cannot click or type on this Mac. Grant it in System Settings → Privacy & Security → Accessibility."
            )
        }
    }

    // MARK: - Events

    private static func post(_ type: CGEventType, at position: CGPoint) throws {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: position,
            mouseButton: .left
        ) else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not send a click to this Mac."
            )
        }
        event.post(tap: .cghidEventTap)
    }

    private static func post(_ units: [UniChar], from source: CGEventSource) throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not send keystrokes to this Mac."
            )
        }
        units.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            // The character travels on the event's unicode payload rather than
            // as a virtual key code, so the text arrives the same whatever
            // keyboard layout the person is using. A layout-dependent path types
            // `q` into a Dvorak layout and gets `'`.
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    // MARK: - Encoding

    /// JPEG at the same quality ``CoreGraphicsScreenRedactor`` re-encodes with.
    ///
    /// Matching matters: a redacted image and an unredacted one that differed in
    /// file size would be distinguishable without opening either, which is a way
    /// of learning something about a screen from a log of sizes alone.
    static func encode(_ image: CGImage) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not store the picture it took of the screen."
            )
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [
                kCGImageDestinationLossyCompressionQuality:
                    CoreGraphicsScreenRedactor.compressionQuality
            ] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw AutomationRefusal(
                .driverUnavailable,
                "Juno could not store the picture it took of the screen."
            )
        }
        return output as Data
    }

    // MARK: - The accessibility walk

    private static func walk(
        _ element: AXUIElement,
        path: [Int],
        depth: Int,
        visited: inout Int,
        into fields: inout [AccessibilityFieldDescriptor]
    ) {
        guard depth < maximumDepth, visited < maximumNodes else { return }
        visited += 1
        if !path.isEmpty, let role = string(element, kAXRoleAttribute) {
            fields.append(
                AccessibilityFieldDescriptor(
                    elementID: path.map(String.init).joined(separator: "/"),
                    role: role,
                    subrole: string(element, kAXSubroleAttribute),
                    label: string(element, kAXTitleAttribute)
                        ?? string(element, kAXDescriptionAttribute),
                    isSecureTextEntry: isSecure(element),
                    contentHint: nil,
                    // Unlike the accessibility *tier*, this walk does read
                    // frames: they are the redaction plan, and a surface with no
                    // rectangle is one `ScreenshotPolicy` refuses to capture
                    // around.
                    bounds: frame(element)
                )
            )
        }
        for (index, child) in children(of: element).enumerated() {
            walk(child, path: path + [index], depth: depth + 1, visited: &visited, into: &fields)
        }
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
            == .success
        else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    private static func isSecure(_ element: AXUIElement) -> Bool {
        if let subrole = string(element, kAXSubroleAttribute),
            subrole == (kAXSecureTextFieldSubrole as String)
        {
            return true
        }
        return string(element, kAXRoleAttribute) == "AXSecureTextField"
    }

    /// The element's frame in screen points, or nil.
    ///
    /// Both halves have to unbox or the answer is nil rather than a rectangle
    /// with a plausible-looking zero in it: a redaction drawn at (0,0) covers the
    /// menu bar and leaves the field alone.
    private static func frame(_ element: AXUIElement) -> AutomationRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
            == .success,
            AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)
                == .success
        else { return nil }
        guard let rawPosition = positionValue, CFGetTypeID(rawPosition) == AXValueGetTypeID(),
            let rawSize = sizeValue, CFGetTypeID(rawSize) == AXValueGetTypeID()
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        // swiftlint:disable:next force_cast
        guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
            AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
        else { return nil }
        guard size.width > 0, size.height > 0 else { return nil }
        return AutomationRect(
            x: origin.x,
            y: origin.y,
            width: size.width,
            height: size.height
        )
    }
}
#endif
