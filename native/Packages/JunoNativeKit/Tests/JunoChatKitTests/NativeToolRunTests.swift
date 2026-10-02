import Foundation
import SwiftUI
import XCTest
@testable import JunoChatKit

#if canImport(AppKit)
import AppKit
#endif

/// A real run on macOS and iOS (TOOL_RUNTIME_DESIGN.md §6.12): tolerant
/// decoding of `call.run` (files, exit, streams) and `call.progress`, the
/// `outcome_unknown` status, the same words as the web
/// (`tests/tool-run-presentation.test.ts`), and offscreen snapshots of the
/// run detail with its file cards at the Mac panel and the iPhone widths.
///
/// The JSON below is the wire the web fixtures describe
/// (`src/lib/chat/tool-run-fixtures.ts`).
final class NativeToolRunTests: XCTestCase {
    private func decode(_ json: String) throws -> NativeToolCall {
        let wire = try JSONDecoder().decode(NativeActivityWire.self, from: Data(json.utf8))
        let activity = try XCTUnwrap(wire.activity(parseDate: { _ in nil }))
        return try XCTUnwrap(activity.call)
    }

    private func row(_ call: String) -> String {
        #"{"id":"r","kind":"tool","title":"Using Code","detail":"run_code","createdAt":"2026-10-02T09:00:00.000Z","call":"# + call + "}"
    }

