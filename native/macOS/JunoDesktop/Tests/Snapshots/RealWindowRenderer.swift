import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI

@testable import JunoDesktop

/// A real titled window, never on screen: the production view in a
/// `.titled` + `.fullSizeContentView` window with a unified toolbar, the way
/// SwiftUI builds a `Window` scene, with the toolbar and the title bridged
/// from the view (`sceneBridgingOptions`). The window is ordered in far off
/// every display at zero opacity, so AppKit lays out the titlebar, the
/// traffic lights and the toolbar for real, and nothing appears on screen.
///
/// What it is for: the window's chrome region. ``capture(_:)`` draws the
/// whole frame view (titlebar, traffic lights, toolbar and content), and
/// ``ChromeGeometry`` reads where the window controls and the content's
/// first rows actually landed, so a test can prove the two never overlap.
@MainActor
enum RealWindowRenderer {
    /// A window that may sit off every screen: AppKit otherwise drags a
    /// titled window back onto a display when it is ordered in.
    final class OffscreenWindow: NSWindow {
        override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    }

    static let origin = CGPoint(x: -40_000, y: -40_000)

    /// Hosts `view` in a fresh offscreen window of `size` and lets it settle.
    static func host<V: View>(_ view: V, size: CGSize, isDark: Bool, settle: Duration = .milliseconds(1500)) async throws -> NSWindow {
        let root = view
            .environment(\.junoSnapshotOpaqueGlass, true)
            // The scroll edge effect masks a scroll view's content with a
            // backdrop that `cacheDisplay` cannot draw, which blanks the
            // sidebar's list in the picture. Off for the picture only.
            .scrollEdgeEffectHidden(true, for: .all)
            .transaction { $0.disablesAnimations = true }
        DesktopLayoutProbe.frames = [:]
        let controller = NSHostingController(rootView: AnyView(root))
        controller.sceneBridgingOptions = [.toolbars, .title]
        let window = OffscreenWindow(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        window.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        window.contentViewController = controller
        window.setContentSize(size)
        window.setFrameOrigin(origin)
        window.alphaValue = 0
        window.orderFrontRegardless()
        let start = ContinuousClock.now
        while ContinuousClock.now - start < settle {
            try await Task.sleep(for: .milliseconds(50))
            window.contentView?.layoutSubtreeIfNeeded()
        }
        return window
    }

    /// The whole window, titlebar included, at 2×.
    static func capture(_ window: NSWindow, into url: URL) throws {
        guard let frameView = window.contentView?.superview else { throw CocoaError(.featureUnsupported) }
        frameView.layoutSubtreeIfNeeded()
        let size = frameView.bounds.size
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw CocoaError(.featureUnsupported) }
        rep.size = size
        if let layer = frameView.layer { TranscriptSnapshotRenderer.circularCapsules(in: layer) }
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        drawSidebarRows(of: frameView, window: window, into: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.featureUnsupported) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
    }
}

