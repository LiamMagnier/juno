import Foundation

/// What this Mac advertises to the relay about its simulator support.
///
/// Three separate facts, deliberately not collapsed into one:
///
///  - **Presence** — the device is registered and recently seen. Already carried
///    by `CodeDevice.lastSeenAt`; nothing here changes it.
///  - **Capability** — Xcode exists, an iOS runtime exists, these devices are
///    available. That is this payload.
///  - **Consent** — the user has explicitly turned on simulator hosting for
///    remote sessions. That is `servesSimulatorSessions`, which is **off by
///    default** and independent of `servesQueuedTasks`: agreeing to run queued
///    Code work is not agreeing to expose a live screen to a browser.
///
/// Backwards compatibility is a requirement, not a nicety: an older relay and
/// an older phone both have to keep working. The payload is therefore purely
/// additive — every field is optional on the wire, and a registration without
/// any of it means exactly what it meant before (`supportsIOSSimulator: false`).
public struct SimulatorCapability: Codable, Equatable, Sendable {
    /// Bumped when the simulator wire protocol changes incompatibly. A client
    /// that does not recognise the version falls back to "unsupported" rather
    /// than guessing.
    public static let protocolVersion = 1

    public var supportsIOSSimulator: Bool
    public var simulatorProtocolVersion: Int
    public var xcodeVersion: String?
    public var xcodeBuild: String?
    /// e.g. ["iOS 27.0", "iOS 26.4"] — installed *and* available.
    public var installedPlatformVersions: [String]
    /// A bounded sample for the picker; the full list is fetched on demand.
    public var availableDevices: [AdvertisedDevice]
    public var supportsFrameStreaming: Bool
    public var supportsEmbeddedInput: Bool
    public var supportsScreenshotVerification: Bool
    /// Permissions the Mac would need for a capability it does not currently
    /// have. Empty in this build — screenshot capture needs none.
    public var requiredPermissions: [String]
    public var maxStreamWidth: Int
    public var maxStreamHeight: Int
    public var maxFramesPerSecond: Double
    /// The user's explicit local opt-in. Off unless they turned it on.
    public var servesSimulatorSessions: Bool
    /// Stated verbatim in the web and Mac UI when input is unavailable.
    public var inputUnavailableReason: String?

    public struct AdvertisedDevice: Codable, Equatable, Sendable {
        public var udid: String
        public var name: String
        public var runtime: String
        public var booted: Bool

        public init(udid: String, name: String, runtime: String, booted: Bool) {
            self.udid = udid
            self.name = name
            self.runtime = runtime
            self.booted = booted
        }
    }

    /// What a Mac with no usable toolchain advertises — and what every older
    /// client that sends no simulator fields is understood to mean.
    public static let unsupported = SimulatorCapability(
        supportsIOSSimulator: false,
        simulatorProtocolVersion: protocolVersion,
        xcodeVersion: nil,
        xcodeBuild: nil,
        installedPlatformVersions: [],
        availableDevices: [],
        supportsFrameStreaming: false,
        supportsEmbeddedInput: false,
        supportsScreenshotVerification: false,
        requiredPermissions: [],
        maxStreamWidth: 0,
        maxStreamHeight: 0,
        maxFramesPerSecond: 0,
        servesSimulatorSessions: false,
        inputUnavailableReason: nil
    )

    public init(
        supportsIOSSimulator: Bool,
        simulatorProtocolVersion: Int,
        xcodeVersion: String?,
        xcodeBuild: String?,
        installedPlatformVersions: [String],
        availableDevices: [AdvertisedDevice],
        supportsFrameStreaming: Bool,
        supportsEmbeddedInput: Bool,
        supportsScreenshotVerification: Bool,
        requiredPermissions: [String],
        maxStreamWidth: Int,
        maxStreamHeight: Int,
        maxFramesPerSecond: Double,
        servesSimulatorSessions: Bool,
        inputUnavailableReason: String?
    ) {
        self.supportsIOSSimulator = supportsIOSSimulator
        self.simulatorProtocolVersion = simulatorProtocolVersion
        self.xcodeVersion = xcodeVersion
        self.xcodeBuild = xcodeBuild
        self.installedPlatformVersions = installedPlatformVersions
        self.availableDevices = availableDevices
        self.supportsFrameStreaming = supportsFrameStreaming
        self.supportsEmbeddedInput = supportsEmbeddedInput
        self.supportsScreenshotVerification = supportsScreenshotVerification
        self.requiredPermissions = requiredPermissions
        self.maxStreamWidth = maxStreamWidth
        self.maxStreamHeight = maxStreamHeight
        self.maxFramesPerSecond = maxFramesPerSecond
        self.servesSimulatorSessions = servesSimulatorSessions
        self.inputUnavailableReason = inputUnavailableReason
    }

