import AppKit
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime
@testable import JunoCodeUI

/// Pasting and dropping pictures and PDFs (CODE_AGENT_SPEC §5.11).
@MainActor
final class ComposerPasteTests: XCTestCase {
    private var root: URL!
    private var store: CodeSessionStore!

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("juno-paste-\(UUID().uuidString)")
        store = CodeSessionStore(directoryURL: root)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private func controller(vision: Bool) async throws -> SessionController {
        let session = try await store.createSession(
            workspaceID: nil,
            workspaceName: nil,
            title: "Paste",
            configuration: AgentConfiguration(modelID: "test-model"),
            gitBranch: nil
        )
        return SessionController(
            session: session,
            context: nil,
            store: store,
            modelClient: UnconfiguredModelClient(),
            modelSupportsVision: { _ in vision }
        )
    }

    private static func png(width: Int = 4, height: Int = 4) throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ))
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    private static func pdf(pages: Int) -> Data {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 200, height: 100)
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        let context = CGContext(consumer: consumer, mediaBox: &box, nil)!
        for _ in 0..<pages {
            context.beginPDFPage(nil)
            context.setFillColor(CGColor(gray: 0.2, alpha: 1))
            context.fill(CGRect(x: 10, y: 10, width: 50, height: 50))
            context.endPDFPage()
        }
        context.closePDF()
        return data as Data
    }

    func testAPastedPNGBecomesAnAttachment() async throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("juno.test.paste.\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setData(try Self.png(), forType: .png)
        let attachments = StudioPasteboard.attachments(from: pasteboard)
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments.first?.image.mediaType, "image/png")
        XCTAssertEqual(attachments.first?.name, "Pasted image")

        let controller = try await controller(vision: true)
        controller.attach(try XCTUnwrap(attachments.first))
        XCTAssertEqual(controller.pendingAttachments.count, 1)
        XCTAssertNil(controller.transientError)
    }

    func testAPastedPDFBecomesItsFirstPages() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("juno.test.paste.\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setData(Self.pdf(pages: 6), forType: .pdf)
        let attachments = StudioPasteboard.attachments(from: pasteboard)
        XCTAssertEqual(attachments.count, 4, "the attachment limit")
        XCTAssertEqual(attachments.first?.name, "Pasted PDF, page 1")
        XCTAssertTrue(attachments.allSatisfy { $0.image.mediaType == "image/png" })

        // A dropped PDF file reads the same way.
        let file = root.appendingPathComponent("spec.pdf")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Self.pdf(pages: 1).write(to: file)
        let dropped = CodeAttachment.loadAll(contentsOf: file)
        XCTAssertEqual(dropped.map(\.name), ["spec.pdf"])
    }

    func testANonVisionModelSaysToSwitchInsteadOfAttaching() async throws {
        let controller = try await controller(vision: false)
        let picture = try XCTUnwrap(CodeAttachment.pasted(data: try Self.png(), declaredMediaType: "image/png"))
        controller.attach(picture)
        XCTAssertTrue(controller.pendingAttachments.isEmpty)
        XCTAssertEqual(controller.transientError, "This model cannot see images; switch to one that can.")
    }
}
