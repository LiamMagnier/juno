import AppKit
import Foundation
import JunoCodeKit
import JunoDesignSystem
import SwiftUI
import Testing

@testable import JunoDesktop

/// "Control this Mac remotely", drawn offscreen in both appearances: the
/// pairing sheet's Phone tab (the QR), its Computer tab (address and code),
/// the approved state, and the paired-devices list with two devices.
///
/// `$JUNO_SNAPSHOT_DIR/mac-pairing-<state>-<light|dark>.png`. Never the
/// screen: an `NSHostingView` in a window that is never ordered in.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the pairing snapshots."
    ),
    .serialized
)
struct DesktopRemotePairingSnapshots {
    private actor Service: DesktopRemotePairingService {
        let offers: [RemotePairingKind: RemotePairingOffer]
        let status: RemotePairingStatus
        let listed: [RemotePair]

        init(offers: [RemotePairingKind: RemotePairingOffer], status: RemotePairingStatus, listed: [RemotePair]) {
            self.offers = offers
            self.status = status
            self.listed = listed
        }

        func createOffer(kind: RemotePairingKind) async throws -> RemotePairingOffer { offers[kind]! }
        func offerStatus(id: String) async throws -> RemotePairingStatus { status }
        func pairs() async throws -> [RemotePair] { listed }
        func revoke(pairID: String) async throws {}
    }

    private static let now = Date(timeIntervalSince1970: 1_760_000_000)
    private static let devices = [
        RemotePair(
            id: "p1", kind: .phone, name: "Liam's iPhone", platform: "ios", deviceId: "mac1",
            createdAt: now.addingTimeInterval(-86_400 * 3), lastUsedAt: now.addingTimeInterval(-60 * 4)
        ),
        RemotePair(
            id: "p2", kind: .browser, name: "Chrome on Windows", platform: "web", deviceId: "mac1",
            createdAt: now.addingTimeInterval(-86_400 * 9), lastUsedAt: now.addingTimeInterval(-86_400 * 2)
        ),
    ]

    private func model(status: RemotePairingStatus = .pending) -> DesktopRemotePairingModel {
        let offers: [RemotePairingKind: RemotePairingOffer] = [
            .phone: RemotePairingOffer(
                id: "o1", kind: .phone,
                token: "rcp1.eyJvIjoibzEiLCJrIjoicGhvbmUifQ.3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                url: "https://alevr.com/pair?t=rcp1.eyJvIjoibzEiLCJrIjoicGhvbmUifQ.3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                code: nil, expiresAt: Self.now.addingTimeInterval(102), deviceName: "Liam's MacBook Pro"
            ),
            .browser: RemotePairingOffer(
                id: "o2", kind: .browser, token: "rcp1.b.sig", url: "https://alevr.com/pair", code: "K7QM-4MZP",
                expiresAt: Self.now.addingTimeInterval(118), deviceName: "Liam's MacBook Pro"
            ),
        ]
        let model = DesktopRemotePairingModel(service: Service(offers: offers, status: status, listed: Self.devices))
        model.now = { Self.now }
        model.clockIsPinned = true
        return model
    }

    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    private func shoot(_ name: String, width: CGFloat, _ view: some View) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                view, name: "mac-pairing-\(name)", width: width, appearance: appearance, into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    @Test
    func phoneShowsTheQR() async throws {
        let model = model()
        await model.requestOffer()
        try await shoot("phone", width: DesktopRemotePairingSheet.width, DesktopRemotePairingSheet(model: model, close: {}))
    }

    @Test
    func computerShowsTheAddressAndCode() async throws {
        let model = model()
        await model.requestOffer()
        model.select(.browser)
        try await Task.sleep(for: .milliseconds(100))
        try await shoot("computer", width: DesktopRemotePairingSheet.width, DesktopRemotePairingSheet(model: model, close: {}))
    }

    @Test
    func approvedSaysWho() async throws {
        let model = model(status: .approved(Self.devices[0]))
        await model.requestOffer()
        await model.poll()
        try await shoot("approved", width: DesktopRemotePairingSheet.width, DesktopRemotePairingSheet(model: model, close: {}))
    }

    @Test
    func unregisteredSaysWhatToDo() async throws {
        let model = DesktopRemotePairingModel(service: nil)
        try await shoot("unregistered", width: DesktopRemotePairingSheet.width, DesktopRemotePairingSheet(model: model, close: {}))
    }

    @Test
    func pairedDevicesListsTwo() async throws {
        let model = model()
        await model.refreshPairs()
        let card = VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack {
                Text("Paired devices")
                    .junoRowLabel()
                Spacer(minLength: 0)
                DesktopOutlineButton(title: "Pair a Device…", icon: .link) {}
            }
            DesktopRemotePairedDeviceList(model: model)
        }
        .padding(JunoSpace.roomy)
        .junoCard(cornerRadius: JunoSettingsMetrics.tileRadius)
        .padding(JunoSpace.section)
        try await shoot("devices", width: 560, card)
    }
}
