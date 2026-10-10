#if canImport(AVFoundation) && canImport(Speech)
import Foundation

/// When a call's audio graph is rebuilt after `AVAudioEngine` stops itself.
///
/// The engine stops on any configuration change: a route change (AirPods in
/// or out), and, on iOS, the voice-processing unit finishing its own setup a
/// few milliseconds after `start()`. Three rules:
///
/// - **Every phase that wants audio recovers**, not only `live`. The graph is
///   built while the call is still `connecting`, which is exactly when the
///   voice-processing unit's own change arrives; skipping it there left the
///   whole call deaf and mute.
/// - **Only a graph that is actually down is rebuilt.** A change the engine
///   rode out needs nothing, and a rebuild is a dropped syllable.
/// - **Repeated stops fall back to the plain input.** A unit that keeps
///   reconfiguring would otherwise rebuild forever; after ``limit`` rebuilds
///   inside ``window`` the next one goes without voice processing.
struct RealtimeGraphRecoveryPolicy: Equatable, Sendable {
    enum Decision: Equatable, Sendable {
        case skip
        case rebuild(rawOnly: Bool)
    }

    static let window: TimeInterval = 5
    static let limit = 2

    private var recent: [TimeInterval] = []

    @MainActor
    static func wantsAudio(phase: JunoRealtimeVoiceController.Phase, closedByUser: Bool) -> Bool {
        guard !closedByUser else { return false }
        switch phase {
        case .connecting, .live, .reconnecting: return true
        case .idle, .ended, .error: return false
        }
    }

    mutating func decide(wantsAudio: Bool, engineRunning: Bool, now: TimeInterval) -> Decision {
        guard wantsAudio, !engineRunning else { return .skip }
        recent = recent.filter { now - $0 < Self.window }
        let rawOnly = recent.count >= Self.limit
        recent.append(now)
        return .rebuild(rawOnly: rawOnly)
    }
}
#endif
