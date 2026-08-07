import Foundation
import XCTest

@testable import JunoCodeLocal

#if canImport(Darwin)
import Darwin
#endif

final class NativeTerminalFoundationTests: XCTestCase {
    func testTranscriptRetainsOnlyNewestBytes() {
        var transcript = NativeTerminalTranscript(maximumBytes: 5)
        transcript.append(Data("abc".utf8))
        transcript.append(Data("defg".utf8))

        XCTAssertEqual(transcript.byteCount, 5)
        XCTAssertEqual(transcript.text, "cdefg")
        XCTAssertTrue(transcript.didTruncate)

        transcript.append(Data("0123456789".utf8))
        XCTAssertEqual(transcript.text, "56789")
        XCTAssertEqual(transcript.data.count, 5)
    }

    func testZeroSizedTranscriptDropsData() {
        var transcript = NativeTerminalTranscript(maximumBytes: 0)
        transcript.append(Data("discarded".utf8))

        XCTAssertEqual(transcript.byteCount, 0)
        XCTAssertEqual(transcript.text, "")
        XCTAssertTrue(transcript.didTruncate)
    }

    func testCommandConstructionIsExplicitAndDeterministic() throws {
        let command = try NativeTerminalCommand(
            executable: "/usr/bin/env",
            arguments: ["-i", "printf", "hello world"],
            environment: ["Z_LAST": "z", "A_FIRST": "a"],
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )

        XCTAssertEqual(command.argv, ["/usr/bin/env", "-i", "printf", "hello world"])
        XCTAssertEqual(command.environmentEntries, ["A_FIRST=a", "Z_LAST=z"])
    }

    func testCommandRejectsImplicitPathLookupAndEmbeddedNUL() throws {
        XCTAssertThrowsError(
            try NativeTerminalCommand(
                executable: "printf",
                workingDirectory: URL(fileURLWithPath: "/tmp")
            )
        ) { error in
            XCTAssertEqual(error as? NativeTerminalCommandError, .executableMustBeAbsolute)
        }

        XCTAssertThrowsError(
            try NativeTerminalCommand(
                executable: "/usr/bin/printf",
                arguments: ["bad\0argument"],
                workingDirectory: URL(fileURLWithPath: "/tmp")
            )
        ) { error in
            XCTAssertEqual(
                error as? NativeTerminalCommandError,
                .containsNUL(field: "argument")
            )
        }
    }

