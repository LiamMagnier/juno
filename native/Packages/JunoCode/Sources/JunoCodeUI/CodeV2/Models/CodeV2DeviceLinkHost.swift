import Foundation
import JunoCodeCore
import JunoCodeLocal

/// Lets the hosted web drive env-server sessions through this Mac (SPEC §2:
/// subscriptions only run locally; the web reaches them via the device link).
///
/// Wires three things together while Remote hosting is on: the hub's events
/// into an ``EnvServerDeviceLink`` (in arrival order, through one stream), the
/// link's commands into the hub's connection, and an
/// ``EnvServerDeviceLinkChannel`` that pulls the web's commands from the
/// backend relay (`/api/code/v2/link/<device>/host`) and pushes the answers
/// and events back. Off is the default, and switching Remote off stops all three.
@MainActor
public final class CodeV2DeviceLinkHost {
    public typealias Perform = EnvServerDeviceLinkChannel.Perform

    private let hub: EnvServerHub
    private var link: EnvServerDeviceLink?
    private var channel: EnvServerDeviceLinkChannel?
    private var sink: UUID?
    private var recorder: Task<Void, Never>?
    private var deviceId: String?

    public init(hub: EnvServerHub = .shared) {
        self.hub = hub
    }

    public var isRunning: Bool { channel != nil }

    /// Starts serving `deviceId`, or restarts for a new one. `allowedRoots`
    /// is read per command, so un-sharing a folder takes effect at once.
    public func start(
        deviceId: String,
        allowedRoots: @escaping @MainActor () -> [String],
        allowsTerminal: @escaping @MainActor () -> Bool = { false },
        hostHandler: EnvServerDeviceLink.HostHandler? = nil,
        perform: @escaping Perform
    ) {
        if self.deviceId == deviceId, channel != nil { return }
        stop()
        self.deviceId = deviceId
        let hub = self.hub
        let link = EnvServerDeviceLink(
            isOnline: { await MainActor.run { hub.isReady } },
            allowedRoots: { await MainActor.run { allowedRoots() } },
            allowsTerminal: { await MainActor.run { allowsTerminal() } },
            // host.info and host.capture: the Mac app's own answers.
            hostHandler: hostHandler,
            forward: { type, params in
                let connection = try await hub.ready()
                return try await connection.send(type, params: params)
            }
        )
        // One consumer keeps events in the order the env server sent them; the
        // hub relies on that when it replays a session.
        let (events, continuation) = AsyncStream<CodeV2.ServerEventEnvelope>.makeStream()
        sink = hub.addRelaySink { envelope in continuation.yield(envelope) }
        recorder = Task {
            for await envelope in events { await link.record(envelope) }
        }
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let channel = EnvServerDeviceLinkChannel(deviceId: deviceId, link: link, appVersion: appVersion, perform: perform)
        self.link = link
        self.channel = channel
        hub.start()
        Task { await channel.start() }
    }

    public func stop() {
        if let sink { hub.removeRelaySink(sink) }
        sink = nil
        recorder?.cancel()
        recorder = nil
        if let channel { Task { await channel.stop() } }
        channel = nil
        link = nil
        deviceId = nil
    }
}
