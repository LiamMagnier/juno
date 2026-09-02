import AVFoundation
import Foundation
import JunoVoiceKit
import Observation

/// Watches the audio session for the two things that happen to a phone call
/// and never to a Mac: an interruption (a phone call, Siri, an alarm) and a
/// route change (AirPods in, AirPods out, a car).
///
/// **An interruption pauses; a route change never ends.** Before this, neither
/// was handled: a phone call mid-conversation left the socket open with a dead
/// microphone, and pulling AirPods out ended nothing but also told the speaker
/// toggle nothing, so the label lied until the next tap. Now an interruption
/// mutes the uplink and says so, resumes when the system says it may, and a
/// route change keeps the session and republishes where the audio is going.
@MainActor
@Observable
final class JunoMobileVoiceAudioSession {
  /// True between an interruption beginning and ending.
  private(set) var interrupted = false
  /// Where output is going, in the reader's words: "AirPods Pro", "Speaker",
  /// "iPhone". Nil until the first route notification.
  private(set) var outputRouteName: String?
  /// Whether the current route is an external device — headphones, a car,
  /// Bluetooth — rather than the phone's own speaker or receiver.
  private(set) var isExternalRoute = false

  private let controller: JunoRealtimeVoiceController
  @ObservationIgnored nonisolated(unsafe) private var observers: [any NSObjectProtocol] = []
  /// Whether the microphone was open when the interruption began, so a call
  /// that was muted on purpose stays muted afterwards.
  private var wasMutedBeforeInterruption = false

  init(controller: JunoRealtimeVoiceController) {
    self.controller = controller
    readRoute()
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] notification in
        let raw = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
        let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
        Task { @MainActor [weak self] in
          self?.handleInterruption(typeRaw: raw, optionsRaw: options)
        }
      }
    )
    observers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in self?.readRoute() }
      }
    )
  }

  deinit {
    let center = NotificationCenter.default
    for observer in observers { center.removeObserver(observer) }
  }

  private func handleInterruption(typeRaw: UInt, optionsRaw: UInt) {
    guard let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
    switch type {
    case .began:
      guard !interrupted else { return }
      interrupted = true
      wasMutedBeforeInterruption = controller.muted
      // Mute rather than end: the relay keeps the conversation, and the
      // reader comes back to the call they were in.
      controller.setMuted(true)
    case .ended:
      interrupted = false
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
      if options.contains(.shouldResume), !wasMutedBeforeInterruption {
        controller.setMuted(false)
      }
    @unknown default:
      break
    }
  }

  private func readRoute() {
    let route = AVAudioSession.sharedInstance().currentRoute
    guard let output = route.outputs.first else {
      outputRouteName = nil
      isExternalRoute = false
      return
    }
    switch output.portType {
    case .builtInSpeaker:
      outputRouteName = "Speaker"
      isExternalRoute = false
    case .builtInReceiver:
      outputRouteName = "iPhone"
      isExternalRoute = false
    default:
      outputRouteName = output.portName
      isExternalRoute = true
    }
  }
}