    // These integration cases genuinely require a live macOS forkpty and are
    // conditionally compiled only when Darwin is available; the model and
    // transcript tests above remain deterministic on every build host.
    #if canImport(Darwin)
    func testShortProcessEmitsBoundedChunksEOFAndStateTransitions() async throws {
        let command = try NativeTerminalCommand(
            executable: "/usr/bin/printf",
            arguments: ["ready\n"],
            environment: ["LANG": "C"],
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
        let session = NativeTerminalSession(
            limits: NativeTerminalLimits(
                maximumOutputBytes: 64,
                maximumTranscriptBytes: 32,
                maximumOutputChunkBytes: 4,
                maximumPendingEvents: 16
            )
        )
        let stream = try await session.start(command)
        var iterator = stream.makeAsyncIterator()
        var states: [NativeTerminalState] = []
        var output = Data()
        var sawEOF = false

        while let event = try await iterator.next() {
            switch event {
            case let .state(state):
                states.append(state)
            case let .output(data):
                XCTAssertLessThanOrEqual(data.count, 4)
                output.append(data)
            case .eof:
                sawEOF = true
            case .exited:
                break
            }
        }

        // A PTY's default output discipline expands LF to CRLF, just like a
        // real interactive terminal. Normalize it for the protocol assertion;
        // the terminal stream intentionally preserves the bytes it received.
        let normalizedOutput = String(decoding: output, as: UTF8.self)
            .replacingOccurrences(of: "\r\n", with: "\n")
        XCTAssertEqual(normalizedOutput, "ready\n")
        XCTAssertTrue(sawEOF)
        XCTAssertEqual(states.first, .starting)
        XCTAssertTrue(states.contains { if case .running = $0 { return true }; return false })
        XCTAssertTrue(states.contains { if case .exited = $0 { return true }; return false })
        let finalState = await session.state
        XCTAssertFalse(finalState.isRunning)
    }

    func testOutputAndTranscriptLimitsTerminateTheProcess() async throws {
        // Keep the child alive while the PTY drains. A short-lived `printf` can
        // exit between two PTY reads, and macOS may report EIO before the last
        // bytes that were written have become readable. That is a valid PTY
        // race, but it makes this test assert on scheduling rather than on the
        // output-limit contract. A bounded reader must stop a live producer at
        // exactly its configured byte budget.
        let payload = String(repeating: "x", count: 512)
        let command = try NativeTerminalCommand(
            executable: "/bin/sh",
            arguments: ["-c", "while :; do printf '%s' '\(payload)'; done"],
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
        let session = NativeTerminalSession(
            limits: NativeTerminalLimits(
                maximumOutputBytes: 64,
                maximumTranscriptBytes: 10,
                maximumOutputChunkBytes: 8,
                maximumPendingEvents: 8
            )
        )
        let stream = try await session.start(command)
        var iterator = stream.makeAsyncIterator()
        var outputBytes = 0
        var exit: NativeTerminalExit?

        while let event = try await iterator.next() {
            if case let .output(data) = event {
                XCTAssertLessThanOrEqual(data.count, 8)
                outputBytes += data.count
            }
            if case let .exited(value) = event { exit = value }
        }

        XCTAssertEqual(outputBytes, 64)
        let transcriptData = await session.transcriptData
        let transcript = await session.transcript
        XCTAssertEqual(transcriptData.count, 10)
        XCTAssertEqual(transcript, String(repeating: "x", count: 10))
        XCTAssertEqual(exit?.reason, .outputLimit)
    }

    func testInteractiveInputResizeAndTerminateUseTheProcessGroup() async throws {
        let command = try NativeTerminalCommand(
            executable: "/bin/cat",
            environment: ["TERM": "xterm"],
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
        let session = NativeTerminalSession()
        let stream = try await session.start(command)
        var iterator = stream.makeAsyncIterator()

        while let event = try await iterator.next() {
            if case .state(.running) = event { break }
        }
        try await session.resize(to: NativeTerminalSize(columns: 80, rows: 24))
        try await session.write("hello\n")

        var receivedInput = false
        while let event = try await iterator.next() {
            if case let .output(data) = event,
               String(decoding: data, as: UTF8.self).contains("hello") {
                receivedInput = true
                break
            }
        }
        XCTAssertTrue(receivedInput)

        try await session.interrupt()
        try await session.terminate()
        let finalState = await session.state
        XCTAssertFalse(finalState.isRunning)
    }

    func testCancelledWaitCleansUpTheChildProcessGroup() async throws {
        let command = try NativeTerminalCommand(
            executable: "/bin/sh",
            arguments: ["-c", "sleep 30"],
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
        let session = NativeTerminalSession()
        let stream = try await session.start(command)
        var iterator = stream.makeAsyncIterator()
        var processID: Int32?
        while let event = try await iterator.next() {
            if case let .state(.running(pid)) = event {
                processID = pid
                break
            }
        }
        let waiter = Task {
            try await session.waitForExit()
        }
        try await Task.sleep(nanoseconds: 30_000_000)
        waiter.cancel()

        let waiterResult = await waiter.result
        if case .success = waiterResult {
            XCTFail("A cancelled exit waiter unexpectedly succeeded")
        }
        _ = try await session.terminate()
        let finalState = await session.state
        XCTAssertFalse(finalState.isRunning)

        if let processID {
            XCTAssertEqual(kill(processID, 0), -1)
            XCTAssertEqual(errno, ESRCH)
        }
    }
    #endif
}
