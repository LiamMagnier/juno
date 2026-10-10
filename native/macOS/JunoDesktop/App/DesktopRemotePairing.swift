import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import JunoAuth
import JunoCodeKit
import JunoCore
import Observation

// "Control this Mac remotely" (docs/code-v2/REMOTE-CONTROL.md §1): the Mac
// asks the backend for a two-minute, single-use offer and shows it, a QR for a
// phone or a URL plus a code for a browser, polls it until the other device
// approves or denies, and lists what it approved, each with Remove.

/// The pairing routes, as the sheet needs them. A protocol so the sheet's
/// state machine runs against a fake in tests.
protocol DesktopRemotePairingService: Sendable {
    func createOffer(kind: RemotePairingKind) async throws -> RemotePairingOffer
    func offerStatus(id: String) async throws -> RemotePairingStatus
    func pairs() async throws -> [RemotePair]
    func revoke(pairID: String) async throws
}

/// The backend's pairing routes for this Mac, as the signed-in account.
struct DesktopLiveRemotePairingService: DesktopRemotePairingService {
    let client: RemotePairingClient
    /// This Mac's CodeDevice id.
    let deviceID: String
    let accountID: AccountID

    func createOffer(kind: RemotePairingKind) async throws -> RemotePairingOffer {
        try await client.createOffer(deviceId: deviceID, kind: kind, for: accountID)
    }

    func offerStatus(id: String) async throws -> RemotePairingStatus {
        try await client.offerStatus(id: id, for: accountID)
    }

    func pairs() async throws -> [RemotePair] {
        try await client.pairs(deviceId: deviceID, for: accountID)
    }

    func revoke(pairID: String) async throws {
        try await client.revoke(pairId: pairID, for: accountID)
    }
}

/// The pairing sheet and the paired-devices list: one offer at a time, polled
/// while it shows, replaced when it runs out.
@MainActor
@Observable
final class DesktopRemotePairingModel {
    enum Phase: Equatable {
        /// This Mac has no CodeDevice id yet (signed out, or not registered).
        case unregistered
        case loading
        case showing(RemotePairingOffer)
        case approved(name: String)
        case denied
        case failed(String)
    }

    /// Phone (a QR) or Computer (a URL and a code).
    private(set) var kind: RemotePairingKind = .phone
    private(set) var phase: Phase = .loading
    private(set) var pairs: [RemotePair] = []
    private(set) var pairsLoaded = false
    private(set) var pairsError: String?
    private(set) var removingPairID: String?

    @ObservationIgnored let service: (any DesktopRemotePairingService)?
    /// The clock the countdown and expiry read; a test or a snapshot pins it.
    @ObservationIgnored var now: () -> Date = Date.init
    /// A snapshot's pinned clock: the countdown reads ``now`` rather than
    /// the wall clock.
    @ObservationIgnored var clockIsPinned = false
    /// How long the sheet waits between polls.
    @ObservationIgnored var pollInterval: Duration = .milliseconds(1_500)
    /// How long "Paired with …" stays before the sheet closes itself.
    @ObservationIgnored var approvedHold: Duration = .milliseconds(1_400)
    /// Closes the sheet after an approval.
    @ObservationIgnored var onApproved: (() -> Void)?

    @ObservationIgnored private var loop: Task<Void, Never>?
    /// Bumped by each offer request, so a slow answer for an older one is
    /// never shown over a newer one.
    @ObservationIgnored private var generation = 0

    init(service: (any DesktopRemotePairingService)?) {
        self.service = service
        if service == nil { phase = .unregistered }
    }

    // MARK: The sheet

    /// The sheet appeared: ask for an offer and poll it until it settles.
    func start() {
        loop?.cancel()
        guard service != nil else {
            phase = .unregistered
            return
        }
        loop = Task { [weak self] in
            await self?.requestOffer()
            while !Task.isCancelled {
                guard let interval = self?.pollInterval else { return }
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.poll()
                if case .approved = self.phase {
                    try? await Task.sleep(for: self.approvedHold)
                    if !Task.isCancelled { self.onApproved?() }
                    return
                }
            }
        }
    }

    /// The sheet went away: stop polling. The offer simply runs out.
    func stop() {
        loop?.cancel()
        loop = nil
    }

