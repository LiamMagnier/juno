import Foundation
import XCTest
@testable import JunoVoiceKit

/// ``RealtimeStreamingClient`` wired to a scripted relay and a microphone that
/// does not exist.
///
/// Everything here was previously only reachable with a headset and a network
/// cable to pull: the uplink going quiet exactly while the model talks, the
/// reconnect that has to replay the conversation so far, and barge-in.
final class RealtimeStreamingClientTests: XCTestCase {

    private let relayURL = URL(string: "wss://relay.example.com/voice")!

    // MARK: Opening

    func testStartOpensTheRelayWithTheCredentialAndSendsSessionStart() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient(provider: .gemini)

        await client.start()
        try await world.waitForOpen()

        let openedURLs = await world.transport.openedURLs
        let opened = try XCTUnwrap(openedURLs.first)
        let components = try XCTUnwrap(
            URLComponents(url: opened, resolvingAgainstBaseURL: false)
        )
        XCTAssertEqual(components.host, "relay.example.com")
        XCTAssertEqual(
            components.queryItems?.first(where: { $0.name == "token" })?.value,
            "relay-token"
        )

        let sent = await world.sentJSON()
        let start = try XCTUnwrap(sent.first)
        XCTAssertEqual(start["type"] as? String, "session.start")
        XCTAssertEqual(start["provider"] as? String, "gemini")
    }

    /// The relay names its own relay, and it wins over the URL the client was
    /// built with, so the backend can move or shard relays without shipping an app.
    func testTheTokenResponseRelayWinsOverTheBuiltInOne() async throws {
        let world = World(
            relayURL: relayURL,
            credential: JunoVoiceRelayToken(
                token: "relay-token",
                url: URL(string: "wss://shard-3.example.com/voice")!
            )
        )
        let client = world.makeClient()

        await client.start()
        try await world.waitForOpen()

        let openedURLs = await world.transport.openedURLs
        XCTAssertEqual(openedURLs.first?.host, "shard-3.example.com")
    }

    /// A credential the backend refuses is not a socket that dropped. Reporting
    /// it as one would spend the reconnect budget retrying an account that is
    /// being turned away, minting a token per attempt.
    func testACredentialFailureFailsWithoutOpeningOrRetrying() async throws {
        let world = World(relayURL: relayURL, credentialError: StubError("budget_exceeded"))
        let client = world.makeClient()

        await client.start()

        let phase = await client.phase
        XCTAssertEqual(phase, .failed(.relay("budget_exceeded")))
        let openedURLs = await world.transport.openedURLs
        XCTAssertTrue(openedURLs.isEmpty)
        XCTAssertTrue(world.audio.stopped)
    }

    // MARK: Half-duplex and the uplink

    func testCapturedAudioIsSentOnlyWhileTheSessionIsLive() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()

        // Before anything is live: nothing must reach the wire.
        world.audio.emit(pcm16: Data([1, 2]), loudness: 0.5)
        await client.start()
        try await world.becomeLive(client)

        world.audio.emit(pcm16: Data([3, 4]), loudness: 0.5)
        try await world.waitFor("the uplink frame to arrive") {
            await world.transport.binaryFrames.count == 1
        }
        let frames = await world.transport.binaryFrames
        XCTAssertEqual(frames, [Data([3, 4])])
    }

    /// **Absent is not silence.** A suppressed endpoint reports a frame with no
    /// PCM and a real level; sending an empty buffer instead would tell the relay
    /// the reader had stopped talking rather than that they are muted.
    func testASuppressedFrameSendsNothingButStillReportsALevel() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)

        world.audio.emit(pcm16: nil, loudness: 0.71)
        try await world.waitFor("the level to be published") {
            await world.levels.contains(0.71)
        }
        let frames = await world.transport.binaryFrames
        XCTAssertTrue(frames.isEmpty)
    }

    func testTheUplinkIsSuppressedForTheLengthOfTheModelsTurn() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)

        await world.deliver(#"{"type":"turn","phase":"start"}"#)
        try await world.waitFor("the floor to change hands") {
            await client.phase == .responding
        }
        XCTAssertEqual(world.audio.suppressionHistory.last, true)

        await world.deliver(#"{"type":"turn","phase":"end"}"#)
        try await world.waitFor("the floor to come back") {
            await client.phase == .listening
        }
        XCTAssertEqual(world.audio.suppressionHistory.last, false)
    }

    // MARK: Playback and barge-in

    func testModelAudioIsPlayedAndAnInterruptFlushesItBeforeTheRelayIsTold()
        async throws
    {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)
        await world.deliver(#"{"type":"turn","phase":"start"}"#)
        try await world.waitFor("the answer to start") { await client.phase == .responding }

        await world.transport.deliver(.binary(Data([9, 9, 9, 9])))
        try await world.waitFor("the audio to be queued") { world.audio.played.count == 1 }

        await client.interrupt()

        XCTAssertEqual(world.audio.flushes, 1)
        let sent = await world.sentJSON()
        let control = try XCTUnwrap(sent.last)
        XCTAssertEqual(control["type"] as? String, "control.interrupt")
        // The flush happened locally before the frame went out; the queued
        // buffers are already on the player, so waiting for the relay means the
        // model talks over the interruption for a whole round trip.
        let phase = await client.phase
        XCTAssertEqual(phase, .interrupting)
    }

    /// The endpoint says it is cancelling echo, so talking over the answer is
    /// safe and interrupts it.
    func testTalkingOverTheAnswerInterruptsItWhenEchoIsCancelled() async throws {
        let world = World(relayURL: relayURL, echoCancellation: .active)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)
        let policy = await client.bargeInPolicy
        XCTAssertEqual(policy, .automatic)

        await world.deliver(#"{"type":"turn","phase":"start"}"#)
        try await world.waitFor("the answer to start") { await client.phase == .responding }

        for _ in 0..<8 { world.audio.emit(pcm16: nil, loudness: 0.9) }

        // Waiting on the *frame* rather than on the phase. The machine moves to
        // `interrupting` before its effects run, so a phase-only wait can observe
        // the transition a moment before the frame it causes reaches the wire.
        try await world.waitFor("the interruption to reach the relay") {
            let types = await world.sentJSON().compactMap { $0["type"] as? String }
            return types.contains("control.interrupt")
        }
        let phase = await client.phase
        XCTAssertEqual(phase, .interrupting)
        // Flushed locally before the frame went out — so by the time the frame is
        // on the wire, this has already happened.
        XCTAssertEqual(world.audio.flushes, 1)
    }

    /// The same audio, on hardware that cannot cancel echo, is the model's own
    /// voice coming back through the speakers. Acting on it would interrupt every
    /// answer after its first syllable, forever.
    func testTheSameAudioDoesNothingWhenEchoCancellationIsUnavailable() async throws {
        let world = World(relayURL: relayURL, echoCancellation: .unavailable)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)
        let policy = await client.bargeInPolicy
        XCTAssertEqual(policy, .manualOnly)

        await world.deliver(#"{"type":"turn","phase":"start"}"#)
        try await world.waitFor("the answer to start") { await client.phase == .responding }

        for _ in 0..<40 { world.audio.emit(pcm16: nil, loudness: 0.95) }
        // Nothing to wait for; give the capture loop room to have acted if it
        // were going to.
        try await Task.sleep(for: .milliseconds(80))

        let phase = await client.phase
        XCTAssertEqual(phase, .responding)
        XCTAssertEqual(world.audio.flushes, 0)
        let types = await world.sentJSON().compactMap { $0["type"] as? String }
        XCTAssertFalse(types.contains("control.interrupt"))
    }

    // MARK: Reconnect

    /// A dropped socket gets a *fresh* relay session with an empty provider
    /// history, so without replaying what was said the conversation resumes with
    /// a model that has forgotten the last ten minutes.
    func testAReconnectReplaysTheConversationSoFar() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient(
            configuration: .init(provider: .openai, reconnectDelay: .milliseconds(1))
        )
        await client.start()
        try await world.becomeLive(client)

        await world.deliver(
            #"{"type":"transcript","role":"user","text":"what about the second option","final":true}"#
        )
        await world.deliver(
            #"{"type":"transcript","role":"assistant","text":"the second option is cheaper","final":true}"#
        )
        // A hypothesis must not be replayed as fact.
        await world.deliver(
            #"{"type":"transcript","role":"user","text":"and the thi","final":false}"#
        )
        try await world.waitFor("the transcript to fill") {
            await client.transcript.count == 3
        }

        await world.transport.fail(StubError("connection lost"))
        try await world.waitFor("the second session.start") {
            let starts = await world.sentJSON().filter { $0["type"] as? String == "session.start" }
            return starts.count == 2
        }

        let sent = await world.sentJSON()
        let restart = try XCTUnwrap(sent.last { $0["type"] as? String == "session.start" })
        let history = try XCTUnwrap(restart["history"] as? [[String: Any]])
        XCTAssertEqual(history.count, 2, "only finalized lines are replayed")
        XCTAssertEqual(history.first?["text"] as? String, "what about the second option")
        XCTAssertEqual(history.last?["role"] as? String, "assistant")
    }

    /// The budget is earned by reaching live, and spent once.
    func testASecondDropBeforeRecoveringFailsInsteadOfLooping() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient(
            configuration: .init(provider: .openai, reconnectDelay: .milliseconds(1))
        )
        await client.start()
        try await world.becomeLive(client)

        await world.transport.fail(StubError("first drop"))
        try await world.waitFor("the reconnect to reopen") {
            await world.transport.openedURLs.count == 2
        }
        await world.transport.fail(StubError("second drop"))

        try await world.waitFor("the session to give up") {
            await client.phase == .failed(.transport("second drop"))
        }
        let openedURLs = await world.transport.openedURLs
        XCTAssertEqual(openedURLs.count, 2, "no third attempt")
        XCTAssertTrue(world.audio.stopped)
    }

    // MARK: Relay frames

    /// Once audio is flowing an `error` frame means "that turn had a problem".
    func testARelayErrorMidSessionSurfacesAsANoticeAndKeepsTheCallUp() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)

        await world.deliver(#"{"type":"error","message":"that image was too large"}"#)

        try await world.waitFor("the notice") {
            await world.notices == ["that image was too large"]
        }
        let phase = await client.phase
        XCTAssertEqual(phase, .listening)
    }

    /// Capabilities are what the relay said, and before it says anything they are
    /// **absent** — not "no video". A client that reads nil as a denial silently
    /// disables features that were available.
    func testVideoFramesAreRefusedUntilTheRelayHasSaidTheProviderCanSee()
        async throws
    {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.waitForOpen()

        let beforeReady = await client.capabilities
        XCTAssertNil(beforeReady)
        let refusedEarly = await client.sendVideoFrame(base64JPEG: "Zm9v")
        XCTAssertFalse(refusedEarly)

        await world.deliver(Self.readyJSON(videoInput: false))
        try await world.waitFor("the session to go live") { await client.phase == .listening }
        let refusedLive = await client.sendVideoFrame(base64JPEG: "Zm9v")
        XCTAssertFalse(refusedLive)

        await world.transport.fail(StubError("drop"))
        try await world.waitFor("the reconnect") { await client.phase == .reconnecting }
        let afterDrop = await client.capabilities
        XCTAssertNil(afterDrop, "a new session negotiates its own")
    }

    func testAnUnknownRelayFrameDoesNotEndTheConversation() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)

        await world.deliver(#"{"type":"something.new","payload":{"a":1}}"#)
        await world.deliver(#"{"type":"transcript","role":"user","text":"still here","final":true}"#)

        try await world.waitFor("the conversation to continue") {
            await client.transcript.count == 1
        }
        let phase = await client.phase
        XCTAssertEqual(phase, .listening)
    }

    // MARK: Ending

    func testEndingStopsTheAudioAndClosesTheSocketNormally() async throws {
        let world = World(relayURL: relayURL)
        let client = world.makeClient()
        await client.start()
        try await world.becomeLive(client)

        await client.end()

        let phase = await client.phase
        XCTAssertEqual(phase, .closed(.client))
        XCTAssertTrue(world.audio.stopped)
        let closes = await world.transport.closes
        XCTAssertEqual(closes, [true])
    }

    // MARK: Helpers

    static func readyJSON(videoInput: Bool = false) -> String {
        """
        {"type":"session.ready","provider":"openai","capabilities":{"videoInput":\(videoInput),\
        "trueS2S":true,"needsClientTranscript":false,"maxSessionSec":900}}
        """
    }
}

