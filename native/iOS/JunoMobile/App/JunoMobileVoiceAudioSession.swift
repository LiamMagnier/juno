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
        let suspended = (notification.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool) ?? false
        Task { @MainActor [weak self] in
          self?.handleInterruption(typeRaw: raw, optionsRaw: options, wasSuspended: suspended)
        }
      }
    )
    // The media server restarting takes every engine in the process with it.
    observers.append(
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification,
        object: AVAudioSession.sharedInstance(),
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor [weak self] in
          self?.apply(.resume(unmute: false))
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

  private func handleInterruption(typeRaw: UInt, optionsRaw: UInt, wasSuspended: Bool) {
    guard let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
    let action = JunoMobileVoiceInterruptionPolicy.action(
      began: type == .began,
      wasSuspended: wasSuspended,
      interrupted: interrupted,
      mutedBefore: wasMutedBeforeInterruption
    )
    apply(action)
  }

  private func apply(_ action: JunoMobileVoiceInterruptionPolicy.Action) {
    switch action {
    case .ignore:
      break
    case .pause:
      interrupted = true
      wasMutedBeforeInterruption = controller.muted
      // Mute rather than end: the relay keeps the conversation, and the
      // reader comes back to the call they were in.
      controller.setMuted(true)
    case .resume(let unmute):
      interrupted = false
      controller.resumeAudioAfterInterruption()
      if unmute { controller.setMuted(false) }
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

/// What an audio-session interruption does to a call.
///
/// **Three rules, each one a way the iPhone call went deaf.**
///
/// - A "began" that carries `wasSuspended` is not an interruption happening
///   now: iOS reports, on the way back from suspension (and sometimes as a
///   session activates), one that happened while the app was not running.
///   Muting on it left a live call muted with nothing on screen to say why.
/// - An "ended" always brings the audio back, whether or not it says
///   `shouldResume`. iOS stops the engine when an interruption begins and
///   restarts nothing; the flag is advice to media players about resuming
///   playback, and a call that waits for it can stay silent forever.
/// - The microphone is only turned back on if the interruption turned it off.
///   A call muted on purpose stays muted.
enum JunoMobileVoiceInterruptionPolicy {
  enum Action: Equatable {
    case ignore
    /// Mute the uplink until the interruption ends.
    case pause
    /// Re-activate the session and rebuild the graph; unmute if the
    /// interruption was what muted it.
    case resume(unmute: Bool)
  }

  static func action(
    began: Bool,
    wasSuspended: Bool,
    interrupted: Bool,
    mutedBefore: Bool
  ) -> Action {
    if began {
      if wasSuspended || interrupted { return .ignore }
      return .pause
    }
    return .resume(unmute: interrupted && !mutedBefore)
  }
}
