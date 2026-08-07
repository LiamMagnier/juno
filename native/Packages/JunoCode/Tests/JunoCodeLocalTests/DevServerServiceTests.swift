import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeLocal

final class DevServerServiceTests: XCTestCase {
    private var workspaceURL: URL!

    override func setUpWithError() throws {
        workspaceURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-preview-service-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: workspaceURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: workspaceURL)
    }

    private func collectEvents(
        from service: DevServerService,
        command: String
    ) async -> [DevServerEvent] {
        var events: [DevServerEvent] = []
        for await event in service.start(command: command, workspaceRoot: workspaceURL) {
            events.append(event)
        }
        return events
    }

    private func collectUntilRunningThenStop(
        from service: DevServerService,
        command: String
    ) async -> [DevServerEvent] {
        var events: [DevServerEvent] = []
        var iterator = service.start(command: command, workspaceRoot: workspaceURL)
            .makeAsyncIterator()
        while let event = await iterator.next() {
            events.append(event)
            if case .state(.running) = event {
                service.stop()
            }
        }
        return events
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    func testEmptyCommandFailsWithoutStartingAProcess() async {
        let service = DevServerService()

        let events = await collectEvents(from: service, command: " \n\t ")

        XCTAssertEqual(events, [.state(.failed(reason: "No command to run."))])
        XCTAssertFalse(service.isRunning)
        XCTAssertNil(service.runningCommand)
    }

    func testForbiddenCommandIsRefusedBeforeLaunching() async {
        let service = DevServerService()

        let events = await collectEvents(from: service, command: "sudo id")

        XCTAssertEqual(
            events,
            [.state(.failed(reason: "'sudo' is never run by the agent."))]
        )
        XCTAssertFalse(service.isRunning)
    }

    func testShortLivedOutputIsSanitizedRedactedAndUsedForURLDetection() async throws {
        let service = DevServerService()
        let token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
        let command = "printf '%b\\n' '\\033[36mLocal: http://0.0.0.0:4567/ token=\(token)\\033[0m'"

        let events = await collectEvents(from: service, command: command)

        XCTAssertTrue(events.contains(.state(.starting)))
        XCTAssertFalse(events.contains { event in
            if case .state(.running) = event { return true }
            return false
        }, "a printed URL is not readiness without a live HTTP server")
        XCTAssertEqual(events.last, .state(.exited(code: 0)))

        let lines = events.compactMap { event -> DevServerLogLine? in
            guard case let .line(line) = event else { return nil }
            return line
        }
        let line = try XCTUnwrap(lines.first)
        XCTAssertTrue(line.text.contains("Local: http://0.0.0.0:4567/"))
        XCTAssertTrue(line.text.contains(SecretRedactor.placeholder))
        XCTAssertFalse(line.text.contains(token))
    }

    func testURLWithoutTrailingNewlineIsStillRecordedBeforeExit() async {
        let service = DevServerService()

        let events = await collectEvents(
            from: service,
            command: "printf 'stdout fragment'; printf 'Local: http://127.0.0.1:4568/' >&2"
        )

        let lines = events.compactMap { event -> DevServerLogLine? in
            guard case let .line(line) = event else { return nil }
            return line
        }
        XCTAssertTrue(lines.contains { $0.text == "stdout fragment" })
        XCTAssertTrue(lines.contains { $0.text.contains("http://127.0.0.1:4568/") })
        XCTAssertTrue(
            events.contains(.state(.exited(code: 0))),
            "a server that printed a usable URL before exiting must not be reported as a launch failure"
        )
        XCTAssertFalse(events.contains { event in
            if case .state(.failed) = event { return true }
            return false
        })
    }

    func testCRLFOutputIsNormalizedBeforeItReachesTheLogOrDetector() async {
        let service = DevServerService()

        let events = await collectEvents(
            from: service,
            command: "printf 'Local: http://127.0.0.1:4569/\\r\\n'"
        )

        let lines = events.compactMap { event -> DevServerLogLine? in
            guard case let .line(line) = event else { return nil }
            return line
        }
        let line = lines.first { $0.text.contains("http://127.0.0.1:4569/") }
        XCTAssertEqual(
            line?.text,
            "Local: http://127.0.0.1:4569/",
            "lines: \(lines.map(\.text))"
        )
        XCTAssertFalse(line?.text.contains("\r") == true)
        XCTAssertFalse(events.contains { event in
            if case .state(.running) = event { return true }
            return false
        })
    }

    func testRunningRequiresAResponseFromTheLiveProcess() async {
        let service = DevServerService()
        let command = "python3 -u -c 'import http.server,socketserver; s=socketserver.TCPServer((\"127.0.0.1\",0),http.server.SimpleHTTPRequestHandler); print(\"Local: http://127.0.0.1:%d/\" % s.server_address[1],flush=True); s.serve_forever()'"

        let events = await collectUntilRunningThenStop(from: service, command: command)

        XCTAssertTrue(events.contains(.state(.starting)))
        XCTAssertTrue(
            events.contains {
                if case .state(.running) = $0 { return true }
                return false
            },
            "the running state should be emitted only after the local HTTP server responds"
        )
        XCTAssertEqual(events.last, .state(.stopped))
    }

    func testReplacementWaitsForPreviousGroupCleanupAndFinishesItOnce() async {
        let service = DevServerService()
        let markerURL = workspaceURL.appendingPathComponent("descendant-cleaned")
        let marker = shellQuote(markerURL.path)
        let firstStream = service.start(
            command: "(sleep 1; touch \(marker)) & printf 'first\\n'",
            workspaceRoot: workspaceURL
        )
        var firstIterator = firstStream.makeAsyncIterator()
        let firstEvent = await firstIterator.next()
        XCTAssertEqual(firstEvent, .state(.starting))
        try? await Task.sleep(for: .milliseconds(100))

        let replacementStartedAt = Date()
        _ = await collectEvents(from: service, command: "printf 'replacement\\n'")
        let replacementElapsed = Date().timeIntervalSince(replacementStartedAt)

        var firstEvents: [DevServerEvent] = []
        while let event = await firstIterator.next() {
            firstEvents.append(event)
        }
        try? await Task.sleep(for: .milliseconds(1_200))
        XCTAssertTrue(
            !FileManager.default.fileExists(atPath: markerURL.path),
            "replacement must clean the previous descendant; events=\(firstEvents)"
        )
        XCTAssertLessThan(replacementElapsed, 3.5)

        let terminalStates = firstEvents.compactMap { event -> DevServerState? in
            guard case let .state(state) = event,
                  !state.isLive
            else { return nil }
            return state
        }
        XCTAssertEqual(terminalStates.count, 1, "a run must finish exactly once")
    }

    func testServerEnvironmentUsesAStableScrubbedPreviewEnvironment() {
        setenv("JUNO_TEST_SECRET_TOKEN", "must-not-leak", 1)
        defer { unsetenv("JUNO_TEST_SECRET_TOKEN") }

        let environment = DevServerService.serverEnvironment(workspaceRoot: workspaceURL.path)

        XCTAssertEqual(
            environment["PATH"],
            "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
        )
        XCTAssertEqual(environment["PWD"], workspaceURL.path)
        XCTAssertEqual(environment["BROWSER"], "none")
        XCTAssertEqual(environment["FORCE_COLOR"], "0")
        XCTAssertEqual(environment["NO_COLOR"], "1")
        XCTAssertEqual(environment["TERM"], "dumb")
       XCTAssertNil(environment["JUNO_TEST_SECRET_TOKEN"])
   }

    func testContainedFactoryReportsTheActualKernelBoundary() {
        let service = DevServerService.contained(workspaceRootURL: workspaceURL)
        XCTAssertEqual(service.isContained, CommandSandboxProfile.isAvailable)
    }

    func testFailureReasonExplainsMissingToolsWhenTheScrubbedPathIsLikely() {
        let reason = DevServerService.failureReason(
            exitCode: 127,
            wasSignal: false,
            recent: ["zsh: vite: command not found"]
        )

        XCTAssertTrue(reason.contains("Exited with code 127 without serving an address."))
        XCTAssertTrue(reason.contains("zsh: vite: command not found"))
        XCTAssertTrue(reason.contains("scrubbed PATH"))
    }
}
