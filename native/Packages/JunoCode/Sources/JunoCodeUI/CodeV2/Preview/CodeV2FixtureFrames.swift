import AppKit

/// Drawn stand-ins for computer-use screenshots in the fixtures: a browser
/// window on the storefront's checkout, one frame per step, written once to
/// the temporary folder so `CodeV2Frame` loads them like real captures.
/// Nothing here ships in a real session; real frames come from the bridge.
enum CodeV2FixtureFrames {
    /// The four steps of the fixture run, in order.
    enum Step: Int, CaseIterable {
        case blank, cart, typed, receipt
    }

    nonisolated(unsafe) private static var written: [Step: String] = [:]
    private static let lock = NSLock()

    /// The PNG path for a step, drawing it the first time.
    static func path(_ step: Step) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let done = written[step] { return done }
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("alevr-code-v2-fixture-\(step.rawValue)-v2.png")
        if !FileManager.default.fileExists(atPath: url.path) {
            guard let data = render(step) else { return nil }
            try? data.write(to: url)
        }
        written[step] = url.path
        return url.path
    }

    private static func render(_ step: Step) -> Data? {
        let size = NSSize(width: 960, height: 600)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let base = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        // A flipped context, so text set in it reads upright after the flip below.
        let context = NSGraphicsContext(cgContext: base.cgContext, flipped: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        defer { NSGraphicsContext.restoreGraphicsState() }
        // Flip so y grows downwards, like a screen.
        let flip = NSAffineTransform()
        flip.translateX(by: 0, yBy: size.height)
        flip.scaleX(by: 1, yBy: -1)
        flip.concat()

        let ink = NSColor(white: 0.12, alpha: 1)
        let muted = NSColor(white: 0.45, alpha: 1)
        let line = NSColor(white: 0.88, alpha: 1)
        func fill(_ rect: NSRect, _ color: NSColor, radius: CGFloat = 0) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func text(_ string: String, _ point: NSPoint, size: CGFloat, color: NSColor = ink, weight: NSFont.Weight = .regular) {
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
            NSAttributedString(string: string, attributes: attributes).draw(with: NSRect(x: point.x, y: point.y, width: 600, height: size * 1.4), options: [.usesLineFragmentOrigin], context: nil)
        }

        // Desktop and the browser window.
        fill(NSRect(origin: .zero, size: size), NSColor(calibratedRed: 0.86, green: 0.88, blue: 0.91, alpha: 1))
        let window = NSRect(x: 40, y: 30, width: 880, height: 540)
        fill(window, .white, radius: 12)
        fill(NSRect(x: 40, y: 30, width: 880, height: 44), NSColor(white: 0.96, alpha: 1), radius: 12)
        fill(NSRect(x: 40, y: 62, width: 880, height: 12), NSColor(white: 0.96, alpha: 1))
        for (i, c) in [NSColor.systemRed, .systemYellow, .systemGreen].enumerated() {
            fill(NSRect(x: 58 + CGFloat(i) * 20, y: 46, width: 12, height: 12), c.withAlphaComponent(0.8), radius: 6)
        }
        fill(NSRect(x: 300, y: 40, width: 360, height: 24), .white, radius: 6)
        text("storefront.local/checkout", NSPoint(x: 316, y: 44), size: 13, color: muted)
        fill(NSRect(x: 40, y: 74, width: 880, height: 1), line)

        if step == .blank {
            text("Storefront", NSPoint(x: 80, y: 110), size: 22, weight: .medium)
            for row in 0..<3 {
                fill(NSRect(x: 80, y: 170 + CGFloat(row) * 80, width: 520, height: 56), NSColor(white: 0.97, alpha: 1), radius: 8)
            }
            return rep.representation(using: .png, properties: [:])
        }

        // Checkout: the cart on the left, the summary on the right.
        text("Checkout", NSPoint(x: 80, y: 104), size: 24, weight: .medium)
        let items = [("Linen apron", "$48.00"), ("Stoneware mug, 2 ×", "$36.00"), ("Coffee scoop", "$12.00")]
        for (i, item) in items.enumerated() {
            let y = 160 + CGFloat(i) * 64
            fill(NSRect(x: 80, y: y, width: 44, height: 44), NSColor(white: 0.93, alpha: 1), radius: 6)
            text(item.0, NSPoint(x: 140, y: y + 12), size: 15)
            text(item.1, NSPoint(x: 520, y: y + 12), size: 15)
            fill(NSRect(x: 80, y: y + 54, width: 500, height: 1), line)
        }
        fill(NSRect(x: 80, y: 370, width: 300, height: 36), .white, radius: 6)
        NSColor(white: step == .typed ? 0.2 : 0.8, alpha: 1).setStroke()
        NSBezierPath(roundedRect: NSRect(x: 80, y: 370, width: 300, height: 36), xRadius: 6, yRadius: 6).stroke()
        text(step == .cart ? "Coupon code" : "SPRING10", NSPoint(x: 92, y: 378), size: 14, color: step == .cart ? muted : ink)

        let card = NSRect(x: 630, y: 140, width: 250, height: step == .receipt ? 300 : 220)
        fill(card, NSColor(white: 0.975, alpha: 1), radius: 10)
        text(step == .receipt ? "Receipt" : "Summary", NSPoint(x: 650, y: 158), size: 16, weight: .medium)
        let rows = [("Subtotal", "$96.00"), ("Tax", "$7.68"), ("Coupon", "−$10.37")]
        for (i, row) in rows.enumerated() {
            let y = 196 + CGFloat(i) * 30
            text(row.0, NSPoint(x: 650, y: y), size: 14, color: muted)
            text(row.1, NSPoint(x: 800, y: y), size: 14)
        }
        fill(NSRect(x: 650, y: 290, width: 210, height: 1), line)
        text("Total", NSPoint(x: 650, y: 302), size: 15, weight: .medium)
        text("$93.31", NSPoint(x: 796, y: 302), size: 15, weight: .medium)
        if step == .receipt {
            text("Charged by Stripe", NSPoint(x: 650, y: 344), size: 13, color: muted)
            text("$93.31", NSPoint(x: 800, y: 344), size: 13, color: muted)
            text("Matches the server total.", NSPoint(x: 650, y: 380), size: 13, color: muted)
        }
        return rep.representation(using: .png, properties: [:])
    }
}