// MARK: - Scripted world

private struct StubError: LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Everything a session needs, none of it real.
private final class World: Sendable {
    let transport = FakeRealtimeTransport()
    let audio = FakeAudioEndpoint()
    private let authorization: FakeAuthorizer
    private let relayURL: URL
    private let collected = Collected()

    init(
        relayURL: URL,
        credential: JunoVoiceRelayToken = JunoVoiceRelayToken(token: "relay-token"),
        credentialError: (any Error)? = nil,
        echoCancellation: RealtimeEchoCancellation = .active
    ) {
        self.relayURL = relayURL
        self.authorization = FakeAuthorizer(credential: credential, failure: credentialError)
        audio.echo = echoCancellation
    }

    func makeClient(
        provider: JunoVoiceProvider = .openai,
        configuration: RealtimeStreamingClient.Configuration? = nil
    ) -> RealtimeStreamingClient {
        let client = RealtimeStreamingClient(
            authorization: authorization,
            relayURL: relayURL,
            transport: transport,
            audio: audio,
            configuration: configuration
                ?? RealtimeStreamingClient.Configuration(provider: provider)
        )
        let collected = self.collected
        // Not retained: the runtime keeps a running task alive, and this one ends
        // when the client's update stream finishes.
        Task {
            for await update in await client.updates() {
                switch update {
                case .level(let value): await collected.addLevel(value)
                case .notice(let message): await collected.addNotice(message)
                default: break
                }
            }
        }
        return client
    }

