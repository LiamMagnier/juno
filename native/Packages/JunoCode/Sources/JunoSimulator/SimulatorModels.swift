import Foundation

/// Juno Simulator — the state and vocabulary the whole feature is built on.
///
/// Two rules run through this file:
///
///  1. **A state is a fact about a real process or a real device.** There is no
///     case meaning "we asked for it". `.running` is only reachable after a
///     launch that reported a pid on a device that reported `Booted`; it can
///     never be inferred from a URL, a device id, or a build that succeeded.
///  2. **Capability is separate from presence, and consent is separate from
///     both.** A Mac that is online has said nothing about Xcode; a Mac with
///     Xcode has said nothing about whether it will serve a session to a
///     browser. Those are three different facts and they are three different
///     fields.

// MARK: - State machine

public enum SimulatorState: Equatable, Sendable {
    /// No usable toolchain — no Xcode, no iOS platform, or no runtime.
    case unavailable(reason: String)
    /// Looking for projects, schemes, runtimes and devices.
    case discovering
    /// A project, scheme and device are chosen and nothing is running.
    case ready
    case booting(deviceName: String)
    case building(scheme: String)
    case installing(bundleID: String)
    case launching(bundleID: String)
    /// The app is alive on a booted device. Carries the pid the launch reported.
    case running(bundleID: String, pid: Int32)
    case stopping
    case failed(SimulatorFailure)

    public var isBusy: Bool {
        switch self {
        case .discovering, .booting, .building, .installing, .launching, .stopping: true
        case .unavailable, .ready, .running, .failed: false
        }
    }

    /// True only when a process is actually alive on a booted device.
    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    /// One short line for the pane's status row.
    public var label: String {
        switch self {
        case .unavailable: "Unavailable"
        case .discovering: "Looking for projects…"
        case .ready: "Ready"
        case .booting(let device): "Booting \(device)…"
        case .building(let scheme): "Building \(scheme)…"
        case .installing: "Installing…"
        case .launching: "Launching…"
        case .running: "Running"
        case .stopping: "Stopping…"
        case .failed: "Failed"
        }
    }
}

public struct SimulatorFailure: Equatable, Sendable {
    public enum Stage: String, Equatable, Sendable, Codable {
        case discovery, boot, build, install, launch, capture, input, teardown
    }

    public let stage: Stage
    public let message: String
    /// Build diagnostics or the tail of the failing command's output. Already
    /// redacted; nothing here reaches a log or the model unredacted.
    public let detail: String?

    public init(stage: Stage, message: String, detail: String? = nil) {
        self.stage = stage
        self.message = message
        self.detail = detail
    }
}

/// The transitions the session is allowed to make.
///
/// Written down rather than implied by the code that performs them, so an
/// illegal transition is a test failure instead of a UI that says "Running"
/// while a build is still going.
public enum SimulatorTransition {
    public static func isValid(from: SimulatorState, to: SimulatorState) -> Bool {
        switch (from, to) {
        // A failure or an unavailable toolchain is reachable from anywhere:
        // Xcode can be deleted mid-session and a step can fail at any point.
        case (_, .failed), (_, .unavailable): true
        // Re-discovery is always allowed — it is how the pane recovers.
        case (_, .discovering): true

        case (.discovering, .ready): true
        // A failed or unavailable session can be retried without re-discovering
        // — the toolchain and device list are usually still good.
        case (.failed, .ready), (.unavailable, .ready): true

        case (.ready, .booting): true
        case (.booting, .ready), (.booting, .building): true
        case (.ready, .building): true
        case (.building, .installing), (.building, .ready): true
        case (.installing, .launching): true
        case (.launching, .running): true

        // A rebuild while running goes straight back to building; the running
        // app is terminated first, which is `stopping` only when the user asked.
        case (.running, .building), (.running, .stopping), (.running, .launching): true
        case (.stopping, .ready): true

        // Self-transitions carry new payloads (a different scheme, a new pid).
        case (.building, .building), (.running, .running), (.booting, .booting): true

        default: false
        }
    }
}

// MARK: - Projects and schemes

public enum XcodeProjectKind: String, Equatable, Sendable, Codable {
    case workspace, project
    /// A Swift package that declares an iOS application product.
    case swiftPackage
}

public struct XcodeProject: Equatable, Sendable, Codable, Identifiable {
    public let id: String
    public let kind: XcodeProjectKind
    /// Absolute path to the `.xcworkspace`, `.xcodeproj`, or package directory.
    public let path: String
    public let name: String
    public let schemes: [String]

    public init(kind: XcodeProjectKind, path: String, name: String, schemes: [String]) {
        self.id = path
        self.kind = kind
        self.path = path
        self.name = name
        self.schemes = schemes
    }

    /// The `-workspace` / `-project` flag pair this project needs.
    public var buildContainerArguments: [String] {
        switch kind {
        case .workspace: ["-workspace", path]
        case .project: ["-project", path]
        // A package is built from its directory; `xcodebuild` infers it.
        case .swiftPackage: []
        }
    }
}

/// What `xcodebuild -showBuildSettings` told us about one scheme+destination.
public struct XcodeTargetSettings: Equatable, Sendable, Codable {
    public let bundleIdentifier: String
    public let productName: String
    /// Absolute path of the built `.app`, assembled from the settings rather
    /// than guessed from a conventional derived-data layout.
    public let appPath: String
    public let deploymentTarget: String?
    public let supportedPlatforms: [String]

    public init(
        bundleIdentifier: String,
        productName: String,
        appPath: String,
        deploymentTarget: String?,
        supportedPlatforms: [String]
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.productName = productName
        self.appPath = appPath
        self.deploymentTarget = deploymentTarget
        self.supportedPlatforms = supportedPlatforms
    }

