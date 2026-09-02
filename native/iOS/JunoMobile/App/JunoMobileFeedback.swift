import SwiftUI

/// The phone's haptic vocabulary, in one place.
///
/// Every tap that changes something answers in the hand as well as on the
/// screen — selection, send, stop, copy, pin, delete, approve, deny, a call
/// starting and ending. The mapping lives here so a send feels like a send on
/// every screen that has one, and so the whole vocabulary can be read at once
/// rather than reconstructed from thirty `.sensoryFeedback` call sites with
/// thirty opinions.
///
/// `SensoryFeedback` answers the system's own haptics setting, so nothing here
/// needs a preference of its own.
enum JunoMobileHaptic {
    /// A row chosen, a chip toggled, a tab switched.
    static let selection: SensoryFeedback = .selection
    /// A message sent, a call placed.
    static let send: SensoryFeedback = .impact(weight: .light, intensity: 0.7)
    /// A generation stopped, a call ended.
    static let stop: SensoryFeedback = .impact(weight: .medium)
    /// Text copied — something the reader now holds.
    static let copy: SensoryFeedback = .success
    /// Pinned, archived, favourited.
    static let pin: SensoryFeedback = .impact(weight: .light)
    /// Deleted — deliberately heavier.
    static let delete: SensoryFeedback = .warning
    /// An approval granted.
    static let approve: SensoryFeedback = .success
    /// An approval refused.
    static let deny: SensoryFeedback = .warning
    /// A call connected.
    static let connect: SensoryFeedback = .success
    /// The microphone muted or unmuted.
    static let mute: SensoryFeedback = .impact(weight: .light, intensity: 0.6)
    /// A push-to-talk press beginning or ending.
    static let pushToTalk: SensoryFeedback = .impact(weight: .medium, intensity: 0.5)
    /// Something arrived that needs the reader — an approval, an error.
    static let attention: SensoryFeedback = .warning
}

/// A counter that fires a haptic each time it advances.
///
/// `.sensoryFeedback(_:trigger:)` plays when its trigger *changes*, which is
/// awkward for an action that can repeat — two copies in a row would play once.
/// Bumping an integer is the idiom that makes every repeat count.
struct JunoMobileHapticTrigger: Equatable {
    private(set) var count = 0
    mutating func fire() { count &+= 1 }
}

extension View {
    /// Plays `feedback` every time `trigger` fires.
    func junoHaptic(_ feedback: SensoryFeedback, trigger: JunoMobileHapticTrigger) -> some View {
        sensoryFeedback(feedback, trigger: trigger)
    }
}
