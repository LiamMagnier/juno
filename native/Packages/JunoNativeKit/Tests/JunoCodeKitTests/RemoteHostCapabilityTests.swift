import XCTest
@testable import JunoCodeKit

/// Presence is not capability.
///
/// The defect: the Mac registered itself, listed its workspaces and
/// heartbeated, and the phone read all of that as "this computer can run my
/// work". It could not — nothing on the Mac claims queued tasks. Work
/// dispatched at it was written to the queue and stayed `queued` forever, with
/// a spinner on the phone and no error anywhere in the system.
final class RemoteHostCapabilityTests: XCTestCase {
    private func device(
        online: Bool,
        servesQueuedTasks: Bool
    ) -> NativeCodeDevice {
        NativeCodeDevice(
            id: "dev-1",
            name: "Liam's Mac",
            platform: "macos",
            appVersion: "1.0",
            workspaces: [.init(name: "juno", path: "/opt/juno", key: "w1")],
            activeCount: 0,
            lastSeenAt: Date(),
            online: online,
            servesQueuedTasks: servesQueuedTasks
        )
    }

    func testASignedInHostThatServesNothingCannotAcceptWork() {
        let host = device(online: true, servesQueuedTasks: false)
        XCTAssertTrue(host.online, "it really is signed in and heartbeating")
        XCTAssertFalse(
            host.canAcceptWork,
            "and that must not be enough to offer it as a target"
        )
    }

    func testAnOfflineHostCannotAcceptWorkEvenIfItServesQueuedTasks() {
        XCTAssertFalse(device(online: false, servesQueuedTasks: true).canAcceptWork)
    }

    func testOnlyAnOnlineServingHostAcceptsWork() {
        XCTAssertTrue(device(online: true, servesQueuedTasks: true).canAcceptWork)
    }

    /// A server that predates the capability sends no field, and every host it
    /// knew about served nothing — so absent must read as false, never as true.
    func testAMissingCapabilityDecodesAsNotServing() throws {
        let json = """
        {"devices":[{"id":"dev-1","name":"Mac","platform":"macos","appVersion":"1.0",
        "workspaces":[],"activeCount":0,"lastSeenAt":"2026-08-03T12:00:00Z","online":true}]}
        """
        let devices = try NativeCodeTaskClient.decodeDevices(Data(json.utf8))
        let host = try XCTUnwrap(devices.first)

        XCTAssertTrue(host.online)
        XCTAssertFalse(host.servesQueuedTasks, "absent is false, not true")
        XCTAssertFalse(host.canAcceptWork)
    }

    func testAnAdvertisedCapabilityDecodes() throws {
        let json = """
        {"devices":[{"id":"dev-1","name":"Mac","platform":"macos","appVersion":"1.0",
        "workspaces":[],"activeCount":0,"lastSeenAt":"2026-08-03T12:00:00Z","online":true,
        "servesQueuedTasks":true}]}
        """
        let host = try XCTUnwrap(
            try NativeCodeTaskClient.decodeDevices(Data(json.utf8)).first
        )
        XCTAssertTrue(host.canAcceptWork)
    }
}