extension RealWindowRenderer {
    /// The sidebar is Liquid Glass, which the window server composites: the
    /// frame's own capture draws the glass as a flat white sheet (in dark
    /// mode too) and leaves the source list in it empty, because the list's
    /// scroll view is masked for its edge effect. For the picture, the glass
    /// is painted in the sidebar's own colour, then the pieces on it are
    /// drawn one by one where they sit: the search field, each visible row
    /// (clipped to what its scroll view shows), and the titlebar with its
    /// window controls and toggle on top, in the window server's order.
    static func drawSidebarRows(of frameView: NSView, window: NSWindow, into rep: NSBitmapImageRep) {
        var glasses: [NSView] = []
        var tables: [NSTableView] = []
        var fields: [NSView] = []
        var titlebars: [NSView] = []
        func collect(_ view: NSView, inGlass: Bool) {
            let glass = inGlass || view is NSGlassEffectView
            if view is NSGlassEffectView { glasses.append(view) }
            if glass, let table = view as? NSTableView { tables.append(table) }
            if view is NSSearchField { fields.append(view) }
            if String(describing: type(of: view)) == "NSTitlebarContainerView" { titlebars.append(view) }
            view.subviews.forEach { collect($0, inGlass: glass) }
        }
        collect(frameView, inGlass: false)
        guard !glasses.isEmpty, let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        defer { NSGraphicsContext.restoreGraphicsState() }

        var sidebar = NSColor.windowBackgroundColor
        (window.appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            sidebar = NSColor(cgColor: NSColor(Color.junoSidebar).cgColor) ?? .windowBackgroundColor
        }
        func draw(_ view: NSView, clip: CGRect? = nil) {
            let bounds = view.bounds
            guard bounds.width > 0, bounds.height > 0,
                  let sub = view.bitmapImageRepForCachingDisplay(in: bounds) else { return }
            view.cacheDisplay(in: bounds, to: sub)
            NSGraphicsContext.saveGraphicsState()
            if let clip { NSBezierPath(rect: clip).addClip() }
            sub.draw(in: view.convert(bounds, to: frameView), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            NSGraphicsContext.restoreGraphicsState()
        }
        // In light the glass's flat capture already reads as the sidebar;
        // in dark it is a white sheet, so it is painted over (anything on the
        // glass that is not a row, the search field or the titlebar, like
        // the main window's account footer, is lost with it).
        let isDark = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        if isDark {
            for glass in glasses {
                sidebar.setFill()
                glass.convert(glass.bounds, to: frameView).fill()
            }
        }
        for table in tables {
            let range = table.rows(in: table.visibleRect)
            let clip = table.enclosingScrollView.map { $0.contentView.convert($0.contentView.bounds, to: frameView) }
            for row in range.location..<(range.location + range.length) {
                if let rowView = table.rowView(atRow: row, makeIfNecessary: false) { draw(rowView, clip: clip) }
            }
        }
        if isDark {
            fields.forEach { draw($0) }
            titlebars.forEach { draw($0) }
        }
    }
}

/// Where the window's controls and its content's rows landed, in window
/// coordinates flipped to top-left (y grows downward), so "below" reads as
/// a larger number.
@MainActor
struct ChromeGeometry {
    let windowHeight: CGFloat
    /// The traffic lights, together.
    let windowControls: CGRect
    /// The band the titlebar and toolbar take: everything above the
    /// window's content layout rect.
    let titlebarHeight: CGFloat
    /// Every visible row of every table (the sidebar's source list, the
    /// grouped form), in window coordinates.
    let rows: [(table: String, frame: CGRect)]
    /// Every split view (the NavigationSplitView's), in window coordinates.
    let splitViews: [CGRect]

    init(_ window: NSWindow) {
        let height = window.frame.height
        windowHeight = height
        func flipped(_ rect: CGRect) -> CGRect {
            CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
        }
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        windowControls = buttons
            .compactMap { window.standardWindowButton($0) }
            .map { flipped($0.convert($0.bounds, to: nil)) }
            .reduce(CGRect.null) { $0.union($1) }
        titlebarHeight = height - window.contentLayoutRect.maxY
        var found: [(String, CGRect)] = []
        var splits: [CGRect] = []
        func walk(_ view: NSView) {
            if view is NSSplitView { splits.append(flipped(view.convert(view.bounds, to: nil))) }
            if let table = view as? NSTableView {
                let visible = table.visibleRect
                let range = table.rows(in: visible)
                for row in range.location..<(range.location + range.length) {
                    let rect = table.rect(ofRow: row).intersection(visible)
                    guard !rect.isEmpty else { continue }
                    // Clip to what the enclosing scroll view actually shows.
                    var inWindow = table.convert(rect, to: nil)
                    if let clip = table.enclosingScrollView?.contentView {
                        inWindow = inWindow.intersection(clip.convert(clip.bounds, to: nil))
                    }
                    guard !inWindow.isEmpty else { continue }
                    found.append((String(describing: type(of: table)), flipped(inWindow)))
                }
            }
            view.subviews.forEach(walk)
        }
        if let frameView = window.contentView?.superview { walk(frameView) }
        rows = found
        splitViews = splits
    }

    /// The highest visible row's top edge, across every table whose rows
    /// start left of `x` (the sidebar) or right of it (the detail).
    func firstRowTop(leftOf x: CGFloat) -> CGFloat? {
        rows.filter { $0.frame.minX < x }.map(\.frame.minY).min()
    }

    func firstRowTop(rightOf x: CGFloat) -> CGFloat? {
        rows.filter { $0.frame.minX >= x }.map(\.frame.minY).min()
    }

    var description: String {
        "controls=\(windowControls) titlebar=\(titlebarHeight) splits=\(splitViews) rows=\(rows.prefix(6).map { "\($0.table) \($0.frame)" })"
    }
}