    /// The Phone / Computer segments: a fresh offer of that kind.
    func select(_ kind: RemotePairingKind) {
        guard kind != self.kind else { return }
        self.kind = kind
        Task { await requestOffer() }
    }

    /// A new offer for the current kind ("Show a new code", an expiry, a retry).
    func requestOffer() async {
        guard let service else {
            phase = .unregistered
            return
        }
        generation += 1
        let mine = generation
        let kind = self.kind
        phase = .loading
        do {
            let offer = try await service.createOffer(kind: kind)
            guard mine == generation else { return }
            phase = .showing(offer)
        } catch {
            guard mine == generation else { return }
            phase = .failed(Self.message(for: error))
        }
    }

    /// One look at the offer on screen. An offer past its time is replaced
    /// without asking; a failed look is retried on the next poll.
    func poll() async {
        guard case .showing(let offer) = phase, let service else { return }
        if now() >= offer.expiresAt {
            await requestOffer()
            return
        }
        let status: RemotePairingStatus
        do {
            status = try await service.offerStatus(id: offer.id)
        } catch let error as RemotePairingError where error.isExpiredOrUsed || error.code == "not_found" {
            await requestOffer()
            return
        } catch {
            // A dropped connection: the next poll asks again.
            return
        }
        // The reader may have switched tabs while the answer was on its way.
        guard case .showing(let current) = phase, current.id == offer.id else { return }
        switch status {
        case .pending:
            break
        case .approved(let pair):
            phase = .approved(name: pair?.name ?? Self.fallbackName(for: offer.kind))
            await refreshPairs()
        case .denied:
            phase = .denied
        case .expired:
            await requestOffer()
        }
    }

    /// Whole seconds left on the offer on screen, or nil.
    func secondsLeft(at date: Date? = nil) -> Int? {
        guard case .showing(let offer) = phase else { return nil }
        return max(0, Int(offer.expiresAt.timeIntervalSince(date ?? now()).rounded(.up)))
    }

    /// "1:42".
    static func countdown(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: Paired devices

    func refreshPairs() async {
        guard let service else { return }
        do {
            pairs = try await service.pairs().sorted { $0.createdAt > $1.createdAt }
            pairsError = nil
        } catch {
            pairsError = Self.message(for: error)
        }
        pairsLoaded = true
    }

    /// Remove: the device loses access on its next request.
    func remove(_ pair: RemotePair) async {
        guard let service, removingPairID == nil else { return }
        removingPairID = pair.id
        defer { removingPairID = nil }
        do {
            try await service.revoke(pairID: pair.id)
            pairs.removeAll { $0.id == pair.id }
            pairsError = nil
        } catch {
            pairsError = Self.message(for: error)
        }
    }

    // MARK: Words

    static func fallbackName(for kind: RemotePairingKind) -> String {
        kind == .phone ? "your iPhone" : "your browser"
    }

    /// An error in plain words: the server's own sentence when it sent one.
    static func message(for error: any Error) -> String {
        if let error = error as? RemotePairingError {
            if error.status == 401 { return "Sign in again to pair a device." }
            if error.status == 429 { return "Too many tries. Wait a minute, then try again." }
            return error.message
        }
        if error is URLError {
            return "Alevr could not reach the server. Check your connection, then try again."
        }
        return "Alevr could not make a pairing code. Try again."
    }

    /// "iPhone · Added 3 Oct" style subtitle for a paired device.
    static func subtitle(for pair: RemotePair, now: Date = Date()) -> String {
        let kind = pair.kind == .phone ? (pair.platform.lowercased().contains("ios") ? "iPhone" : "Phone") : "Browser"
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        let used = formatter.localizedString(for: pair.lastUsedAt, relativeTo: now)
        return "\(kind), last used \(used)"
    }
}

// MARK: - QR

/// The pairing QR: CoreImage's generator at correction level H, so the
/// Continuum logo over its centre (about 5% of its area) never stops a scan,
/// scaled by whole modules so it stays crisp at any size.
enum DesktopPairingQR {
    static func image(for text: String, moduleScale: CGFloat = 12) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "H"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: moduleScale, y: moduleScale))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}