    public var targetsIOSSimulator: Bool {
        supportedPlatforms.contains { $0.lowercased().contains("iphonesimulator") }
    }
}

// MARK: - Runtimes and devices

public struct SimulatorRuntime: Equatable, Sendable, Codable, Identifiable {
    public let id: String          // com.apple.CoreSimulator.SimRuntime.iOS-27-0
    public let name: String        // "iOS 27.0"
    public let version: String     // "27.0"
    public let platform: String    // "iOS"
    public let isAvailable: Bool

    public init(id: String, name: String, version: String, platform: String, isAvailable: Bool) {
        self.id = id
        self.name = name
        self.version = version
        self.platform = platform
        self.isAvailable = isAvailable
    }

    public var isIOS: Bool { platform.lowercased() == "ios" }
}

public enum SimulatorDeviceState: String, Equatable, Sendable, Codable {
    case shutdown = "Shutdown"
    case booted = "Booted"
    case booting = "Booting"
    case shuttingDown = "Shutting Down"
    case creating = "Creating"
    case unknown = "Unknown"

    public init(wire: String) {
        self = SimulatorDeviceState(rawValue: wire) ?? .unknown
    }
}

public struct SimulatorDevice: Equatable, Sendable, Codable, Identifiable {
    public let udid: String
    public let name: String
    public let state: SimulatorDeviceState
    public let runtimeID: String
    public let deviceTypeID: String?
    public let isAvailable: Bool

    public var id: String { udid }

    public init(
        udid: String,
        name: String,
        state: SimulatorDeviceState,
        runtimeID: String,
        deviceTypeID: String?,
        isAvailable: Bool
    ) {
        self.udid = udid
        self.name = name
        self.state = state
        self.runtimeID = runtimeID
        self.deviceTypeID = deviceTypeID
        self.isAvailable = isAvailable
    }
}

// MARK: - The user's choice, per workspace

/// Persisted per Juno workspace, so reopening a project does not re-ask.
public struct SimulatorSelection: Equatable, Sendable, Codable {
    public var projectPath: String
    public var scheme: String
    public var configuration: String
    public var runtimeID: String
    public var deviceUDID: String

    public init(projectPath: String, scheme: String, configuration: String = "Debug", runtimeID: String, deviceUDID: String) {
        self.projectPath = projectPath
        self.scheme = scheme
        self.configuration = configuration
        self.runtimeID = runtimeID
        self.deviceUDID = deviceUDID
    }
}

// MARK: - Input transports

/// How input reaches the simulated device — and, just as importantly, when it
/// honestly cannot.
///
/// There is no public, supported API for injecting a tap into a booted
/// simulator. Rather than pretend otherwise (or quietly drive the Simulator
/// app through Accessibility, which is a standing grant the user never gave for
/// this), the capability is declared and the fallback is stated in the UI.
public enum SimulatorInputTransport: String, Equatable, Sendable, Codable {
    /// A genuinely supported direct frame/input mechanism, when one exists on
    /// this Xcode/macOS. Selected only after a positive capability probe.
    case direct
    /// Frames come from `simctl io … screenshot`; input is not available.
    /// Verification is real, interaction is not — and the pane says so.
    case screenshotOnly
    /// Opens the real Simulator app so the *user* can interact. Juno observes.
    case externalSimulator
}

public struct SimulatorInputCapability: Equatable, Sendable, Codable {
    public let transport: SimulatorInputTransport
    /// Present when input is unavailable — shown verbatim in the pane so the
    /// limitation is stated rather than discovered.
    public let unavailableReason: String?
    /// Permissions this transport needs but does not yet have.
    public let missingPermissions: [String]

    public init(transport: SimulatorInputTransport, unavailableReason: String?, missingPermissions: [String] = []) {
        self.transport = transport
        self.unavailableReason = unavailableReason
        self.missingPermissions = missingPermissions
    }

    public var canInject: Bool { transport == .direct && missingPermissions.isEmpty }

    /// What this build actually ships. Stated as a constant rather than probed
    /// optimistically: claiming `.direct` and failing at the first tap is worse
    /// than saying up front that interaction happens in the Simulator app.
    public static let current = SimulatorInputCapability(
        transport: .externalSimulator,
        unavailableReason: """
            Apple ships no supported API for injecting touches into a booted simulator, \
            so Juno captures frames and opens the Simulator app for you to interact with. \
            Juno never drives your Mac through Accessibility automation.
            """
    )
}

// MARK: - Control lease

/// Who owns input at a given instant. Only one holder, ever.
public enum SimulatorControlOwner: String, Equatable, Sendable, Codable {
    case none, user, juno
}

public struct SimulatorControlLease: Equatable, Sendable, Codable {
    public var owner: SimulatorControlOwner
    public var acquiredAt: Date?
    public var expiresAt: Date?

    public init(owner: SimulatorControlOwner = .none, acquiredAt: Date? = nil, expiresAt: Date? = nil) {
        self.owner = owner
        self.acquiredAt = acquiredAt
        self.expiresAt = expiresAt
    }

    public func isExpired(now: Date) -> Bool {
        guard let expiresAt else { return false }
        return now >= expiresAt
    }

    /// The user may always take control immediately; Juno may only take it when
    /// nobody holds it (or the holder's lease has expired).
    public func canTake(_ candidate: SimulatorControlOwner, now: Date) -> Bool {
        if candidate == .user { return true }
        if candidate == .none { return true }
        return owner == .none || owner == .juno || isExpired(now: now)
    }
}