    var levels: [Double] { get async { await collected.levels } }
    var notices: [String] { get async { await collected.notices } }

    func sentJSON() async -> [[String: Any]] {
        await transport.sent.compactMap { frame -> [String: Any]? in
            guard case .text(let text) = frame, let data = text.data(using: .utf8) else {
                return nil
            }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    func deliver(_ json: String) async {
        await transport.deliver(.text(json))
    }

    func waitForOpen() async throws {
        try await waitFor("the transport to open") {
            await !self.transport.openedURLs.isEmpty
        }
    }

    /// Opens a session and answers the `session.start` with a `session.ready`.
    func becomeLive(_ client: RealtimeStreamingClient) async throws {
        try await waitForOpen()
        await deliver(RealtimeStreamingClientTests.readyJSON())
        try await waitFor("the session to go live") { await client.phase == .listening }
    }

    /// Polls rather than sleeping a fixed interval: the client hands work between
    /// an actor, a receive loop and a capture loop, and a single sleep long enough
    /// to be reliable on a loaded CI machine is long enough to make the suite drag.
    func waitFor(
        _ what: String,
        timeout: Duration = .seconds(3),
        _ condition: @Sendable () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    private actor Collected {
        var levels: [Double] = []
        var notices: [String] = []
        func addLevel(_ value: Double) { levels.append(value) }
        func addNotice(_ value: String) { notices.append(value) }
    }
}

private struct FakeAuthorizer: JunoVoiceRelayAuthorizing {
    let credential: JunoVoiceRelayToken
    let failure: (any Error)?

    func relayToken() async throws -> JunoVoiceRelayToken {
        if let failure { throw failure }
        return credential
    }
}

/// A socket the test drives frame by frame — including the drop.
private actor FakeRealtimeTransport: RealtimeTransport {
    private(set) var openedURLs: [URL] = []
    private(set) var sent: [RealtimeTransportFrame] = []
    private(set) var closes: [Bool] = []

    private var inbox: [Result<RealtimeTransportFrame, StubError>] = []
    private var waiter: CheckedContinuation<Result<RealtimeTransportFrame, StubError>, Never>?
    private var isOpen = false

    var binaryFrames: [Data] {
        sent.compactMap { if case .binary(let data) = $0 { data } else { nil } }
    }

    func open(url: URL) async throws {
        openedURLs.append(url)
        isOpen = true
    }

    func send(_ frame: RealtimeTransportFrame) async throws {
        guard isOpen else { throw RealtimeTransportError.notOpen }
        sent.append(frame)
    }

    func receive() async throws -> RealtimeTransportFrame {
        if !inbox.isEmpty {
            return try inbox.removeFirst().get()
        }
        let result = await withCheckedContinuation { continuation in
            waiter = continuation
        }
        return try result.get()
    }

    func close(normally: Bool) async {
        isOpen = false
        closes.append(normally)
    }

    func deliver(_ frame: RealtimeTransportFrame) {
        enqueue(.success(frame))
    }

    /// Drops the socket the way a real one does: the pending receive throws.
    func fail(_ error: StubError) {
        enqueue(.failure(error))
    }

    private func enqueue(_ result: Result<RealtimeTransportFrame, StubError>) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: result)
        } else {
            inbox.append(result)
        }
    }
}