    private let running = #"""
    {"callId":"toolu_1","tool":"run_code","status":"running","timeoutMs":600000,"args":{"language":"python"},
     "run":{"context":"hosted_sandbox","runId":"run_01","language":"python","code":"print(1)"},
     "progress":{"seq":3,"lines":["region","North    18240.50","South    21877.10"],"stdoutBytes":512,"stderrBytes":0}}
    """#

    private let succeeded = #"""
    {"callId":"toolu_2","tool":"run_code","status":"succeeded","durationMs":2412,"args":{"language":"python"},
     "run":{"context":"hosted_sandbox","runId":"run_02","status":"succeeded","language":"python","exitCode":0,"durationMs":2412,
      "code":"import pandas as pd\nprint(pd.__version__)","stdout":{"head":"region\nWest     24410.75","omittedBytes":0},
      "files":[{"attachmentId":"att_chart","name":"chart.png","mime":"image/png","bytes":48211,"url":"/api/files/k1"},
               {"attachmentId":"att_summary","name":"summary.csv","mime":"text/csv","bytes":96,"url":"/api/files/k2"},
               {"name":"evil.html","mime":"text/html","url":"https://example.com/x"},
               {"mime":"text/plain"}]}}
    """#

    private let failed = #"""
    {"callId":"toolu_3","tool":"run_code","status":"failed","durationMs":1108,"error":{"code":"tool_error","detail":"KeyError: 'Region'"},
     "args":{"language":"python"},
     "run":{"context":"hosted_sandbox","status":"failed","language":"python","exitCode":1,"durationMs":1108,"code":"df['Region']",
      "stderr":{"head":"Traceback (most recent call last):","tail":"KeyError: 'Region'","omittedBytes":2310,"totalBytes":2480},
      "logUrl":"/api/tool-runs/run_03/log"}}
    """#

    // MARK: Decoding

    func testARunningCallCarriesItsProgressAndContext() throws {
        let call = try decode(row(running))
        XCTAssertEqual(call.status, .running)
        XCTAssertEqual(call.run?.context, .hostedSandbox)
        XCTAssertEqual(call.progress?.seq, 3)
        XCTAssertEqual(call.progress?.lines.last, "South    21877.10")
        XCTAssertEqual(NativeToolRunPresentation.label(call), "Running Python")
        XCTAssertEqual(NativeToolPresentation.phrase(call), "Running Python")
        XCTAssertEqual(NativeToolRunPresentation.contextLine(call), "Running in Alevr's sandbox: no internet, no access to your Mac")
    }

    func testFilesDecodeWithSameOriginLinksOnly() throws {
        let call = try decode(row(succeeded))
        XCTAssertEqual(call.status, .succeeded)
        XCTAssertEqual(call.run?.files.map(\.name), ["chart.png", "summary.csv", "evil.html"])
        XCTAssertEqual(call.run?.files.map(\.path), ["/api/files/k1", "/api/files/k2", nil])
        XCTAssertEqual(call.run?.files.first?.isImage, true)
        XCTAssertEqual(NativeToolRunPresentation.label(call), "Ran Python")
        XCTAssertEqual(NativeToolRunPresentation.figure(call), "3 files")
        XCTAssertEqual(NativeToolRunPresentation.exitLine(call), "Exit code 0 · 2s")
    }

    func testAFailureSaysWhyWithItsExitCode() throws {
        let call = try decode(row(failed))
        XCTAssertEqual(call.status, .failed)
        XCTAssertEqual(NativeToolRunPresentation.label(call), "Python failed")
        XCTAssertEqual(NativeToolRunPresentation.figure(call), "exit 1")
        XCTAssertEqual(NativeToolPresentation.phrase(call), "Python failed")
        XCTAssertEqual(NativeToolPresentation.figure(call), "exit 1", "the exit rides the figure slot")
        XCTAssertEqual(NativeToolRunPresentation.reason(call), "KeyError: 'Region'")
        XCTAssertEqual(call.run.flatMap { $0.stderr }.flatMap(NativeToolRunPresentation.omittedNote), "2.3 KB not shown")
        XCTAssertEqual(call.run?.logPath, "/api/tool-runs/run_03/log")
        XCTAssertTrue(NativeToolRunPresentation.canRunAgain(call))
        XCTAssertEqual(NativeToolRunPresentation.announcement(call), "Python failed, exit code 1.")
    }

    func testOutcomeUnknownIsTerminalNeverASuccessAndNeverRerun() throws {
        let byCall = try decode(row(#"{"callId":"c","tool":"run_code","status":"outcome_unknown","args":{"language":"python"}}"#))
        let byRun = try decode(row(#"{"callId":"c","tool":"run_code","status":"running","run":{"status":"outcome_unknown","language":"python"}}"#))
        for call in [byCall, byRun] {
            XCTAssertEqual(call.status, .outcomeUnknown)
            XCTAssertTrue(call.status.isTerminal)
            XCTAssertFalse(call.status.isActive)
            XCTAssertEqual(NativeToolRunPresentation.summary(call), "Outcome unknown, the server restarted while this ran")
            XCTAssertTrue(NativeToolPresentation.readsAsFailure(call))
            XCTAssertTrue(NativeToolRunPresentation.runAgainDraft(call).contains("as a new run"))
        }
    }

    func testTimedOutStoppedAndUnavailableSayWhatHappened() throws {
        let timedOut = try decode(row(#"{"callId":"c","tool":"run_code","status":"failed","error":{"code":"timeout"},"timeoutMs":120000,"run":{"status":"timed_out","language":"python"}}"#))
        XCTAssertEqual(NativeToolRunPresentation.label(timedOut), "Timed out after 2 min")
        XCTAssertEqual(timedOut.errorCode, "timeout")
        let stopped = try decode(row(#"{"callId":"c","tool":"run_code","status":"cancelled","error":{"code":"cancelled"},"run":{"status":"cancelled","language":"python","filesDiscarded":1}}"#))
        XCTAssertEqual(NativeToolRunPresentation.label(stopped), "Stopped")
        XCTAssertEqual(NativeToolRunPresentation.reason(stopped), "You stopped this run. Files it made were not kept.")
        let down = try decode(row(#"{"callId":"c","tool":"run_code","status":"failed","error":{"code":"unavailable"},"args":{"language":"python"}}"#))
        XCTAssertEqual(NativeToolRunPresentation.label(down), "Couldn't run Python")
        XCTAssertEqual(NativeToolRunPresentation.reason(down), "The sandbox isn't available right now, so nothing ran.")
    }

    func testANonZeroExitUnderSucceededIsBelievedAsAFailure() throws {
        let call = try decode(row(#"{"callId":"c","tool":"run_code","status":"succeeded","run":{"status":"succeeded","exitCode":2,"language":"bash"}}"#))
        XCTAssertEqual(call.status, .failed)
        XCTAssertEqual(NativeToolRunPresentation.label(call), "Shell script failed")
    }

    func testSkillsReadAsSkills() throws {
        let read = try decode(row(#"{"callId":"c","tool":"use_skill","status":"running","args":{"name":"quarterly-summary"}}"#))
        XCTAssertEqual(NativeToolPresentation.phrase(read), "Reading the quarterly-summary skill")
        XCTAssertEqual(NativeToolPresentation.iconName(read), "skills")
        let file = try decode(row(#"{"callId":"c","tool":"read_skill_file","status":"succeeded","args":{"skill":"quarterly-summary","path":"reference/style.md"}}"#))
        XCTAssertEqual(NativeToolPresentation.phrase(file), "Read reference/style.md from the quarterly-summary skill")
    }

    /// A newer server's run record: unknown keys, wrong types, a broken file
    /// entry. Each costs its own field; the call and the rest survive.
    func testAMalformedRunRecordCostsOnlyItsBrokenFields() throws {
        let call = try decode(row(#"""
        {"callId":"c","tool":"run_code","status":"succeeded",
         "run":{"exitCode":"zero","language":42,"context":"mars","files":[7,{"name":"ok.csv","mime":"text/csv"}],
                "stdout":12,"futureField":{"x":1}},
         "progress":"garbage"}
        """#))
        XCTAssertEqual(call.status, .succeeded)
        XCTAssertNil(call.run?.exitCode)
        XCTAssertNil(call.run?.language)
        XCTAssertNil(call.run?.context)
        XCTAssertEqual(call.run?.files.map(\.name), ["ok.csv"])
        XCTAssertNil(call.progress)
    }

    func testTheLegacyCodeInterpreterRowStillReadsAsPython() {
        let rows = [
            NativeChatActivity(
                id: "legacy", kind: .tool, title: "Using Code", detail: "code_interpreter", url: nil, createdAt: nil,
                seq: nil, call: nil, segment: nil, commentary: nil,
                tool: NativeToolDetail(server: "Code", name: "code_interpreter", args: "{}", result: "42", status: "ok", durationMs: 900)
            ),
            NativeChatActivity(
                id: "cut", kind: .tool, title: "Using Code", detail: "code_interpreter", url: nil, createdAt: nil,
                seq: nil, call: nil, segment: nil, commentary: nil,
                tool: NativeToolDetail(server: "Code", name: "code_interpreter", resultNote: "unfinished")
            ),
        ]
        let view = NativeRunView.build(activity: rows, reasoning: nil, reasoningParts: nil)
        XCTAssertEqual(view.calls.map(\.tool), ["run_code", "run_code"])
        XCTAssertEqual(view.calls.map(\.status), [.succeeded, .outcomeUnknown])
        XCTAssertEqual(NativeToolPresentation.phrase(view.calls[0]), "Ran Python")
        // The legacy row never returned because the reply ended; no server
        // said it restarted (the web says the same sentence).
        XCTAssertEqual(NativeToolRunPresentation.summary(view.calls[1]), "Outcome unknown, the reply ended before this run reported back")
        XCTAssertTrue(NativeToolRunPresentation.reason(view.calls[1])?.hasPrefix("The reply ended before this run reported back") == true)
    }

    func testRunFilesCountAsFilesCreated() throws {
        let call = try decode(row(succeeded))
        let view = NativeRunView.build(
            activity: [NativeChatActivity(id: "r", kind: .tool, title: "Using Code", detail: "run_code", url: nil, createdAt: nil, seq: 1, call: call, segment: nil, commentary: nil, tool: nil)],
            reasoning: nil,
            reasoningParts: nil
        )
        XCTAssertEqual(view.counts.codeRuns, 1)
        XCTAssertEqual(view.counts.filesCreated, 3)
    }

    // MARK: Adversarial reads (L4 review, 2026-10-02)

    /// `/\host` and a tab inside the path resolve to another host in a URL
    /// parser; an attachment id is one encoded segment, never a climb.
    func testOnlySameOriginPathsSurviveBackslashAndControlTricks() throws {
        for bad in ["/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example", "//evil.example", "https://evil.example", "/a\\b"] {
            XCTAssertNil(NativeToolRunWire.path(.string(bad)), bad)
        }
        XCTAssertEqual(NativeToolRunWire.path(.string("/api/files/k1")), "/api/files/k1")
        XCTAssertEqual(NativeToolRunWire.attachmentPath("att_1"), "/api/attachments/att_1")
        XCTAssertEqual(NativeToolRunWire.attachmentPath("../files/x"), "/api/attachments/%2E%2E%2Ffiles%2Fx")

        let call = try decode(row(#"""
        {"callId":"c","tool":"run_code","status":"succeeded",
         "run":{"status":"succeeded","exitCode":0,"logUrl":"/\\evil.example/log",
                "files":[{"attachmentId":"../files/secret","name":"a.png","mime":"image/png","url":"/\\evil.example/a.png"}]}}
        """#))
        XCTAssertNil(call.run?.logPath)
        XCTAssertEqual(call.run?.files.first?.path, "/api/attachments/%2E%2E%2Ffiles%2Fsecret")
    }

    /// A program that prints 60,000 newlines must not become a 60,000-line
    /// `Text`; what is not drawn is counted as not shown.
    func testFloodedOutputIsCutForDisplayAndTheCutIsCounted() throws {
        let flood = String(repeating: "\\n", count: 60_000)
        let program = String(repeating: "x\\n", count: 5_000)
        let json = #"{"callId":"c","tool":"run_code","status":"succeeded","run":{"status":"succeeded","exitCode":0,"code":""#
            + program + #"","stdout":{"head":""# + flood + #"","tail":""# + flood + #"","omittedBytes":10}}}"#
        let call = try decode(row(json))
        let stdout = try XCTUnwrap(call.run?.stdout)
        XCTAssertLessThanOrEqual(stdout.head.split(separator: "\n", omittingEmptySubsequences: false).count, NativeToolRunWire.streamPartMaxLines)
        XCTAssertLessThanOrEqual((stdout.tail ?? "").split(separator: "\n", omittingEmptySubsequences: false).count, NativeToolRunWire.streamPartMaxLines + 1)
        XCTAssertGreaterThan(stdout.omittedBytes, 100_000)
        XCTAssertNotNil(NativeToolRunPresentation.omittedNote(stdout))
        XCTAssertLessThanOrEqual((call.run?.code ?? "").split(separator: "\n", omittingEmptySubsequences: false).count, NativeToolRunWire.codeMaxLines + 1)
        XCTAssertEqual(call.run?.codeTruncated, true)
    }

    /// The execution runtime's own spellings (ExecRunFacts) read the same.
    func testTheExecutionRuntimesSpellingsDecode() throws {
        let call = try decode(row(#"{"callId":"c","tool":"run_code","status":"succeeded","run":{"status":"succeeded","exitCode":0,"finishedLate":true,"skillSlug":"quarterly-summary","skippedFiles":[{"name":"big.bin"}]}}"#))
        XCTAssertEqual(call.run?.finishedLater, true)
        XCTAssertEqual(call.run?.skillName, "quarterly-summary")
        XCTAssertEqual(call.run?.filesDiscarded, 1)
    }

    /// The image route serves PNG, JPEG, WebP and GIF only; any other image
    /// type is a FILE there, so no link is invented for it.
    func testOnlyServableImagesGetTheImageRoute() throws {
        let call = try decode(row(#"""
        {"callId":"c","tool":"run_code","status":"succeeded",
         "run":{"status":"succeeded","exitCode":0,"files":[
           {"attachmentId":"att_png","name":"chart.png","mime":"image/png","kind":"IMAGE"},
           {"attachmentId":"att_tif","name":"scan.tiff","mime":"image/tiff","kind":"FILE"},
           {"attachmentId":"att_bmp","name":"old.bmp","mime":"image/bmp"},
           {"attachmentId":"att_odd","name":"odd.png","mime":"image/png","kind":"FILE"}]}}
        """#))
        XCTAssertEqual(call.run?.files.map(\.path), ["/api/attachments/att_png", nil, nil, nil])
    }

    /// Names a person reads carry no direction overrides or control characters.
    func testNamesCarryNoDirectionOverrides() throws {
        let call = try decode(row(#"""
        {"callId":"c","tool":"run_code","status":"succeeded",
         "run":{"status":"succeeded","exitCode":0,"agentName":"Ada\u202e","skillSlug":"q\u202es",
                "files":[{"name":"report\u202efdp.exe","mime":"application/pdf"}]}}
        """#))
        XCTAssertEqual(call.run?.files.first?.name, "reportfdp.exe")
        XCTAssertEqual(call.run?.agentName, "Ada")
        XCTAssertEqual(call.run?.skillName, "qs")
        XCTAssertEqual(NativeToolRunWire.named(.string("a\nb\u{7}c"), max: 50), "a bc")
    }

    func testNoStringCarriesAnEmDash() throws {
        for json in [running, succeeded, failed] {
            let call = try decode(row(json))
            for text in [NativeToolRunPresentation.label(call), NativeToolRunPresentation.summary(call), NativeToolRunPresentation.announcement(call),
                         NativeToolRunPresentation.contextLine(call) ?? "", NativeToolRunPresentation.reason(call) ?? ""] {
                XCTAssertFalse(text.contains("\u{2014}"), text)
            }
        }
    }

    // MARK: The tool contract's shape (fields on the `tool` detail)

    private func legacyCall(_ tool: String) throws -> NativeToolCall {
        let json = #"{"id":"r","kind":"tool","title":"Using Code","detail":"run_code","createdAt":"2026-10-02T09:00:00.000Z","tool":"# + tool + "}"
        let wire = try JSONDecoder().decode(NativeActivityWire.self, from: Data(json.utf8))
        let activity = try XCTUnwrap(wire.activity(parseDate: { _ in nil }))
        let view = NativeRunView.build(activity: [activity], reasoning: nil, reasoningParts: nil)
        return try XCTUnwrap(view.calls.first)
    }

    /// rf/tools-L1-tool-contract carries the run on `ClientToolDetail`: the
    /// live `phase`, `progress` lines as `{ stream, text }`, the typed
    /// `outcome` and `errorCode`, and `run` with files that have no link.
    func testTheToolContractShapeOnTheDetailDecodes() throws {
        let running = try legacyCall(#"""
        {"server":"Code","name":"run_code","args":"{\"language\":\"python\",\"code\":\"print(1)\"}","resultNote":"pending",
         "callId":"jc_1_0","phase":"running","timeoutMs":600000,
         "progress":{"lines":[{"stream":"stdout","text":"region"},{"stream":"stderr","text":"warning: 2 rows dropped"}],"stdoutBytes":512},
         "run":{"runId":"run_c1","context":"hosted_sandbox","language":"python","status":"running","files":[]}}
        """#)
        XCTAssertEqual(running.status, .running)
        XCTAssertEqual(running.timeoutMs, 600_000)
        XCTAssertEqual(running.progress?.lines, ["region", "warning: 2 rows dropped"])
        XCTAssertEqual(NativeToolPresentation.phrase(running), "Running Python")

        let succeeded = try legacyCall(#"""
        {"server":"Code","name":"run_code","status":"ok","durationMs":2412,"outcome":"succeeded","result":"exit 0",
         "run":{"runId":"run_c2","context":"hosted_sandbox","language":"python","status":"succeeded","exitCode":0,"durationMs":2412,
                "files":[{"attachmentId":"att_chart","name":"chart.png","mime":"image/png","bytes":48211},
                         {"attachmentId":"att_csv","name":"summary.csv","mime":"text/csv","bytes":96}]}}
        """#)
        XCTAssertEqual(succeeded.status, .succeeded)
        XCTAssertEqual(succeeded.run?.files.map(\.path), ["/api/attachments/att_chart", nil])
        XCTAssertEqual(NativeToolPresentation.phrase(succeeded), "Ran Python")
        XCTAssertEqual(NativeToolPresentation.figure(succeeded), "2 files")

        let unknown = try legacyCall(#"""
        {"server":"Code","name":"run_code","status":"failed","outcome":"outcome_unknown","errorCode":"outcome_unknown",
         "args":"{\"language\":\"bash\"}","run":{"runId":"run_c3","context":"hosted_sandbox","language":"bash","status":"outcome_unknown","files":[]}}
        """#)
        XCTAssertEqual(unknown.status, .outcomeUnknown, "a failure carrying outcome_unknown is unknown, never a failure")
        XCTAssertEqual(NativeToolRunPresentation.summary(unknown), "Outcome unknown, the server restarted while this ran")

        let timedOut = try legacyCall(#"""
        {"server":"Code","name":"run_code","status":"failed","outcome":"failed","errorCode":"timeout","timeoutMs":120000,
         "run":{"runId":"run_c4","context":"hosted_sandbox","language":"bash","status":"timed_out","files":[]}}
        """#)
        XCTAssertEqual(timedOut.status, .failed)
        XCTAssertEqual(timedOut.errorCode, "timeout")
        XCTAssertEqual(NativeToolRunPresentation.label(timedOut), "Timed out after 2 min")
    }

    /// The SPEC record's way of saying it: status failed, error.code outcome_unknown.
    func testTheTypedRecordsOutcomeUnknownCodeIsUnknown() throws {
        let call = try decode(row(#"{"callId":"c","tool":"run_code","status":"failed","error":{"code":"outcome_unknown"},"args":{"language":"python"}}"#))
        XCTAssertEqual(call.status, .outcomeUnknown)
    }

    // MARK: Snapshots

    /// The run detail and its file cards, offscreen, at the Mac Activity panel
    /// width and the iPhone width, light and dark. Written to
    /// `JUNO_SNAPSHOT_DIR/tool-runs` when set; always asserted to render.
    @MainActor
    func testTheRunDetailRendersAtMacAndPhoneWidths() throws {
        #if canImport(AppKit)
        let calls = [("succeeded", try decode(row(succeeded))), ("failed", try decode(row(failed))), ("running", try decode(row(running)))]
        let directory = ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"].map { URL(fileURLWithPath: $0).appendingPathComponent("tool-runs") }
        if let directory { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        for (name, call) in calls {
            for (platform, width) in [("macos", 360.0), ("ios", 390.0)] {
                for scheme in [ColorScheme.light, .dark] {
                    let view = VStack(alignment: .leading, spacing: 6) {
                        Text(NativeToolPresentation.phrase(call)).font(.headline)
                        NativeToolRunDetailView(call: call, onOpenFile: { _ in }, onRunAgain: { _ in })
                    }
                    .padding(16)
                    .frame(width: width, alignment: .leading)
                    .background(scheme == .dark ? Color.black : Color.white)
                    .environment(\.colorScheme, scheme)
                    let renderer = ImageRenderer(content: view)
                    renderer.scale = 2
                    let image = try XCTUnwrap(renderer.cgImage, "\(name) \(platform) did not render")
                    XCTAssertEqual(image.width, Int(width * 2))
                    XCTAssertGreaterThan(image.height, 80)
                    if let directory {
                        let rep = NSBitmapImageRep(cgImage: image)
                        let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                        try data.write(to: directory.appendingPathComponent("\(name)-\(platform)-\(scheme == .dark ? "dark" : "light").png"))
                    }
                }
            }
        }
        #endif
    }
}
