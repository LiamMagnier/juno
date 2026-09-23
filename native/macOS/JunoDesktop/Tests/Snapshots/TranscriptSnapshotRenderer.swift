import AppKit
import Foundation
import JunoDesignSystem
import SwiftUI

/// Work a fixture is still waiting on — a stub loader decoding a picture, a web
/// view taking its still. The renderer lets the run loop turn until this is
/// zero (or 1.5s pass) before it takes the picture.
@MainActor
enum SnapshotProbe {
    static var pending = 0
}

/// Draws a SwiftUI view into a PNG **without putting anything on screen**.
///
/// The view is hosted in an `NSHostingView` inside a borderless window placed
/// far off every display and never ordered in, then photographed with
/// `cacheDisplay` — which draws AppKit-backed pieces (`Menu` with
/// `.menuStyle(.button)`, `TextEditor`, `ScrollView`) for real, where
/// `ImageRenderer` draws them as placeholders. Nothing here can capture a
/// `WKWebView`, which renders out of process; see ``SnapshotStills``.
///
/// What this cannot show is Liquid Glass, which the window server composites —
/// and the transcript has none (§0.1), which is why it can be checked this way.
@MainActor
enum TranscriptSnapshotRenderer {
    enum Failure: Error, CustomStringConvertible {
        case bitmap(String)
        case encode(String)
        case blank(String, Double)

        var description: String {
            switch self {
            case .bitmap(let name): "\(name): the bitmap could not be allocated"
            case .encode(let name): "\(name): the PNG could not be encoded"
            case .blank(let name, let fraction):
                "\(name): only \(String(format: "%.3f", fraction * 100))% of pixels differ from the canvas — the offscreen window drew nothing"
            }
        }
    }

    /// The fixture column: the transcript's 768pt measure plus its 32pt gutters.
    static let columnWidth: CGFloat = 832

    /// Renders `view` at `width` points, 2× pixels, into
    /// `<dir>/<name>-<light|dark>.png`, and returns the file.
    @discardableResult
    static func render<V: View>(
        _ view: V,
        name: String,
        width: CGFloat = columnWidth,
        appearance: NSAppearance.Name,
        into dir: URL
    ) async throws -> URL {
        let isDark = appearance == .darkAqua
        let root = view
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .background(Color.junoCanvas)
            .environment(\.colorScheme, isDark ? .dark : .light)
            .environment(\.controlActiveState, .key)
            .environment(\.locale, Locale(identifier: "en_US"))
            .transaction { $0.disablesAnimations = true }

        let host = NSHostingView(rootView: root)
        let window = NSWindow(
            contentRect: CGRect(x: -20_000, y: -20_000, width: width, height: 10),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: appearance)
        window.isReleasedWhenClosed = false
        window.contentView = host
        // Never `orderFront` or `orderBack`: the window stays off screen and
        // off the window list, which is the whole point.

        host.layoutSubtreeIfNeeded()
        var size = CGSize(width: width, height: max(1, host.fittingSize.height))
        window.setContentSize(size)
        host.layoutSubtreeIfNeeded()

        // Settle: let stub loaders finish and layout converge, for at least
        // 300ms and at most 1.5s.
        let start = Date()
        while true {
            try await Task.sleep(for: .milliseconds(50))
            let elapsed = Date().timeIntervalSince(start)
            if elapsed >= 1.5 || (elapsed >= 0.3 && SnapshotProbe.pending == 0) { break }
        }
        host.layoutSubtreeIfNeeded()
        let settled = max(1, host.fittingSize.height)
        if abs(settled - size.height) > 0.5 {
            size.height = settled
            window.setContentSize(size)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
        }

        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int((size.width * 2).rounded()),
            pixelsHigh: Int((size.height * 2).rounded()),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw Failure.bitmap(name) }
        rep.size = size
        if let layer = host.layer { circularCapsules(in: layer) }
        host.cacheDisplay(in: host.bounds, to: rep)
        window.close()

        let suffix = isDark ? "dark" : "light"
        let url = dir.appendingPathComponent("\(name)-\(suffix).png")
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw Failure.encode(name)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try png.write(to: url)

        let fraction = differingFraction(of: rep, from: canvas(for: appearance))
        guard fraction >= 0.005 else { throw Failure.blank(name, fraction) }
        return url
    }

    /// Works around one flaw of `CALayer.render(in:)`, which `cacheDisplay`
    /// uses: a layer with *continuous* corners whose radius is half its height
    /// or more — every capsule SwiftUI draws as a bordered layer — renders with
    /// a stray vertical tick at each end, which the window server never draws.
    /// The path itself is a clean stadium (stroked into a `CGContext` it has
    /// no tick), so the harness draws those layers with circular corners — the
    /// same stadium to the eye — rather than show a defect the app does not
    /// have.
    static func circularCapsules(in layer: CALayer) {
        let short = min(layer.bounds.width, layer.bounds.height)
        if layer.cornerCurve == .continuous, short > 0, layer.cornerRadius >= short / 2 - 1.5 {
            layer.cornerCurve = .circular
        }
        for sublayer in layer.sublayers ?? [] { circularCapsules(in: sublayer) }
    }

    /// The canvas colour as the given appearance resolves it, in device RGB.
    static func canvas(for appearance: NSAppearance.Name) -> (red: Int, green: Int, blue: Int) {
        var components = (red: 0, green: 0, blue: 0)
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
            let color = NSColor(Color.junoCanvas).usingColorSpace(.deviceRGB) ?? .white
            components = (
                Int((color.redComponent * 255).rounded()),
                Int((color.greenComponent * 255).rounded()),
                Int((color.blueComponent * 255).rounded())
            )
        }
        return components
    }

    /// The share of pixels that are visibly not the canvas, read straight from
    /// the bitmap's bytes (RGBA, 8 bits a sample, as ``render`` allocates it).
    static func differingFraction(
        of rep: NSBitmapImageRep,
        from canvas: (red: Int, green: Int, blue: Int)
    ) -> Double {
        let width = rep.pixelsWide
        let height = rep.pixelsHigh
        guard width > 0, height > 0, let data = rep.bitmapData,
            rep.samplesPerPixel >= 3, rep.bitsPerSample == 8
        else { return 0 }
        let stride = rep.bytesPerRow
        let step = rep.bitsPerPixel / 8
        var differing = 0
        var sampled = 0
        for y in Swift.stride(from: 0, to: height, by: 2) {
            let row = data + y * stride
            for x in Swift.stride(from: 0, to: width, by: 2) {
                let pixel = row + x * step
                sampled += 1
                let delta = abs(Int(pixel[0]) - canvas.red)
                    + abs(Int(pixel[1]) - canvas.green)
                    + abs(Int(pixel[2]) - canvas.blue)
                if delta > 12 { differing += 1 }
            }
        }
        return sampled == 0 ? 0 : Double(differing) / Double(sampled)
    }
}
