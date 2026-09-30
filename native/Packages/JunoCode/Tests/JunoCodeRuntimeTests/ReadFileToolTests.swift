import CoreText
import ImageIO
import UniformTypeIdentifiers
import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// What `read_file` returns for text with line numbers, for binaries, for
/// images and for PDFs, read from a real workspace.
final class ReadFileToolTests: XCTestCase {
    private var workspaceURL: URL!
    private var files: FileOperationService!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-read-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        files = FileOperationService(
            access: access,
            checkpoints: CheckpointStore(
                directoryURL: URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("juno-code-read-checkpoints-\(UUID().uuidString)"),
                access: access
            )
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func put(_ data: Data, _ name: String) throws {
        try data.write(to: workspaceURL.appendingPathComponent(name))
    }

    private func read(_ input: JSONValue, allowsImages: Bool = true) async throws -> ToolResult {
        try await ReadFileTool(files: files, allowsImages: allowsImages).execute(
            input: input,
            context: ToolContext(sessionID: CodeSessionID(), toolCallID: "c", emitOutput: { _, _ in })
        )
    }

    private func split(_ content: String) throws -> (header: [String: Any], body: String) {
        let newline = content.firstIndex(of: "\n") ?? content.endIndex
        let header = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(content[..<newline].utf8)) as? [String: Any]
        )
        let body = newline < content.endIndex ? String(content[content.index(after: newline)...]) : ""
        return (header, body)
    }

    // MARK: - Text

    func testTextComesBackNumberedWithTheWholeFilesFingerprint() async throws {
        let source = "first\nsecond\nthird\n"
        try put(Data(source.utf8), "a.txt")
        let result = try await read(["path": "a.txt"])
        let (header, body) = try split(result.content)
        XCTAssertEqual(header["line_numbers"] as? Bool, true)
        XCTAssertEqual(header["base_sha256"] as? String, FileFingerprint(of: source).sha256)
        XCTAssertEqual(body, "     1\tfirst\n     2\tsecond\n     3\tthird\n")
    }

    func testAWindowIsNumberedFromItsFirstLineAndBareOnRequest() async throws {
        try put(Data((1...10).map { "line \($0)" }.joined(separator: "\n").utf8), "a.txt")
        let window = try await read(["path": "a.txt", "offset": 4, "limit": 2])
        let (header, body) = try split(window.content)
        XCTAssertEqual(header["first_line"] as? Int, 4)
        XCTAssertEqual(header["last_line"] as? Int, 5)
        XCTAssertNil(header["base_sha256"])
        XCTAssertEqual(body, "     4\tline 4\n     5\tline 5")

        let bare = try await read(["path": "a.txt", "offset": 4, "limit": 2, "line_numbers": false])
        XCTAssertEqual(try split(bare.content).body, "line 4\nline 5")
    }

    func testNumberingCountsAgainstTheByteBudget() async throws {
        // Short lines whose raw bytes fit the budget but whose numbered form
        // would not: the read pages instead of overflowing.
        let line = String(repeating: "x", count: 40)
        let count = ReadFileTool.maximumContentBytes / 41
        try put(Data(Array(repeating: line, count: count).joined(separator: "\n").utf8), "long.txt")
        let result = try await read(["path": "long.txt", "limit": .number(Double(count))])
        XCTAssertLessThanOrEqual(result.content.utf8.count, ReadFileTool.maximumContentBytes + 512)
        let (header, _) = try split(result.content)
        XCTAssertEqual(header["truncated"] as? Bool, true)
        XCTAssertLessThan(try XCTUnwrap(header["last_line"] as? Int), count)
    }

    // MARK: - Binary

    func testABinaryFileIsDescribedNotDumped() async throws {
        try put(Data([0xCF, 0xFA, 0xED, 0xFE, 0x00, 0x00, 0x01]), "tool")
        let result = try await read(["path": "tool"])
        XCTAssertFalse(result.isError)
        let (header, body) = try split(result.content)
        XCTAssertEqual(header["binary"] as? Bool, true)
        XCTAssertEqual(header["format"] as? String, "Mach-O")
        XCTAssertEqual(header["bytes"] as? Int, 7)
        XCTAssertEqual(body, "")
    }

    func testTextThatIsNotUTF8IsDescribedToo() async throws {
        try put(Data([0x63, 0x61, 0x66, 0xE9, 0x0A]), "latin1.txt")
        let result = try await read(["path": "latin1.txt"])
        XCTAssertEqual(try split(result.content).header["binary"] as? Bool, true)
    }

    // MARK: - Images

    func testAnImageComesBackAsAnImage() async throws {
        try put(try Self.png(width: 32, height: 16), "logo.png")
        let result = try await read(["path": "logo.png"])
        XCTAssertEqual(result.images.count, 1)
        XCTAssertEqual(result.images.first?.mediaType, "image/png")
        let header = try split(result.content).header
        XCTAssertEqual(header["width"] as? Int, 32)
        XCTAssertEqual(header["height"] as? Int, 16)
        XCTAssertNil(header["shown_at"])
    }

    func testAModelWithoutVisionIsToldAboutTheImageInstead() async throws {
        try put(try Self.png(width: 8, height: 8), "logo.png")
        let result = try await read(["path": "logo.png"], allowsImages: false)
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertTrue(result.content.contains("cannot view images"), result.content)
    }

    func testAnOversizedImageIsScaledDown() async throws {
        try put(try Self.png(width: 9_000, height: 30), "strip.png")
        let result = try await read(["path": "strip.png"])
        let image = try XCTUnwrap(result.images.first)
        XCTAssertLessThanOrEqual(image.data.count, ImageAttachment.maximumSentBytes)
        let header = try split(result.content).header
        XCTAssertEqual(header["width"] as? Int, 9_000)
        let shown = try XCTUnwrap(header["shown_at"] as? String)
        XCTAssertTrue(shown.hasPrefix("\(ImageAttachment.resizedEdgePixels)x"), shown)
    }

    // MARK: - PDF

    func testAPDFsTextComesBackPageByPage() async throws {
        try put(try Self.pdf(pages: ["Alpha page", "Beta page", "Gamma page"]), "doc.pdf")
        let whole = try await read(["path": "doc.pdf"])
        let (header, body) = try split(whole.content)
        XCTAssertEqual(header["total_pages"] as? Int, 3)
        XCTAssertTrue(body.contains("--- page 1 ---"), body)
        XCTAssertTrue(body.contains("Alpha"), body)
        XCTAssertTrue(body.contains("Gamma"), body)

        let second = try await read(["path": "doc.pdf", "pages": "2"])
        let (secondHeader, secondBody) = try split(second.content)
        XCTAssertEqual(secondHeader["first_page"] as? Int, 2)
        XCTAssertEqual(secondHeader["last_page"] as? Int, 2)
        XCTAssertTrue(secondBody.contains("Beta"), secondBody)
        XCTAssertFalse(secondBody.contains("Alpha"), secondBody)

        let outOfRange = try await read(["path": "doc.pdf", "pages": "4-5"])
        XCTAssertTrue(outOfRange.isError)
        XCTAssertTrue(outOfRange.content.contains("3 pages"), outOfRange.content)
    }

    func testALongPDFIsPagedAtTheLimit() async throws {
        try put(try Self.pdf(pages: (1...25).map { "Page number \($0)" }), "long.pdf")
        let result = try await read(["path": "long.pdf"])
        let header = try split(result.content).header
        XCTAssertEqual(header["last_page"] as? Int, ReadFileTool.maximumPDFPages)
        XCTAssertTrue((header["note"] as? String ?? "").contains("21-25"), "\(header)")
    }

    func testPageRangesParse() throws {
        XCTAssertEqual(try PDFText.parse("3", total: 5), 3...3)
        XCTAssertEqual(try PDFText.parse(" 2 - 4 ", total: 5), 2...4)
        XCTAssertThrowsError(try PDFText.parse("0", total: 5))
        XCTAssertThrowsError(try PDFText.parse("4-2", total: 5))
        XCTAssertThrowsError(try PDFText.parse("a", total: 5))
    }

    // MARK: - Fixtures

    static func png(width: Int, height: Int) throws -> Data {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static func pdf(pages: [String]) throws -> Data {
        let data = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: data as CFMutableData))
        var box = CGRect(x: 0, y: 0, width: 612, height: 792)
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &box, nil))
        let font = CTFontCreateWithName("Helvetica" as CFString, 18, nil)
        for text in pages {
            context.beginPDFPage(nil)
            let attributed = NSAttributedString(
                string: text,
                attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]
            )
            let line = CTLineCreateWithAttributedString(attributed)
            context.textPosition = CGPoint(x: 72, y: 700)
            CTLineDraw(line, context)
            context.endPDFPage()
        }
        context.closePDF()
        return data as Data
    }
}
