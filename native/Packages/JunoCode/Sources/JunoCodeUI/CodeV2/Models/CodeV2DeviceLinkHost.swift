import Foundation
import JunoCodeCore
import JunoCodeLocal

/// Lets the hosted web drive env-server sessions through this Mac (SPEC §2:
/// subscriptions only run locally; the web reaches them via the device link).
///
/// Wires three things together while Remote hosting is on: the hub's events
/// into an ``EnvServerDeviceLink`` buffer, the link's commands into the hub's
/// connection, and an ``EnvServerDeviceLinkChannel`` that pulls the web's
/// requests from the relay and posts the answers. Off is the default, and
/// switching Remote off stops all three.
@MainActor
public final class CodeV2DeviceLinkHost {
    public typealias Perform = EnvServerDeviceLinkChannel.Perform

    private let hub: EnvServerHub
    private var link: EnvServerDeviceLink?
    private var channel: EnvServerDeviceLinkChannel?
    private var sink: UUID?
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
            forward: { type, params in
                let connection = try await hub.ready()
                return try await connection.send(type, params: params)
            }
        )
        sink = hub.addRelaySink { envelope in
            Task { await link.record(envelope) }
        }
        let channel = EnvServerDeviceLinkChannel(deviceId: deviceId, link: link, perform: perform)
        self.link = link
        self.channel = channel
        hub.start()
        Task { await channel.start() }
    }

    public func stop() {
        if let sink { hub.removeRelaySink(sink) }
        sink = nil
        if let channel { Task { await channel.stop() } }
        channel = nil
        link = nil
        deviceId = nil
    }
}