    /// Build the advertisement from what was actually discovered.
    public static func from(
        toolchain: XcodeProjectDiscoveryService.ToolchainStatus,
        runtimes: [SimulatorRuntime],
        devices: [SimulatorDevice],
        input: SimulatorInputCapability,
        servesSimulatorSessions: Bool,
        deviceSampleLimit: Int = 24
    ) -> SimulatorCapability {
        guard case .ready(_, let version, let build) = toolchain else { return .unsupported }
        let iosRuntimes = runtimes.filter { $0.isIOS && $0.isAvailable }
        guard !iosRuntimes.isEmpty else {
            // Xcode without an iOS runtime cannot run a simulator, and saying
            // "supported" here is exactly the lie that produces a browser pane
            // that spins forever.
            var capability = SimulatorCapability.unsupported
            capability.xcodeVersion = version
            capability.xcodeBuild = build
            return capability
        }

        let runtimeNames = Dictionary(uniqueKeysWithValues: runtimes.map { ($0.id, $0.name) })
        let iosRuntimeIDs = Set(iosRuntimes.map(\.id))
        let advertised = devices
            .filter { device in device.isAvailable && iosRuntimeIDs.contains(device.runtimeID) }
            .prefix(deviceSampleLimit)
            .map { device in
                AdvertisedDevice(
                    udid: device.udid,
                    name: device.name,
                    runtime: runtimeNames[device.runtimeID] ?? device.runtimeID,
                    booted: device.state == .booted
                )
            }

        return SimulatorCapability(
            supportsIOSSimulator: true,
            simulatorProtocolVersion: protocolVersion,
            xcodeVersion: version,
            xcodeBuild: build,
            installedPlatformVersions: iosRuntimes
                .sorted { SimulatorParsing.compareVersions($0.version, $1.version) == .orderedDescending }
                .map(\.name),
            availableDevices: Array(advertised),
            supportsFrameStreaming: true,
            supportsEmbeddedInput: input.canInject,
            supportsScreenshotVerification: true,
            requiredPermissions: input.missingPermissions,
            maxStreamWidth: SimulatorFrameService.maxDimension,
            maxStreamHeight: SimulatorFrameService.maxDimension,
            maxFramesPerSecond: SimulatorFrameService.maxFramesPerSecond,
            servesSimulatorSessions: servesSimulatorSessions,
            inputUnavailableReason: input.canInject ? nil : input.unavailableReason
        )
    }

    /// Whether a *remote* client may open a session against this Mac.
    ///
    /// Capability and consent are both required, and they are checked
    /// separately so the browser can tell the two apart: "this Mac cannot" and
    /// "this Mac has not been allowed to" are different states with different
    /// fixes.
    public var canServeRemoteSession: Bool {
        supportsIOSSimulator && servesSimulatorSessions
    }

    /// Older relays and clients send no simulator fields at all. Decoding must
    /// treat that as "unsupported", never as a decode failure that would break
    /// device registration entirely.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supportsIOSSimulator = try c.decodeIfPresent(Bool.self, forKey: .supportsIOSSimulator) ?? false
        simulatorProtocolVersion = try c.decodeIfPresent(Int.self, forKey: .simulatorProtocolVersion) ?? 0
        xcodeVersion = try c.decodeIfPresent(String.self, forKey: .xcodeVersion)
        xcodeBuild = try c.decodeIfPresent(String.self, forKey: .xcodeBuild)
        installedPlatformVersions = try c.decodeIfPresent([String].self, forKey: .installedPlatformVersions) ?? []
        availableDevices = try c.decodeIfPresent([AdvertisedDevice].self, forKey: .availableDevices) ?? []
        supportsFrameStreaming = try c.decodeIfPresent(Bool.self, forKey: .supportsFrameStreaming) ?? false
        supportsEmbeddedInput = try c.decodeIfPresent(Bool.self, forKey: .supportsEmbeddedInput) ?? false
        supportsScreenshotVerification = try c.decodeIfPresent(Bool.self, forKey: .supportsScreenshotVerification) ?? false
        requiredPermissions = try c.decodeIfPresent([String].self, forKey: .requiredPermissions) ?? []
        maxStreamWidth = try c.decodeIfPresent(Int.self, forKey: .maxStreamWidth) ?? 0
        maxStreamHeight = try c.decodeIfPresent(Int.self, forKey: .maxStreamHeight) ?? 0
        maxFramesPerSecond = try c.decodeIfPresent(Double.self, forKey: .maxFramesPerSecond) ?? 0
        servesSimulatorSessions = try c.decodeIfPresent(Bool.self, forKey: .servesSimulatorSessions) ?? false
        inputUnavailableReason = try c.decodeIfPresent(String.self, forKey: .inputUnavailableReason)
    }
}
