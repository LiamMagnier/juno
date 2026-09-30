import XCTest
import JunoCodeCore
import JunoCodeLocal
@testable import JunoCodeRuntime

/// Long command output is saved whole in the session's folder, the result
/// carries its two ends and the path, and `read_file` pages the rest. The
/// command is no longer stopped at 2 MB.
final class CommandOutputSpillTests: XCTestCase {
    private var baseURL: URL!
    private var workspaceURL: URL!
    private var outputURL: URL!

    override func setUpWithError() throws {
        baseURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-spill-\(UUID().uuidString)")
        workspaceURL = baseURL.appendingPathComponent("workspace")
        outputURL = baseURL.appendingPathComponent("session/command-output")
        try FileManager.default.createDirectory(at: workspaceURL, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: baseURL)
    }

    private func context(_ callID: String, transcript: TranscriptRecorder = TranscriptRecorder()) -> ToolContext {
        ToolContext(
            sessionID: CodeSessionID(),
            toolCallID: callID,
            emitOutput: { _, text in transcript.record(text) },
            commandOutputDirectory: outputURL
        )
    }

    /// read_file over the workspace, whose files the saved-output path never
    /// reaches.
    private func readTool() throws -> ReadFileTool {
        let access = try WorkspaceAccess(workspaceID: WorkspaceID(), grantedURL: workspaceURL)
        return ReadFileTool(files: FileOperationService(
            access: access,
            checkpoints: CheckpointStore(directoryURL: baseURL.appendingPathComponent("checkpoints"), access: access)
        ))
    }

    // MARK: - The two ends

    func testTheBufferKeepsBothEndsAndCountsWhatItDropped() {
        var buffer = HeadTailBuffer(headBytes: 10, tailBytes: 10)
        buffer.append("0123456")
        XCTAssertTrue(buffer.isWhole)
        XCTAssertEqual(buffer.joined { _ in "|" }, "0123456")
        for chunk in ["789ab", "cdefghij", "klmnopqrstuv", "wxyz"] {
            buffer.append(chunk)
        }
        XCTAssertFalse(buffer.isWhole)
        XCTAssertEqual(buffer.totalBytes, 36)
        XCTAssertEqual(buffer.head, "0123456789")
        XCTAssertEqual(buffer.tail, "qrstuvwxyz")
        XCTAssertEqual(buffer.joined { "[\($0)]" }, "0123456789[16]qrstuvwxyz")
    }

    func testTheBufferNeverCutsACharacter() {
        var buffer = HeadTailBuffer(headBytes: 5, tailBytes: 5)
        buffer.append("ééé")   // six bytes
        buffer.append("😀😀")  // eight bytes
        XCTAssertEqual(buffer.head, "éé")
        XCTAssertEqual(buffer.tail, "😀")
        XCTAssertTrue(buffer.joined { _ in "" }.utf8.count <= 10)
    }

    // MARK: - run_command

    func testLongOutputIsSavedWholeAndTheResultSaysWhere() async throws {
        let lines = (1...60_000).map { "line \($0) of the build" } + ["error: the thing that broke"]
        let tool = RunCommandTool(executor: StreamingExecutor(text: lines.joined(separator: "\n") + "\n", chunk: 4_096))
        let transcript = TranscriptRecorder()

        let result = try await tool.execute(input: ["command": "make"], context: context("call-1", transcript: transcript))

        XCTAssertTrue(result.content.hasPrefix("line 1 of the build\n"))
        XCTAssertTrue(result.content.contains("error: the thing that broke"), "the tail survives")
        XCTAssertTrue(result.content.contains("read_file, path \"juno://command-output/call-1.log\""))
        XCTAssertLessThan(result.content.utf8.count, 100 * 1_024)
        let saved = try String(contentsOf: outputURL.appendingPathComponent("call-1.log"), encoding: .utf8)
        XCTAssertEqual(saved, lines.joined(separator: "\n") + "\n")
        // The transcript gets its own budget, then one line saying so.
        XCTAssertLessThanOrEqual(transcript.bytes, OutputLimit.commandOutput.maximumBytes + 100)
    }

    func testShortOutputIsReturnedWholeAndNotKept() async throws {
        let tool = RunCommandTool(executor: StreamingExecutor(text: "all good\n", chunk: 64))
        let result = try await tool.execute(input: ["command": "true"], context: context("short"))
        XCTAssertTrue(result.content.hasPrefix("all good\n\n[exit 0"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL.appendingPathComponent("short.log").path))
    }

    /// A real process that prints about 2.7 MB — past the old 2 MB kill — runs
    /// to its own end, and its middle can be paged back.
    func testARealCommandIsNotStoppedAtTwoMegabytesAndItsMiddleCanBeRead() async throws {
        let tool = RunCommandTool(executor: CommandExecutionService(workspaceRootURL: workspaceURL))
        let result = try await tool.execute(input: ["command": "seq 1 400000"], context: context("seq"))

        XCTAssertFalse(result.isError, result.content)
        XCTAssertTrue(result.content.contains("\n400000\n\n[exit 0"), "the last line and a clean exit")
        XCTAssertFalse(result.content.contains("stopped after printing"))

        let read = try readTool()
        let window = try await read.execute(
            input: ["path": "juno://command-output/seq.log", "offset": 200_000, "limit": 3],
            context: context("read")
        )
        XCTAssertEqual(
            window.content,
            #"{"path":"juno:\/\/command-output\/seq.log","first_line":200000,"last_line":200002,"total_lines":400000,"note":"partial read; pass offset 200003 to continue"}"#
                + "\n200000\n200001\n200002"
        )
    }

    func testOnlyASavedOutputOfThisSessionCanBeRead() async throws {
        let read = try readTool()
        for path in [
            "juno://command-output/../session.json",
            "juno://command-output/.hidden.log",
            "juno://command-output/missing.log",
            "juno://command-output/a/b.log",
        ] {
            do {
                _ = try await read.execute(input: ["path": .string(path)], context: context("read"))
                XCTFail("\(path) should not be readable")
            } catch {
                // Refused, as it should be.
            }
        }
        XCTAssertNil(CommandOutputSpill.resolve("juno://command-output/x.log", in: nil), "no session folder, no reads")
    }
}

private final class TranscriptRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var total = 0

    func record(_ text: String) {
        lock.lock(); total += text.utf8.count; lock.unlock()
    }

    var bytes: Int {
        lock.lock(); defer { lock.unlock() }
        return total
    }
}

/// Streams a fixed text in chunks, then exits cleanly.
private struct StreamingExecutor: CommandExecuting {
    let text: String
    let chunk: Int

    func stream(_ commandLine: String, timeoutSeconds: Double, outputLimit: OutputLimit) -> AsyncThrowingStream<CommandEvent, Error> {
        let text = self.text
        let chunk = self.chunk
        return AsyncThrowingStream { continuation in
            var rest = Substring(text)
            while !rest.isEmpty {
                continuation.yield(.stdout(String(rest.prefix(chunk))))
                rest = rest.dropFirst(chunk)
            }
            continuation.yield(.completed(CommandResult(
                exitCode: 0,
                wasTimeout: false,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: 0.1
            )))
            continuation.finish()
        }
    }
}