/// A microphone and a speaker that are entirely bookkeeping.
///
/// A locked class rather than an actor so a test can read what happened without
/// awaiting — and so ``captureFrames()`` can satisfy the protocol's synchronous
/// requirement the same way the real endpoint does.
private final class FakeAudioEndpoint: RealtimeAudioEndpoint, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<RealtimeCaptureFrame>.Continuation?
    private var storedEcho: RealtimeEchoCancellation = .active
    private var storedPlayed: [Data] = []
    private var storedFlushes = 0
    private var storedSuppression: [Bool] = []
    private var storedMutes: [Bool] = []
    private var storedStarted = false
    private var storedStopped = false

    var echo: RealtimeEchoCancellation {
        get { lock.lock(); defer { lock.unlock() }; return storedEcho }
        set { lock.lock(); defer { lock.unlock() }; storedEcho = newValue }
    }
    var played: [Data] { lock.lock(); defer { lock.unlock() }; return storedPlayed }
    var flushes: Int { lock.lock(); defer { lock.unlock() }; return storedFlushes }
    var suppressionHistory: [Bool] {
        lock.lock(); defer { lock.unlock() }; return storedSuppression
    }
    var muteHistory: [Bool] { lock.lock(); defer { lock.unlock() }; return storedMutes }
    var started: Bool { lock.lock(); defer { lock.unlock() }; return storedStarted }
    var stopped: Bool { lock.lock(); defer { lock.unlock() }; return storedStopped }

    // The protocol's methods are `async`, and `NSLock.lock()` is unavailable from
    // an asynchronous context — so every one of them delegates to a synchronous
    // helper. The real endpoint has the same shape for the same reason; its lock
    // lives behind a box whose accessors are all synchronous.

    func start() async throws { recordStart() }

    func stop() async {
        let live = takeContinuationOnStop()
        live?.finish()
    }

    func setUplinkSuppressed(_ suppressed: Bool) async { record(suppression: suppressed) }

    func setMuted(_ muted: Bool) async { record(mute: muted) }

    func enqueuePlayback(_ pcm16: Data) async { record(playback: pcm16) }

    func flushPlayback() async { recordFlush() }

    private func recordStart() {
        lock.lock(); storedStarted = true; storedStopped = false; lock.unlock()
    }

    private func takeContinuationOnStop() -> AsyncStream<RealtimeCaptureFrame>.Continuation? {
        lock.lock()
        storedStopped = true
        let live = continuation
        continuation = nil
        lock.unlock()
        return live
    }

    private func record(suppression: Bool) {
        lock.lock(); storedSuppression.append(suppression); lock.unlock()
    }

    private func record(mute: Bool) {
        lock.lock(); storedMutes.append(mute); lock.unlock()
    }

    private func record(playback: Data) {
        lock.lock(); storedPlayed.append(playback); lock.unlock()
    }

    private func recordFlush() {
        lock.lock(); storedFlushes += 1; lock.unlock()
    }

    var echoCancellation: RealtimeEchoCancellation { echo }

    func captureFrames() -> AsyncStream<RealtimeCaptureFrame> {
        AsyncStream { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
        }
    }

    /// One microphone buffer. `pcm16: nil` is the suppressed or muted case —
    /// nothing to upload, but a level that is still real.
    func emit(pcm16: Data?, loudness: Double) {
        lock.lock()
        let live = continuation
        lock.unlock()
        live?.yield(RealtimeCaptureFrame(pcm16: pcm16, loudness: loudness))
    }
}
