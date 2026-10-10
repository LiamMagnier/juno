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
        standInForGlass(in: frameView, window: window)
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
        drawSidebarRows(of: frameView, into: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.featureUnsupported) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
    }
}

extension RealWindowRenderer {
    /// The sidebar's source list sits in a scroll view the system masks for
    /// its edge effect and composites inside the glass, so the frame's own
    /// capture leaves the column empty. Each visible row view is drawn on its
    /// own, where it sits, clipped to what its scroll view shows.
    static func drawSidebarRows(of frameView: NSView, into rep: NSBitmapImageRep) {
        var tables: [NSTableView] = []
        func collect(_ view: NSView, inGlass: Bool) {
            let glass = inGlass || view is NSGlassEffectView
            if glass, let table = view as? NSTableView { tables.append(table) }
            view.subviews.forEach { collect($0, inGlass: glass) }
        }
        collect(frameView, inGlass: false)
        guard !tables.isEmpty, let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        defer { NSGraphicsContext.restoreGraphicsState() }
        for table in tables {
            let visible = table.visibleRect
            let range = table.rows(in: visible)
            let clip = table.enclosingScrollView.map { $0.contentView.convert($0.contentView.bounds, to: frameView) } ?? frameView.bounds
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: clip).addClip()
            for row in range.location..<(range.location + range.length) {
                guard let rowView = table.rowView(atRow: row, makeIfNecessary: false),
                      let sub = rowView.bitmapImageRepForCachingDisplay(in: rowView.bounds) else { continue }
                rowView.cacheDisplay(in: rowView.bounds, to: sub)
                let rect = rowView.convert(rowView.bounds, to: frameView)
                sub.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    /// The sidebar's Liquid Glass is composited by the window server, so
    /// `cacheDisplay` draws it as a blank (white in dark mode too). For the
    /// picture only, the glass gets the sidebar's own colour as a layer
    /// background, the stand-in the composed snapshots have always used.
    static func standInForGlass(in view: NSView, window: NSWindow) {
        if view is NSGlassEffectView {
            var color = CGColor(gray: 0.5, alpha: 1)
            (window.appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
                color = NSColor(Color.junoSidebar).cgColor
            }
            view.wantsLayer = true
            view.layer?.backgroundColor = color
            // The glass's own layers (everything that is not a subview's)
            // draw as a flat white offscreen; hide them so the stand-in
            // colour shows.
            let content = Set(view.subviews.compactMap(\.layer).map(ObjectIdentifier.init))
            for layer in view.layer?.sublayers ?? [] where !content.contains(ObjectIdentifier(layer)) {
                layer.isHidden = true
            }
        }
        view.subviews.forEach { standInForGlass(in: $0, window: window) }
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
