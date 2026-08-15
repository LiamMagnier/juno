import Foundation
import JunoCodeCore
import XCTest

@testable import JunoCodeRuntime

// MARK: - Payload parsing

/// The wire decoder is where a sandbox result stops being someone else's JSON
/// and starts being a fact Juno shows a user, so these tests spend most of their
/// attention on the places where a missing field could become a confident claim.
final class CloudCodeSandboxWireTests: XCTestCase {
    func testDecodesCompleteResult() throws {
        let payload = Data(#"""
        {
          "stdout": "mean 4.5\n",
          "stderr": "",
          "exitCode": 0,
          "timedOut": false,
          "durationSeconds": 1.25,
          "truncated": {"stdout": false, "stderr": false},
          "files": [
            {"name": "summary.csv", "contentBase64": "YSxiCjEsMg==", "mimeType": null}
          ],
          "charts": [
            {"name": "figure-2.png", "format": "png", "imageBase64": "\#(Self.pngBase64)"}
          ]
        }
        """#.utf8)

        let result = try CloudCodeSandboxWire.decode(payload)

        XCTAssertEqual(result.stdout, "mean 4.5\n")
        XCTAssertEqual(result.stderr, "")
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.timedOut, false)
        XCTAssertEqual(result.durationSeconds, 1.25)
        XCTAssertEqual(result.succeeded, true)
        XCTAssertEqual(result.outputWasTruncated, false)
        XCTAssertEqual(result.files.map(\.name), ["summary.csv"])
        XCTAssertEqual(result.files.first?.contents, Data("a,b\n1,2".utf8))
        // A null mimeType from the backend still gets the extension's answer:
        // "the backend did not say" is not "the type is unknowable".
        XCTAssertEqual(result.files.first?.mimeType, "text/csv")
        XCTAssertEqual(result.charts.count, 1)
        XCTAssertEqual(result.charts.first?.format, .png)
        XCTAssertEqual(result.charts.first?.figureNumber, 2)
    }

    /// The single most damaging default this type could adopt: a script that
    /// crashed, whose backend forgot to report the exit code, must not read as a
    /// clean success.
    func testAbsentExitCodeIsNotSuccess() throws {
        let result = try CloudCodeSandboxWire.decode(Data(#"{"stdout":"partial"}"#.utf8))

        XCTAssertNil(result.exitCode)
        XCTAssertNil(result.succeeded)
        XCTAssertNil(result.timedOut)
        XCTAssertNil(result.durationSeconds)
        XCTAssertNil(result.outputWasTruncated)
        // stderr absent is not stderr empty.
        XCTAssertNil(result.stderr)
    }

    func testTimeoutWithZeroExitCodeIsNotSuccess() throws {
        let result = try CloudCodeSandboxWire.decode(
            Data(#"{"exitCode":0,"timedOut":true}"#.utf8)
        )

        XCTAssertEqual(result.succeeded, false)
    }

    func testTruncationOfEitherStreamIsReportedOverall() throws {
        let result = try CloudCodeSandboxWire.decode(
            Data(#"{"truncated":{"stdout":false,"stderr":true}}"#.utf8)
        )

        XCTAssertEqual(result.stdoutWasTruncated, false)
        XCTAssertEqual(result.stderrWasTruncated, true)
        XCTAssertEqual(result.outputWasTruncated, true)
    }

    func testPartiallyKnownTruncationStaysUnknownOverall() throws {
        let result = try CloudCodeSandboxWire.decode(
            Data(#"{"truncated":{"stdout":false}}"#.utf8)
        )

        XCTAssertEqual(result.stdoutWasTruncated, false)
        XCTAssertNil(result.stderrWasTruncated)
        XCTAssertNil(result.outputWasTruncated)
    }

    func testBooleanIsNotAcceptedWhereANumberIsRequired() {
        XCTAssertThrowsError(
            try CloudCodeSandboxWire.decode(Data(#"{"exitCode":true}"#.utf8))
        ) { error in
            XCTAssertEqual(error as? SandboxPayloadError, .malformedField("exitCode"))
        }
    }

    func testNonObjectAndNonJSONAreRejected() {
        XCTAssertThrowsError(try CloudCodeSandboxWire.decode(Data("not json".utf8))) {
            XCTAssertEqual($0 as? SandboxPayloadError, .notJSON)
        }
        XCTAssertThrowsError(try CloudCodeSandboxWire.decode(Data("[1,2]".utf8))) {
            XCTAssertEqual($0 as? SandboxPayloadError, .notAnObject)
        }
    }

    /// A corrupt blob has to fail loudly. Decoding it leniently produces a short
    /// stream of valid-looking bytes that renders as a grey rectangle, and the
    /// user blames their plotting code.
    func testCorruptChartBase64Throws() {
        XCTAssertThrowsError(
            try CloudCodeSandboxWire.decode(
                Data(#"{"charts":[{"imageBase64":"not base64 at all!!","format":"png"}]}"#.utf8)
            )
        ) { error in
            XCTAssertEqual(
                error as? SandboxPayloadError,
                .invalidBase64(field: "charts[].imageBase64")
            )
        }
    }

    func testSniffedBytesOverrideAMistakenDeclaredFormat() throws {
        let result = try CloudCodeSandboxWire.decode(Data(#"""
        {"charts":[{"name":"plot.svg","format":"svg","imageBase64":"\#(Self.pngBase64)"}]}
        """#.utf8))

        XCTAssertEqual(result.charts.first?.format, .png)
    }

    func testUnrecognisableChartFormatIsRejectedRatherThanGuessed() {
        let opaque = Data([0x00, 0x01, 0x02, 0x03]).base64EncodedString()

        XCTAssertThrowsError(
            try CloudCodeSandboxWire.decode(
                Data(#"{"charts":[{"name":"plot.bin","imageBase64":"\#(opaque)"}]}"#.utf8)
            )
        ) { error in
            XCTAssertEqual(
                error as? SandboxPayloadError,
                .unsupportedChartFormat("unspecified")
            )
        }
    }

    func testFigureNumberIsNeverInventedFromPosition() throws {
        let result = try CloudCodeSandboxWire.decode(Data(#"""
        {"charts":[{"name":"scatter.png","imageBase64":"\#(Self.pngBase64)"}]}
        """#.utf8))

        // "scatter.png" carries no figure number, and Matplotlib numbers from 1,
        // so neither 0 nor 1 would be true.
        XCTAssertNil(result.charts.first?.figureNumber)
    }

    func testOversizedFileIsReportedAsOmittedRatherThanDropped() throws {
        let big = Data(repeating: 0x41, count: 4_096).base64EncodedString()
        let limits = SandboxPayloadLimits(maximumFileBytes: 128)

        let result = try CloudCodeSandboxWire.decode(
            Data(#"{"files":[{"name":"big.bin","contentBase64":"\#(big)"}]}"#.utf8),
            limits: limits
        )

        XCTAssertTrue(result.files.isEmpty)
        XCTAssertEqual(
            result.omittedFiles,
            [SandboxOmittedFile(
                name: "big.bin",
                reason: .exceededFileSizeLimit(byteCount: 4_096, limitBytes: 128)
            )]
        )
    }

    func testFileCountLimitOmitsTheRemainderByName() throws {
        let entry = #"{"name":"NAME","contentBase64":"YQ=="}"#
        let names = (1...4).map { "f\($0).txt" }
        let body = names
            .map { entry.replacingOccurrences(of: "NAME", with: $0) }
            .joined(separator: ",")

        let result = try CloudCodeSandboxWire.decode(
            Data("{\"files\":[\(body)]}".utf8),
            limits: SandboxPayloadLimits(maximumFileCount: 2)
        )

        XCTAssertEqual(result.files.map(\.name), ["f1.txt", "f2.txt"])
        XCTAssertEqual(result.omittedFiles.map(\.name), ["f3.txt", "f4.txt"])
    }

    func testUnnamedFileIsRejected() {
        XCTAssertThrowsError(
            try CloudCodeSandboxWire.decode(
                Data(#"{"files":[{"contentBase64":"YQ=="}]}"#.utf8)
            )
        ) { XCTAssertEqual($0 as? SandboxPayloadError, .unnamedFile) }
    }

    func testRequestEncodingCarriesSourceTimeoutAndInputs() throws {
        let request = SandboxScriptRequest(
            source: "print(1)",
            timeoutSeconds: 5,
            inputFiles: [SandboxInputFile(name: "in.csv", contents: Data("a".utf8))]
        )

        let encoded = try CloudCodeSandboxWire.encode(request)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        XCTAssertEqual(object["language"] as? String, "python")
        XCTAssertEqual(object["source"] as? String, "print(1)")
        XCTAssertEqual(object["timeoutSeconds"] as? Double, 5)
        let files = try XCTUnwrap(object["inputFiles"] as? [[String: Any]])
        XCTAssertEqual(files.first?["name"] as? String, "in.csv")
        XCTAssertEqual(files.first?["contentBase64"] as? String, "YQ==")
    }

    func testTimeoutIsClampedRatherThanRejected() {
        XCTAssertEqual(SandboxScriptRequest(source: "", timeoutSeconds: 99_999).timeoutSeconds, 600)
        XCTAssertEqual(SandboxScriptRequest(source: "", timeoutSeconds: -4).timeoutSeconds, 1)
    }

    /// A minimal 1x1 PNG, so format sniffing is exercised against real magic
    /// bytes rather than a string that happens to start with the right prefix.
    private static let pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
}

// MARK: - Hosted backend

final class CloudCodeSandboxServiceTests: XCTestCase {
    func testServiceSendsEncodedRequestAndParsesResponse() async throws {
        let transport = RecordingTransport(
            response: Data(#"{"stdout":"hi","exitCode":0,"timedOut":false}"#.utf8)
        )

        let result = try await CloudCodeSandboxService(transport: transport)
            .run(SandboxScriptRequest(source: "print('hi')"))

        XCTAssertEqual(result.stdout, "hi")
        XCTAssertEqual(result.succeeded, true)
        let payload = await transport.lastPayload
        let sent = try XCTUnwrap(payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(object["source"] as? String, "print('hi')")
    }

    /// The hosted backend is contained, but nothing in this process can verify
    /// it, so the description must not claim it.
    func testHostedBackendDoesNotClaimUnverifiableContainment() {
        let backend = CloudCodeSandboxService(transport: RecordingTransport(response: Data()))
            .backend

        XCTAssertTrue(backend.isRemote)
        XCTAssertNil(backend.isKernelContained)
    }

    private actor RecordingTransport: SandboxTransport {
        private let response: Data
        private(set) var lastPayload: Data?

        init(response: Data) { self.response = response }

        func execute(payload: Data) async throws -> Data {
            lastPayload = payload
            return response
        }
    }
}

// MARK: - Local developer-mode fallback

final class LocalPythonSandboxClientTests: XCTestCase {
    private var scratchRoot: URL!

    override func setUpWithError() throws {
        scratchRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-sandbox-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: scratchRoot,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratchRoot)
    }

    /// The launcher must be a separate file. If it were prepended to the user's
    /// script, every traceback line number would be shifted by the length of the
    /// preamble and would point at the wrong line of their code.
    func testUserScriptIsWrittenVerbatimAndLaunchedSeparately() async throws {
        let source = "raise ValueError('boom')\n"
        let executor = StubExecutor()
        let client = LocalPythonSandboxClient(
            executor: executor,
            scratchRootURL: scratchRoot
        )

        _ = try await client.run(SandboxScriptRequest(source: source))

        let runDirectory = try XCTUnwrap(soleRunDirectory())
        let written = try String(
            contentsOf: runDirectory.appendingPathComponent("main.py"),
            encoding: .utf8
        )
        XCTAssertEqual(written, source)
        let bootstrap = try String(
            contentsOf: runDirectory.appendingPathComponent("__juno_bootstrap__.py"),
            encoding: .utf8
        )
        XCTAssertTrue(bootstrap.contains(#"run_path(_juno_script, run_name="__main__")"#))
    }

    func testHarvestSeparatesChartsFromGeneratedFilesAndIgnoresHarnessArtifacts() async throws {
        let executor = StubExecutor()
        let root = scratchRoot!
        await executor.setSideEffect {
            guard let directory = soleDirectory(in: root) else { return }
            try? FileManager.default.createDirectory(
                at: directory.appendingPathComponent("__juno_charts__"),
                withIntermediateDirectories: true
            )
            try? onePixelPNG.write(
                to: directory.appendingPathComponent("__juno_charts__/figure-3.png")
            )
            try? Data("a,b\n".utf8).write(to: directory.appendingPathComponent("out.csv"))
            try? FileManager.default.createDirectory(
                at: directory.appendingPathComponent("__pycache__"),
                withIntermediateDirectories: true
            )
            try? Data("junk".utf8).write(
                to: directory.appendingPathComponent("__pycache__/main.pyc")
            )
        }

        let result = try await LocalPythonSandboxClient(
            executor: executor,
            scratchRootURL: root
        ).run(SandboxScriptRequest(source: "import matplotlib"))

        XCTAssertEqual(result.charts.map(\.name), ["figure-3.png"])
        XCTAssertEqual(result.charts.first?.format, .png)
        XCTAssertEqual(result.charts.first?.figureNumber, 3)
        // main.py, the bootstrap and __pycache__ are Juno's and CPython's, not
        // the script's output.
        XCTAssertEqual(result.files.map(\.name), ["out.csv"])
        XCTAssertEqual(result.files.first?.mimeType, "text/csv")
    }

    func testNonImageInTheChartDirectoryIsReturnedAsAFileNotAFabricatedChart() async throws {
        let executor = StubExecutor()
        let root = scratchRoot!
        await executor.setSideEffect {
            guard let directory = soleDirectory(in: root) else { return }
            try? FileManager.default.createDirectory(
                at: directory.appendingPathComponent("__juno_charts__"),
                withIntermediateDirectories: true
            )
            try? Data("nonsense".utf8).write(
                to: directory.appendingPathComponent("__juno_charts__/notes.bin")
            )
        }

        let result = try await LocalPythonSandboxClient(
            executor: executor,
            scratchRootURL: scratchRoot
        ).run(SandboxScriptRequest(source: ""))

        XCTAssertTrue(result.charts.isEmpty)
        XCTAssertEqual(result.files.map(\.name), ["__juno_charts__/notes.bin"])
        XCTAssertNil(result.files.first?.mimeType)
    }

    /// The executor enforces one budget across both pipes and does not say which
    /// one it cut, so neither per-stream flag may claim to know.
    func testSharedBudgetTruncationIsReportedWithoutAttributingIt() async throws {
        let executor = StubExecutor(
            result: CommandResult(
                exitCode: 0,
                wasTimeout: false,
                wasCancelled: false,
                wasTruncated: true,
                durationSeconds: 0.5
            )
        )

        let result = try await LocalPythonSandboxClient(
            executor: executor,
            scratchRootURL: scratchRoot
        ).run(SandboxScriptRequest(source: ""))

        XCTAssertNil(result.stdoutWasTruncated)
        XCTAssertNil(result.stderrWasTruncated)
        XCTAssertEqual(result.outputWasTruncated, true)
    }

    func testExecutorFailureAndTimeoutAreReportedFaithfully() async throws {
        let executor = StubExecutor(
            result: CommandResult(
                exitCode: 137,
                wasTimeout: true,
                wasCancelled: false,
                wasTruncated: false,
                durationSeconds: 60
            ),
            stderr: "Traceback…"
        )

        let result = try await LocalPythonSandboxClient(
            executor: executor,
            scratchRootURL: scratchRoot
        ).run(SandboxScriptRequest(source: ""))

        XCTAssertEqual(result.exitCode, 137)
        XCTAssertEqual(result.timedOut, true)
        XCTAssertEqual(result.stderr, "Traceback…")
        XCTAssertEqual(result.succeeded, false)
    }

    func testInputFilesAreWrittenAndTraversalIsRefused() async throws {
        let executor = StubExecutor()
        let client = LocalPythonSandboxClient(executor: executor, scratchRootURL: scratchRoot)

        _ = try await client.run(SandboxScriptRequest(
            source: "",
            inputFiles: [SandboxInputFile(name: "data.csv", contents: Data("x".utf8))]
        ))
        let directory = try XCTUnwrap(soleRunDirectory())
        XCTAssertEqual(
            try Data(contentsOf: directory.appendingPathComponent("data.csv")),
            Data("x".utf8)
        )

        do {
            _ = try await client.run(SandboxScriptRequest(
                source: "",
                inputFiles: [SandboxInputFile(name: "../escape.txt", contents: Data())]
            ))
            XCTFail("A path traversal must never be written")
        } catch {
            XCTAssertEqual(
                error as? LocalPythonSandboxClient.PreparationError,
                .unsafeInputFileName("../escape.txt")
            )
        }
    }

    func testUnknownContainmentIsNotReportedAsUncontained() {
        let unknown = LocalPythonSandboxClient(
            executor: StubExecutor(),
            scratchRootURL: scratchRoot
        )
        let contained = LocalPythonSandboxClient(
            executor: StubExecutor(),
            scratchRootURL: scratchRoot,
            isKernelContained: true
        )

        XCTAssertNil(unknown.backend.isKernelContained)
        XCTAssertEqual(contained.backend.isKernelContained, true)
        XCTAssertFalse(unknown.backend.isRemote)
    }

    func testCommandLineQuotesHostilePathsAndForcesTheHeadlessBackend() {
        let client = LocalPythonSandboxClient(
            executor: StubExecutor(),
            scratchRootURL: scratchRoot,
            pythonExecutablePath: "/usr/bin/python3"
        )

        let line = client.commandLine(
            runDirectory: URL(fileURLWithPath: "/tmp/a'b $(touch /tmp/pwned)")
        )

        XCTAssertEqual(
            line,
            "cd '/tmp/a'\\''b $(touch /tmp/pwned)' && MPLBACKEND=Agg '/usr/bin/python3' '__juno_bootstrap__.py'"
        )
        // Defence in depth: the shared classifier must also not refuse it, or
        // the fallback would fail before it ever reached the interpreter.
        if case .forbidden = CommandClassifier().classify(line) {
            XCTFail("The local fallback command must be runnable")
        }
    }

    func testSafeFileNameRules() {
        XCTAssertTrue(LocalPythonSandboxClient.isSafeFileName("data.csv"))
        XCTAssertFalse(LocalPythonSandboxClient.isSafeFileName(""))
        XCTAssertFalse(LocalPythonSandboxClient.isSafeFileName("."))
        XCTAssertFalse(LocalPythonSandboxClient.isSafeFileName(".."))
        XCTAssertFalse(LocalPythonSandboxClient.isSafeFileName("a/b"))
        XCTAssertFalse(LocalPythonSandboxClient.isSafeFileName(".ssh"))
    }

    private func soleRunDirectory() -> URL? {
        soleDirectory(in: scratchRoot)
    }
}

/// Free functions so the stub executor's `@Sendable` side effect never captures
/// the (non-`Sendable`) `XCTestCase` instance.
private func soleDirectory(in root: URL) -> URL? {
    (try? FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: nil
    ))?.first
}

private let onePixelPNG = Data(
    base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)!

// MARK: - Scratch layout and bootstrap

final class SandboxScratchLayoutTests: XCTestCase {
    func testRoleClassification() {
        XCTAssertEqual(SandboxScratchLayout.role(ofRelativePath: "main.py"), .harnessArtifact)
        XCTAssertEqual(
            SandboxScratchLayout.role(ofRelativePath: "__juno_bootstrap__.py"),
            .harnessArtifact
        )
        XCTAssertEqual(
            SandboxScratchLayout.role(ofRelativePath: "__pycache__/main.pyc"),
            .harnessArtifact
        )
        XCTAssertEqual(
            SandboxScratchLayout.role(ofRelativePath: "__juno_charts__/figure-1.png"),
            .chart
        )
        XCTAssertEqual(SandboxScratchLayout.role(ofRelativePath: "out.csv"), .generatedFile)
        // A nested `main.py` belongs to the script's own package, not to Juno.
        XCTAssertEqual(SandboxScratchLayout.role(ofRelativePath: "pkg/main.py"), .generatedFile)
    }

    func testBootstrapForcesHeadlessRenderingAndCapturesOnExit() {
        let source = PythonSandboxBootstrap.source()

        XCTAssertTrue(source.contains(#"_juno_matplotlib.use("Agg", force=True)"#))
        XCTAssertTrue(source.contains("_juno_atexit.register(_juno_capture_figures)"))
        XCTAssertTrue(source.contains("get_fignums()"))
        XCTAssertTrue(source.contains(#"run_path(_juno_script, run_name="__main__")"#))
        // Nothing in the launcher may reach the network; that is the sandbox's
        // job to prevent, but the launcher must not be the one asking.
        XCTAssertFalse(source.contains("urllib"))
        XCTAssertFalse(source.contains("socket"))
    }

    func testChartSnifferAndMediaTypesRefuseToGuess() {
        XCTAssertEqual(SandboxChartSniffer.format(of: Data([0xFF, 0xD8, 0xFF, 0x00])), .jpeg)
        XCTAssertEqual(
            SandboxChartSniffer.format(of: Data("<svg xmlns='x'></svg>".utf8)),
            .svg
        )
        XCTAssertNil(SandboxChartSniffer.format(of: Data("hello".utf8)))
        XCTAssertNil(SandboxChartSniffer.figureNumber(inFileNamed: "plot.png"))
        XCTAssertEqual(SandboxChartSniffer.figureNumber(inFileNamed: "figure-12.png"), 12)
        // Zero is not a Matplotlib figure number, so it is not accepted as one.
        XCTAssertNil(SandboxChartSniffer.figureNumber(inFileNamed: "figure-0.png"))
        XCTAssertNil(SandboxMediaType.forFileName("mystery.qqq"))
        XCTAssertEqual(SandboxMediaType.forFileName("a.parquet"), "application/vnd.apache.parquet")
    }
}

// MARK: - Test doubles

/// Stands in for `CommandExecutionService`. The side effect runs at the point a
/// real interpreter would have, so the harvester sees files appear exactly when
/// it would in production.
private actor StubExecutor: CommandExecuting {
    private let result: CommandResult
    private let stdout: String
    private let stderr: String
    private var sideEffect: (@Sendable () -> Void)?
    private(set) var commandLines: [String] = []

    init(
        result: CommandResult = CommandResult(
            exitCode: 0,
            wasTimeout: false,
            wasCancelled: false,
            wasTruncated: false,
            durationSeconds: 0.1
        ),
        stdout: String = "",
        stderr: String = ""
    ) {
        self.result = result
        self.stdout = stdout
        self.stderr = stderr
    }

    func setSideEffect(_ sideEffect: @escaping @Sendable () -> Void) {
        self.sideEffect = sideEffect
    }

    nonisolated func stream(
        _ commandLine: String,
        timeoutSeconds: Double,
        outputLimit: OutputLimit
    ) -> AsyncThrowingStream<CommandEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                await self.record(commandLine)
                await self.sideEffect?()
                let (result, stdout, stderr) = await self.outputs
                if !stdout.isEmpty { continuation.yield(.stdout(stdout)) }
                if !stderr.isEmpty { continuation.yield(.stderr(stderr)) }
                continuation.yield(.completed(result))
                continuation.finish()
            }
        }
    }

    private func record(_ commandLine: String) {
        commandLines.append(commandLine)
    }

    private var outputs: (CommandResult, String, String) {
        (result, stdout, stderr)
    }
}
