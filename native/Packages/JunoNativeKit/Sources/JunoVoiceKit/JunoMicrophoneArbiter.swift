import Foundation

/// Who holds the microphone in this process: dictation or a voice call, never
/// both.
///
/// **Two engines on one microphone was a voice bug.** Dictation and a call
/// each build their own `AVAudioEngine`, and on iOS the call asks its input
/// node for the voice-processing unit. A dictation engine still holding the
/// input (a take that was never finished, a composer that went away mid-take,
/// the Code composer dictating while Chat started a call) left the call's
/// graph sharing the device with it: the unit refuses, or initialises on a
/// microphone that delivers nothing. Now whoever starts capturing claims the
/// microphone, and the previous holder is asked to let go first, before the
/// new graph is built.
@MainActor
public final class JunoMicrophoneArbiter {
    public static let shared = JunoMicrophoneArbiter()

    public enum Owner: Equatable, Sendable {
        case dictation
        case voiceCall
    }

    private struct Claim {
        let holder: ObjectIdentifier
        let owner: Owner
        let yield: () -> Void
    }

    private var current: Claim?

    public init() {}

    /// Who holds the microphone now, if anyone.
    public var owner: Owner? { current?.owner }

    /// Takes the microphone for `holder`. A different holder is asked to stop
    /// (its `yield` runs, synchronously) before this returns, so the caller
    /// can build its graph on a free device. Claiming again as the same holder
    /// only refreshes the claim.
    public func claim(_ owner: Owner, by holder: AnyObject, yield: @escaping () -> Void) {
        let id = ObjectIdentifier(holder)
        if let previous = current, previous.holder != id {
            current = nil
            previous.yield()
        }
        current = Claim(holder: id, owner: owner, yield: yield)
    }

    /// Gives the microphone back. A no-op for anyone but the holder, so a
    /// late teardown cannot release a claim someone else has since made.
    public func release(by holder: AnyObject) {
        guard current?.holder == ObjectIdentifier(holder) else { return }
        current = nil
    }

    /// Whether `holder` is the one holding it.
    public func isHeld(by holder: AnyObject) -> Bool {
        current?.holder == ObjectIdentifier(holder)
    }
}
