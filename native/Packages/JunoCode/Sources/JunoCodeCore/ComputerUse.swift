import Foundation

public enum ComputerUsePermissionState: String, Codable, Sendable {
    case notDetermined
    case denied
    case granted
}

/// The two macOS privacy grants screen control cannot start without.
///
/// Named here, beside the state they are read into, so the coordinator's
/// refusal, the session's notice and the settings page all point at the same
/// System Settings pane for the same grant.
public enum ComputerUsePermission: String, CaseIterable, Sendable {
    /// ScreenCaptureKit, for the screenshots the agent looks at.
    case screenRecording
    /// Accessibility: reading elements and posting input into other apps.
    case accessibility

    public var title: String {
        switch self {
        case .screenRecording: "Screen Recording"
        case .accessibility: "Accessibility"
        }
    }

    /// The Privacy & Security pane that lists Juno for this grant. macOS has
    /// no API that grants either one; the reader flips the switch there.
    public var privacySettingsURL: URL {
        let anchor = switch self {
        case .screenRecording: "Privacy_ScreenCapture"
        case .accessibility: "Privacy_Accessibility"
        }
        // Force-unwrapped because both strings are constants that parse; a
        // failure here is a typo, not a runtime condition.
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
    }
}

/// Both grants, as macOS reported them at one moment.
///
/// macOS answers only "does this process hold the grant". A refusal and a
/// question never asked both read as not granted, so nothing downstream may
/// tell the reader which of the two happened.
public struct ComputerUsePermissionStatus: Equatable, Sendable {
    public var screenRecording: ComputerUsePermissionState
    public var accessibility: ComputerUsePermissionState
    /// macOS used to trust an earlier build of Juno for Accessibility and
    /// does not trust this one: the ad-hoc-signed development feed voids the
    /// grant on every update while System Settings still shows Juno switched
    /// on (CU-20). The fix is the reader removing Juno from the list and
    /// adding it again, and only a notice that says so gets them there.
    public var accessibilityTrustLostAfterUpdate: Bool

    public init(
        screenRecording: ComputerUsePermissionState,
        accessibility: ComputerUsePermissionState,
        accessibilityTrustLostAfterUpdate: Bool = false
    ) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
        self.accessibilityTrustLostAfterUpdate = accessibilityTrustLostAfterUpdate
    }

    /// Before anything has been read.
    public static let unknown = ComputerUsePermissionStatus(
        screenRecording: .notDetermined,
        accessibility: .notDetermined
    )

    public func state(of permission: ComputerUsePermission) -> ComputerUsePermissionState {
        switch permission {
        case .screenRecording: screenRecording
        case .accessibility: accessibility
        }
    }

    /// Every grant still missing, in the order the coordinator asks for them:
    /// Screen Recording first. A notice with room for one button opens the
    /// first, which is also the one macOS will prompt for on the next start.
    public var missing: [ComputerUsePermission] {
        ComputerUsePermission.allCases.filter { state(of: $0) != .granted }
    }

    public var isReady: Bool { missing.isEmpty }

    /// What the notice says when the grant looks on but is not.
    public static let trustLostAdvice =
        "macOS no longer trusts this build of Juno. Remove Juno from the Accessibility list and add it again."
}

/// The last frame the agent was sent in a session.
///
/// Memory only. It exists so the reader can see what the agent last looked
/// at while screen control runs, and is dropped the moment it stops; it is
/// never written to the transcript, the session store or sync (D-022).
public struct ComputerUseCapture: Equatable, Sendable {
    public let sessionID: CodeSessionID
    /// The same bytes the model was sent: PNG or JPEG.
    public let imageData: Data
    public let capturedAt: Date
    /// The app the frame shows, when it is one app's window.
    public let appName: String?

    public init(sessionID: CodeSessionID, imageData: Data, capturedAt: Date, appName: String? = nil) {
        self.sessionID = sessionID
        self.imageData = imageData
        self.capturedAt = capturedAt
        self.appName = appName
    }
}

/// The agent's screen-control tools, by the names the model calls them
/// (CODE_AGENT_SPEC §3.4).
///
/// In Core rather than beside the tools because the settings layer and the
/// permission coordinator need them too: which file may allow a tool
/// without asking depends on whether the tool drives the mouse and keyboard.
public enum ComputerUseToolName {
    /// The 17-action computer tool. On Anthropic routes that support it, the
    /// wire swaps it for the native `computer_toolset_20260801`.
    public static let computer = "computer"
    public static let batch = "computer_batch"
    public static let apps = "computer_apps"
    public static let accessibility = "computer_ax"
    public static let menu = "computer_menu"
    public static let display = "computer_display"
    /// The iOS Simulator tool (§5.14).
    public static let simulator = "simulator"

