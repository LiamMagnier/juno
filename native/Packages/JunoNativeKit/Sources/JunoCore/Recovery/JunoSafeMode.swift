import Foundation
import Synchronization

/// The optional subsystems safe mode turns off. Each is something the app can
/// run without, and each has crashed a desktop app somewhere before: native
/// accessibility and screen capture, third-party processes, a global event
/// hook, work that starts on its own, and hand-built animation.
public struct JunoSafeModeSubsystems: OptionSet, Sendable, Hashable {
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    /// Computer use: the bridge, the overlay, and auto-resume of a session.
    public static let computerUse = JunoSafeModeSubsystems(rawValue: 1 << 0)
    /// Extensions: MCP servers declared by projects, the user or imports.
    public static let extensions = JunoSafeModeSubsystems(rawValue: 1 << 1)
    /// The Quick Entry global hotkey.
    public static let quickEntryHotkey = JunoSafeModeSubsystems(rawValue: 1 << 2)
    /// Agents that start without being asked: interrupted Code runs resumed at
    /// launch, background refresh.
    public static let backgroundAgents = JunoSafeModeSubsystems(rawValue: 1 << 3)
    /// Custom motion: views fall back to their Reduce Motion variants.
    public static let customMotion = JunoSafeModeSubsystems(rawValue: 1 << 4)

    public static let all: JunoSafeModeSubsystems = [
        .computerUse, .extensions, .quickEntryHotkey, .backgroundAgents, .customMotion,
    ]
}

/// Whether this process runs in safe mode, readable from anywhere — the app
/// delegate, a package's start-up check, a view.
///
/// Decided once at launch from ``JunoLaunchAssessment``. On iOS, where an app
/// cannot relaunch itself, leaving safe mode turns the subsystems back on in
/// place; on the Mac the app relaunches instead.
public enum JunoSafeMode {
    private static let state = Mutex<JunoSafeModeSubsystems>([])

    /// The subsystems that are off.
    public static var disabled: JunoSafeModeSubsystems {
        state.withLock { $0 }
    }

    public static var isActive: Bool { !disabled.isEmpty }

    /// Whether `subsystem` may run.
    public static func allows(_ subsystem: JunoSafeModeSubsystems) -> Bool {
        disabled.isDisjoint(with: subsystem)
    }

    /// Enters safe mode with every optional subsystem off, or leaves it.
    public static func set(active: Bool) {
        set(disabled: active ? .all : [])
    }

    public static func set(disabled subsystems: JunoSafeModeSubsystems) {
        state.withLock { $0 = subsystems }
    }
}
