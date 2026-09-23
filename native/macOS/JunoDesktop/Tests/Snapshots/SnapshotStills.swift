import AppKit
import CoreGraphics
import Foundation
import JunoPreviewSupport
import WebKit

/// Deterministic stand-ins for the two things the offscreen renderer cannot
/// draw or must not fetch: a web view's pixels, and the transcript's media.
///
/// **Web stills.** A `WKWebView` renders out of process, so `cacheDisplay`
/// photographs an empty rectangle where one sits. Each document is instead
/// loaded into a web view of its own — 720×360, never placed in a window — and
/// photographed with `takeSnapshot`; the picture reaches the view under test
/// through `junoWebPreviewStill`. Fixtures use inline CSS only, so no network
/// is involved.
///
/// **Media.** The preview harness's own drawn PNGs for the two pictures, and
/// CoreGraphics thumbnails for a PDF page, a spreadsheet and a slide. Stage 2's
/// `SnapshotMediaProvider` serves these through the transcript's media loader.
@MainActor
enum SnapshotStills {
    enum Failure: Error, CustomStringConvertible {
        case timedOut
        case snapshotFailed(String)

        var description: String {
            switch self {
            case .timedOut: "the web view never finished loading"
            case .snapshotFailed(let reason): "takeSnapshot failed: \(reason)"
            }
        }
    }

    /// A still of `html`, as an inline artifact would draw it.
    static func still(
        html: String,
        size: CGSize = CGSize(width: 720, height: 360),
        timeout: TimeInterval = 6
    ) async throws -> NSImage {
        SnapshotProbe.pending += 1
        defer { SnapshotProbe.pending -= 1 }
        let loader = StillLoader()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(loader, name: "juno")
        defer { configuration.userContentController.removeScriptMessageHandler(forName: "juno") }
        let webView = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
        webView.navigationDelegate = loader
        webView.loadHTMLString(html, baseURL: nil)

        let start = Date()
        while !loader.isReady {
            guard Date().timeIntervalSince(start) < timeout else { throw Failure.timedOut }
            try await Task.sleep(for: .milliseconds(50))
        }
        do {
            return try await webView.takeSnapshot(configuration: WKSnapshotConfiguration())
        } catch {
            throw Failure.snapshotFailed(error.localizedDescription)
        }
    }

    /// Waits for the page to say it is done — the `juno` bridge posting a
    /// `status` of done or error — or, for a page with no bridge, for the load
    /// to finish plus 400ms for its first paint.
    @MainActor
    private final class StillLoader: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private(set) var isReady = false

        func webView(_: WKWebView, didFinish _: WKNavigation!) {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(400))
                self.isReady = true
            }
        }

        func webView(_: WKWebView, didFail _: WKNavigation!, withError _: any Error) {
            isReady = true
        }

        func userContentController(
            _: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                body["type"] as? String == "status",
                let status = body["status"] as? String,
                status == "done" || status == "error"
            else { return }
            isReady = true
        }
    }

    // MARK: Media

    /// The preview harness's picture for an attachment id — `img-user-1`
    /// (1200×800) and `img-gen-1` (1024×1024) — or nil.
    static func image(for attachmentID: String) -> NSImage? {
        PreviewImageFixtures.png(for: attachmentID).flatMap(NSImage.init(data:))
    }

    /// A PDF's first page: a white sheet with a heading and ruled text.
    static func pdfPageThumbnail(size: CGSize = CGSize(width: 288, height: 192)) -> NSImage {
        drawn(size: size) { context, rect in
            context.setFillColor(NSColor.white.cgColor)
            context.fill(rect)
            context.setFillColor(NSColor(white: 0.15, alpha: 1).cgColor)
            context.fill(CGRect(x: 24, y: rect.height - 40, width: rect.width * 0.55, height: 12))
            context.setFillColor(NSColor(white: 0.72, alpha: 1).cgColor)
            var y = rect.height - 64
            while y > 16 {
                let width = (y.truncatingRemainder(dividingBy: 3) < 1 ? 0.7 : 0.86) * (rect.width - 48)
                context.fill(CGRect(x: 24, y: y, width: width, height: 5))
                y -= 13
            }
        }
    }

    /// A spreadsheet: a header band and a grid of cells, some filled.
    static func spreadsheetThumbnail(size: CGSize = CGSize(width: 288, height: 192)) -> NSImage {
        drawn(size: size) { context, rect in
            context.setFillColor(NSColor.white.cgColor)
            context.fill(rect)
            let columns = 5
            let rows = 9
            let cell = CGSize(width: rect.width / CGFloat(columns), height: rect.height / CGFloat(rows))
            context.setFillColor(NSColor(red: 0.86, green: 0.93, blue: 0.87, alpha: 1).cgColor)
            context.fill(CGRect(x: 0, y: rect.height - cell.height, width: rect.width, height: cell.height))
            context.setFillColor(NSColor(white: 0.55, alpha: 1).cgColor)
            for row in 1..<rows {
                for column in 0..<columns where (row + column) % 3 != 0 {
                    let x = CGFloat(column) * cell.width + 6
                    let y = rect.height - CGFloat(row + 1) * cell.height + cell.height / 2 - 2
                    context.fill(CGRect(x: x, y: y, width: cell.width * 0.55, height: 4))
                }
            }
            context.setStrokeColor(NSColor(white: 0.82, alpha: 1).cgColor)
            context.setLineWidth(1)
            for column in 0...columns {
                let x = CGFloat(column) * cell.width
                context.move(to: CGPoint(x: x, y: 0))
                context.addLine(to: CGPoint(x: x, y: rect.height))
            }
            for row in 0...rows {
                let y = CGFloat(row) * cell.height
                context.move(to: CGPoint(x: 0, y: y))
                context.addLine(to: CGPoint(x: rect.width, y: y))
            }
            context.strokePath()
        }
    }

    /// A 16:9 slide: a coloured title band over a pale body.
    static func slideThumbnail(size: CGSize = CGSize(width: 288, height: 162)) -> NSImage {
        drawn(size: size) { context, rect in
            context.setFillColor(NSColor(red: 0.97, green: 0.96, blue: 0.94, alpha: 1).cgColor)
            context.fill(rect)
            context.setFillColor(NSColor(red: 0.19, green: 0.29, blue: 0.47, alpha: 1).cgColor)
            context.fill(CGRect(x: 0, y: rect.height * 0.62, width: rect.width, height: rect.height * 0.38))
            context.setFillColor(NSColor.white.cgColor)
            context.fill(CGRect(x: 20, y: rect.height * 0.75, width: rect.width * 0.5, height: 12))
            context.setFillColor(NSColor(white: 0.6, alpha: 1).cgColor)
            for index in 0..<3 {
                context.fill(CGRect(x: 20, y: rect.height * 0.45 - CGFloat(index) * 16, width: rect.width * 0.6, height: 6))
            }
        }
    }

    private static func drawn(size: CGSize, _ draw: @escaping (CGContext, CGRect) -> Void) -> NSImage {
        NSImage(size: size, flipped: false) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            draw(context, rect)
            return true
        }
    }
}