    /// The names before this rework. Kept so a standing rule naming one is
    /// still recognised as screen input: a project file allowing
    /// `computer_click` must stay stripped, not start meaning nothing.
    public static let legacy: Set<String> = [
        "computer_screenshot", "computer_click", "computer_type", "computer_press_key", "computer_scroll",
    ]

    /// Every screen tool, legacy names included.
    public static let all: Set<String> = Set([computer, batch, apps, accessibility, menu, display, simulator])
        .union(legacy)

    /// The tools that can act on the reader's Mac. No project settings file
    /// and no hook may let one run without asking; only the reader can.
    public static let input: Set<String> = Set([computer, batch, apps, menu, display, simulator])
        .union(legacy.subtracting(["computer_screenshot"]))

    /// Tools whose approvals never offer "Always allow": grants are per app
    /// and per session (D-021), and the floor can never be saved.
    public static let neverSavedAsRule: Set<String> = all

    /// Whether a tool is one of the screen tools.
    public static func isScreenTool(_ name: String) -> Bool {
        all.contains(name)
    }
}

/// One step of screen control in a session, for the journal.
public struct ComputerUseJournalEntry: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    /// "Clicked the “Save” button in TextEdit."
    public let summary: String
    public let timestamp: Date
    public let succeeded: Bool

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        summary: String,
        timestamp: Date,
        succeeded: Bool
    ) {
        self.id = id
        self.sessionID = sessionID
        self.summary = summary
        self.timestamp = timestamp
        self.succeeded = succeeded
    }
}

/// Why screen control could not start, as sentences (CU-16).
public enum ComputerUseError: Error, Equatable, Sendable, LocalizedError {
    case consentRequired
    case screenCapturePermissionMissing
    case accessibilityPermissionMissing
    case notActive
    /// Another session or Work task holds the screen; the sentence names it.
    case heldElsewhere(String)
    case driverUnavailable(reason: String)

    /// The grant this refusal is about, when it is about one.
    public var missingPermission: ComputerUsePermission? {
        switch self {
        case .screenCapturePermissionMissing: .screenRecording
        case .accessibilityPermissionMissing: .accessibility
        default: nil
        }
    }

    public var errorDescription: String? {
        switch self {
        case .consentRequired:
            "Screen control starts only when you press Start."
        case .screenCapturePermissionMissing:
            "macOS has not given Juno Screen Recording. Allow it in System Settings › Privacy & Security."
        case .accessibilityPermissionMissing:
            "macOS has not given Juno Accessibility. Allow it in System Settings › Privacy & Security."
        case .notActive:
            "Screen control is not running in this session."
        case let .heldElsewhere(sentence):
            "\(sentence). Stop it there first."
        case let .driverUnavailable(reason):
            reason
        }
    }
}

/// The TCC reads and requests, injected so the coordinator's consent rules
/// are testable without a TCC database.
public protocol ComputerUsePermissionChecking: Sendable {
    func screenCapturePermission() -> ComputerUsePermissionState
    func accessibilityPermission() -> ComputerUsePermissionState
    /// Requests the two macOS TCC grants. Production calls these only after an
    /// explicit Start; test fakes can inherit the defaults.
    func requestScreenCapturePermission() -> ComputerUsePermissionState
    func requestAccessibilityPermission() -> ComputerUsePermissionState
}

public extension ComputerUsePermissionChecking {
    func requestScreenCapturePermission() -> ComputerUsePermissionState {
        screenCapturePermission()
    }

    func requestAccessibilityPermission() -> ComputerUsePermissionState {
        accessibilityPermission()
    }
}

// MARK: - iOS Simulator (CODE_AGENT_SPEC §5.14)

/// One simulator device, as the agent sees it.
public struct SimulatorDeviceSummary: Hashable, Codable, Sendable {
    public var udid: String
    public var name: String
    public var runtime: String
    public var isBooted: Bool

    public init(udid: String, name: String, runtime: String, isBooted: Bool) {
        self.udid = udid
        self.name = name
        self.runtime = runtime
        self.isBooted = isBooted
    }
}

/// What the `simulator` tool drives: `simctl`, nothing private (D-024).
/// Taps and typing go through screen control on Simulator.app instead.
public protocol SimulatorAgentControlling: Sendable {
    func devices() async throws -> [SimulatorDeviceSummary]
    func boot(udid: String) async throws
    func shutdown(udid: String) async throws
    func install(udid: String, appPath: String) async throws
    /// Returns the launched process id.
    func launch(udid: String, bundleID: String) async throws -> Int32
    func terminate(udid: String, bundleID: String) async throws
    /// A PNG of the device's screen, at device pixels.
    func screenshot(udid: String) async throws -> Data
    func openURL(udid: String, url: String) async throws
}
