import AVFoundation
import Foundation
import JunoVoiceKit
import Network
import XCTest

/// A whole call on the phone's real audio stack, against a relay in this
/// process: the microphone has to reach the socket, and audio sent down the
/// socket has to come out of the speaker.
///
/// This is the regression test for the iPhone call that connected and then
/// neither heard nor spoke. Everything above the audio graph was covered by
/// package tests that never touch `AVAudioSession`; this is the one test that
/// does, hosted in the app on a simulator whose microphone is the Mac's.
@MainActor
final class JunoMobileVoiceAudioTests: XCTestCase {
  func testCallSendsMicrophoneAudioAndPlaysTheReply() async throws {
    // The hosted app may be denied the microphone on a fresh simulator; the
    // test is about the graph, not the prompt. `simctl privacy grant` first.
    guard AVAudioApplication.shared.recordPermission == .granted else {
      throw XCTSkip("Grant the microphone: xcrun simctl privacy <udid> grant microphone <bundle id>")
    }
    let relay = try LoopbackVoiceRelay()
    try await relay.start()
    defer { relay.stop() }

    let controller = JunoRealtimeVoiceController(
      authorization: LoopbackAuthorization(url: relay.url),
      provider: .gemini
    )
    await controller.start()
    try await waitUntil("the session to go live", timeout: 5) { controller.phase == .live }

    // The uplink: PCM16 frames from the microphone reach the relay.
    try await waitUntil("microphone audio at the relay", timeout: 5) {
      relay.receivedAudioBytes > 16_000
    }

    // The downlink: a second of tone, inside a turn, is played.
    relay.sendText(#"{"type":"turn","phase":"start"}"#)
    relay.sendBinary(LoopbackVoiceRelay.tone(seconds: 1.2))
    try await waitUntil("the reply to be audible", timeout: 4) { controller.playbackAudible }
    XCTAssertEqual(controller.phase, .live, "Playing the reply must not end the call")
    relay.sendText(#"{"type":"turn","phase":"end"}"#)

    // And once the reply has drained, the microphone is heard again.
    try await waitUntil("the reply to drain", timeout: 5) { !controller.playbackAudible }
    let afterReply = relay.receivedAudioBytes
    try await waitUntil("microphone audio after the reply", timeout: 5) {
      relay.receivedAudioBytes > afterReply + 16_000
    }

    controller.end()
  }

  private func waitUntil(
    _ what: String,
    timeout: TimeInterval,
    _ condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() > deadline {
        XCTFail("Timed out waiting for \(what)")
        throw CancellationError()
      }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
}

private struct LoopbackAuthorization: JunoVoiceRelayAuthorizing {
  let url: URL
  func relayToken() async throws -> JunoVoiceRelayToken {
    JunoVoiceRelayToken(token: "loopback", url: url)
  }
}

/// A relay that speaks just enough of the protocol: `session.ready` on
/// `session.start`, a byte count for the uplink, and whatever the test sends
/// down.
private final class LoopbackVoiceRelay: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "loopback-voice-relay")
  private let lock = NSLock()
  private var connection: NWConnection?
  private var audioBytes = 0

  var receivedAudioBytes: Int {
    lock.lock(); defer { lock.unlock() }
    return audioBytes
  }

  var url: URL { URL(string: "ws://127.0.0.1:\(listener.port?.rawValue ?? 0)")! }

  init() throws {
    let parameters = NWParameters.tcp
    let websocket = NWProtocolWebSocket.Options()
    websocket.autoReplyPing = true
    parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
    listener = try NWListener(using: parameters, on: .any)
  }

  func start() async throws {
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      self.lock.lock()
      self.connection = connection
      self.lock.unlock()
      connection.start(queue: self.queue)
      self.receive(on: connection)
    }
    listener.start(queue: queue)
    for _ in 0..<100 where listener.port == nil || listener.port?.rawValue == 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  func stop() {
    connection?.cancel()
    listener.cancel()
  }

  private func receive(on connection: NWConnection) {
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self, error == nil else { return }
      let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
        as? NWProtocolWebSocket.Metadata
      if let data, let metadata {
        switch metadata.opcode {
        case .binary:
          self.lock.lock()
          self.audioBytes += data.count
          self.lock.unlock()
        case .text:
          let text = String(decoding: data, as: UTF8.self)
          if text.contains(#""session.start""#) {
            self.sendText(
              #"{"type":"session.ready","provider":"gemini","capabilities":{"videoInput":true,"trueS2S":true,"needsClientTranscript":false,"maxSessionSec":900}}"#
            )
          }
        default:
          break
        }
      }
      self.receive(on: connection)
    }
  }

  func sendText(_ text: String) {
    send(Data(text.utf8), opcode: .text)
  }

  func sendBinary(_ data: Data) {
    send(data, opcode: .binary)
  }

  private func send(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
    lock.lock()
    let connection = self.connection
    lock.unlock()
    let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
    let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
    connection?.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
  }

  /// PCM16 LE mono 24 kHz, the relay's downlink format.
  static func tone(seconds: Double) -> Data {
    let rate = 24_000.0
    let count = Int(rate * seconds)
    var data = Data(capacity: count * 2)
    for index in 0..<count {
      let sample = Int16(sin(2 * .pi * 440 * Double(index) / rate) * 12_000)
      withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
  }
}
