import AppKit
import CoreImage
import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCodeLocal
import JunoCodeUI
import JunoCore
import JunoSync
import Testing

@testable import JunoDesktop

// Remote control on the Mac (docs/code-v2/REMOTE-CONTROL.md): the pairing
// QR, the pairing sheet's state machine, host.info / host.capture, Handoff
// and the thread sync rules.

// MARK: - Fakes

private actor FakePairingService: DesktopRemotePairingService {
    var offers: [RemotePairingOffer]
    var statuses: [RemotePairingStatus]
    var listed: [RemotePair]
    var created: [RemotePairingKind] = []
    var revoked: [String] = []
    var failCreate: (any Error)?

    init(offers: [RemotePairingOffer], statuses: [RemotePairingStatus] = [], listed: [RemotePair] = []) {
        self.offers = offers
        self.statuses = statuses
        self.listed = listed
    }

    func setFailCreate(_ error: (any Error)?) { failCreate = error }

    func createOffer(kind: RemotePairingKind) async throws -> RemotePairingOffer {
        created.append(kind)
        if let failCreate { throw failCreate }
        return offers.removeFirst()
    }

    func offerStatus(id: String) async throws -> RemotePairingStatus {
        statuses.isEmpty ? .pending : statuses.removeFirst()
    }

    func pairs() async throws -> [RemotePair] { listed }

    func revoke(pairID: String) async throws {
        revoked.append(pairID)
        listed.removeAll { $0.id == pairID }
    }
}

private let base = Date(timeIntervalSince1970: 1_760_000_000)

private func offer(_ id: String, kind: RemotePairingKind = .phone, expires: TimeInterval = 120) -> RemotePairingOffer {
    RemotePairingOffer(
        id: id, kind: kind, token: "rcp1.\(id).sig",
        url: kind == .phone ? "https://alevr.com/pair?t=rcp1.\(id).sig" : "https://alevr.com/pair",
        code: kind == .browser ? "K7QM-4MZP" : nil,
        expiresAt: base.addingTimeInterval(expires), deviceName: "Liam's MacBook Pro"
    )
}

private func pair(_ id: String, name: String, kind: RemotePairingKind = .phone) -> RemotePair {
    RemotePair(
        id: id, kind: kind, name: name, platform: kind == .phone ? "ios" : "web", deviceId: "mac1",
        createdAt: base, lastUsedAt: base
    )
}

// MARK: - QR

struct DesktopPairingQRTests {
    private func decode(_ image: CGImage) -> String? {
        let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let features = detector?.features(in: CIImage(cgImage: image)) as? [CIQRCodeFeature]
        return features?.first?.messageString
    }

    @Test
    func theCodeReadsBackAsTheOfferURL() throws {
        let url = "https://alevr.com/pair?t=rcp1.eyJvIjoib2ZmZXIxIn0.c2lnbmF0dXJl"
        let image = try #require(DesktopPairingQR.image(for: url))
        #expect(image.width == image.height)
        #expect(image.width % 12 == 0, "scaled by whole modules, so it stays crisp")
        #expect(decode(image) == url)
    }

    @Test
    func itStillReadsWithTheLogoPlateOverItsCentre() throws {
        let url = "https://alevr.com/pair?t=rcp1.eyJvIjoib2ZmZXIyIn0.c2lnbmF0dXJl"
        let code = try #require(DesktopPairingQR.image(for: url))
        let side = code.width
        let context = try #require(CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(code, in: CGRect(x: 0, y: 0, width: side, height: side))
        // The sheet's plate: 50pt over a 212pt code.
        let plate = CGFloat(side) * DesktopPairingQRPlate.logoPlate / DesktopPairingQRPlate.code
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: (CGFloat(side) - plate) / 2, y: (CGFloat(side) - plate) / 2, width: plate, height: plate))
        let covered = try #require(context.makeImage())
        #expect(decode(covered) == url)
    }
}

// MARK: - The pairing sheet

@MainActor
struct DesktopRemotePairingModelTests {
    @Test
    func anUnregisteredMacSaysSoInsteadOfAskingForAnOffer() async {
        let model = DesktopRemotePairingModel(service: nil)
        #expect(model.phase == .unregistered)
        await model.requestOffer()
        #expect(model.phase == .unregistered)
    }

    @Test
    func anOfferIsShownThenApprovedAndThePairsRefresh() async {
        let service = FakePairingService(
            offers: [offer("o1")],
            statuses: [.pending, .approved(pair("p1", name: "Liam's iPhone"))],
            listed: [pair("p1", name: "Liam's iPhone")]
        )
        let model = DesktopRemotePairingModel(service: service)
        model.now = { base.addingTimeInterval(10) }
        await model.requestOffer()
        #expect(model.phase == .showing(offer("o1")))
        #expect(model.secondsLeft() == 110)
        await model.poll()
        #expect(model.phase == .showing(offer("o1")), "pending keeps the code up")
        await model.poll()
        #expect(model.phase == .approved(name: "Liam's iPhone"))
        #expect(model.pairs.map(\.id) == ["p1"])
    }

    @Test
    func aDenialSaysSoAndANewCodeCanBeShown() async {
        let service = FakePairingService(offers: [offer("o1"), offer("o2")], statuses: [.denied])
        let model = DesktopRemotePairingModel(service: service)
        model.now = { base }
        await model.requestOffer()
        await model.poll()
        #expect(model.phase == .denied)
        await model.requestOffer()
        #expect(model.phase == .showing(offer("o2")))
    }

    @Test
    func anExpiredOfferIsReplacedWithoutAsking() async {
        let service = FakePairingService(offers: [offer("o1"), offer("o2", expires: 240), offer("o3", expires: 400)], statuses: [.expired])
        let model = DesktopRemotePairingModel(service: service)
        model.now = { base }
        await model.requestOffer()
        // The server says it expired.
        await model.poll()
        #expect(model.phase == .showing(offer("o2", expires: 240)))
        // The clock passes it before the server is asked.
        model.now = { base.addingTimeInterval(241) }
        await model.poll()
        #expect(model.phase == .showing(offer("o3", expires: 400)))
        #expect(await service.created.count == 3)
    }

    @Test
    func switchingToComputerAsksForABrowserOffer() async throws {
        let service = FakePairingService(offers: [offer("o1"), offer("b1", kind: .browser)])
        let model = DesktopRemotePairingModel(service: service)
        await model.requestOffer()
        model.select(.browser)
        try await Task.sleep(for: .milliseconds(100))
        #expect(model.kind == .browser)
        #expect(model.phase == .showing(offer("b1", kind: .browser)))
        #expect(await service.created == [.phone, .browser])
    }

    @Test
    func aRefusalIsShownInTheServersWords() async {
        let service = FakePairingService(offers: [])
        await service.setFailCreate(RemotePairingError(status: 403, code: "forbidden", message: "Pairing needs the Mac app's own sign-in."))
        let model = DesktopRemotePairingModel(service: service)
        await model.requestOffer()
        #expect(model.phase == .failed("Pairing needs the Mac app's own sign-in."))
        await service.setFailCreate(URLError(.notConnectedToInternet))
        await model.requestOffer()
        #expect(model.phase == .failed("Alevr could not reach the server. Check your connection, then try again."))
    }

    @Test
    func removeRevokesAndDropsTheRow() async {
        let service = FakePairingService(
            offers: [], listed: [pair("p1", name: "iPhone"), pair("p2", name: "Chrome on Windows", kind: .browser)]
        )
        let model = DesktopRemotePairingModel(service: service)
        await model.refreshPairs()
        #expect(model.pairs.count == 2)
        await model.remove(model.pairs[0])
        #expect(await service.revoked.count == 1)
        #expect(model.pairs.count == 1)
    }

    @Test
    func theCountdownReadsMinutesAndSeconds() {
        #expect(DesktopRemotePairingModel.countdown(120) == "2:00")
        #expect(DesktopRemotePairingModel.countdown(65) == "1:05")
        #expect(DesktopRemotePairingModel.countdown(7) == "0:07")
    }
}

// MARK: - host.info / host.capture

struct DesktopRemoteHostResponderTests {
    private static func png(width: Int, height: Int) -> Data {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return DesktopRemoteHostResponder.png(context.makeImage()!)!
    }

    private func responder(
        simulator: String? = nil, preview: Data? = nil, simulatorPNG: Data = Data()
    ) -> DesktopRemoteHostResponder {
        DesktopRemoteHostResponder(
            facts: { .init(name: "Liam's MacBook Pro", sharedFolders: ["/Users/liam/app"], terminal: true, appVersion: "1.10.6") },
            bootedSimulator: { simulator },
            hasPreview: { preview != nil },
            captureSimulator: { _ in simulatorPNG },
            capturePreview: { preview },
            now: { base }
        )
    }

    @Test
    func infoNamesTheMacItsFoldersAndWhatItCanCapture() async throws {
        let result = try await responder(simulator: "UDID-1", preview: Self.png(width: 4, height: 4))
            .handle(.hostInfo, .object([:]))
        let info = try JSONDecoder().decode(CodeV2.HostInfo.self, from: JSONEncoder().encode(try #require(result)))
        #expect(info == CodeV2.HostInfo(
            name: "Liam's MacBook Pro", sharedFolders: ["/Users/liam/app"], terminal: true,
            captures: [.preview, .simulator], appVersion: "1.10.6"
        ))
        let bare = try await responder().info()
        #expect(bare.captures.isEmpty)
    }

    @Test
    func aCaptureIsBase64PNGDownscaledToTheLongEdge() async throws {
        let result = try await responder(simulator: "UDID-1", simulatorPNG: Self.png(width: 3_200, height: 1_000))
            .handle(.hostCapture, .object(["target": .string("simulator")]))
        let capture = try JSONDecoder().decode(CodeV2.HostCapture.self, from: JSONEncoder().encode(try #require(result)))
        #expect(capture.mime == "image/png")
        #expect(capture.width == 1_600)
        #expect(capture.height == 500)
        #expect(capture.at == DesktopRemoteHostResponder.timestamp(base))
        let data = try #require(Data(base64Encoded: capture.data))
        let image = try #require(NSBitmapImageRep(data: data))
        #expect(image.pixelsWide == 1_600)

        let small = try await responder(preview: Self.png(width: 800, height: 600)).capture(.preview)
        #expect(small.width == 800 && small.height == 600, "a small picture is left at its size")
    }

    @Test
    func nothingToCaptureIsSaidPlainly() async {
        do {
            _ = try await responder().capture(.simulator)
            Issue.record("expected a refusal")
        } catch let EnvServerConnectionError.server(code, message) {
            #expect(code == .notReady)
            #expect(message.hasPrefix("No Simulator is running on this Mac."))
        } catch {
            Issue.record("unexpected \(error)")
        }
        do {
            _ = try await responder().capture(.preview)
            Issue.record("expected a refusal")
        } catch let EnvServerConnectionError.server(code, message) {
            #expect(code == .notReady)
            #expect(message.hasPrefix("No preview is open on this Mac."))
        } catch {
            Issue.record("unexpected \(error)")
        }
        do {
            _ = try await responder().handle(.hostCapture, .object(["target": .string("screen")]))
            Issue.record("expected a refusal")
        } catch let EnvServerConnectionError.server(code, _) {
            #expect(code == .badRequest)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test
    func theLinkHandsHostCommandsToTheResponder() async throws {
        let responder = responder(simulator: "UDID-1")
        let link = EnvServerDeviceLink(
            allowedRoots: { ["/Users/liam/app"] },
            hostHandler: { type, params in try await responder.handle(type, params) },
            forward: { _, _ in nil }
        )
        let reply = await link.handle(EnvLinkRequest(kind: .rpc, command: .init(id: "c1", type: "host.info", params: .object([:]))))
        #expect(reply.responses?.first?.ok == true)
        let refused = await link.handle(EnvLinkRequest(
            kind: .rpc, command: .init(id: "c2", type: "host.capture", params: .object(["target": .string("preview")]))
        ))
        #expect(refused.responses?.first?.ok == false)
        #expect(refused.responses?.first?.error?.code == .notReady)
    }
}

// MARK: - Handoff

@MainActor
struct DesktopHandoffTests {
    @Test
    func anActivityCarriesIdsAndTheWebFallback() {
        let activity = NSUserActivity(activityType: JunoHandoff.activityType)
        let base = URL(string: "https://alevr.com")!
        DesktopHandoff.configure(activity, with: .chat("conv_1", title: "Trip plan"), base: base)
        #expect(activity.title == "Trip plan")
        #expect(activity.webpageURL?.absoluteString == "https://alevr.com/chat/conv_1")
        #expect(activity.isEligibleForHandoff)
        #expect(!activity.isEligibleForSearch)
        #expect(JunoHandoff(userInfo: activity.userInfo) == .chat("conv_1", title: "Trip plan"))

        DesktopHandoff.configure(activity, with: .code(deviceID: "mac1", sessionID: "env_7"), base: base)
        #expect(activity.title == "Alevr Code")
        #expect(activity.webpageURL?.absoluteString == "https://alevr.com/code")
        #expect(JunoHandoff(userInfo: activity.userInfo)?.deviceID == "mac1")
    }

    @Test
    func continuingLandsOnTheChatOrThisMacsCodeThread() {
        let bindings = ["env_7": "thread_7"]
        #expect(DesktopHandoff.destination(for: .chat("c1"), thisDeviceID: "mac1") { bindings[$0] } == .conversation("c1"))
        #expect(DesktopHandoff.destination(for: .code(deviceID: "mac1", sessionID: "env_7"), thisDeviceID: "mac1") { bindings[$0] }
            == .codeSession("thread_7"))
        #expect(DesktopHandoff.destination(for: .code(deviceID: "mac1", sessionID: "env_9"), thisDeviceID: "mac1") { bindings[$0] }
            == .code, "a session this Mac no longer has opens Code")
        #expect(DesktopHandoff.destination(for: .code(deviceID: "mac2", sessionID: "env_7"), thisDeviceID: "mac1") { bindings[$0] }
            == .code, "another Mac's session opens Code")
    }

    @Test
    func aHandoffNotificationIsRead() {
        #expect(DesktopHandoff.handoff(fromNotification: ["handoff": "chat", "conversationId": "c1"])?.id == "c1")
        let code = DesktopHandoff.handoff(fromNotification: ["handoff": "code", "deviceID": "mac1", "sessionID": "s1"])
        #expect(code == .code(deviceID: "mac1", sessionID: "s1"))
        #expect(DesktopHandoff.handoff(fromNotification: ["handoff": "code", "deviceID": "mac1"]) == nil)
        #expect(DesktopHandoff.handoff(fromNotification: ["kind": "chat"]) == nil)
        #expect(DesktopHandoff.handoff(fromNotification: ["handoff": "chat", "conversationId": "../etc"]) == nil)
    }

    @Test
    func continueOnTheWebOpensTheFallbackAndIPhoneNeedsAnAccount() async {
        var opened: URL?
        let web = await DesktopHandoff.continueOn(.web, .chat("c1"), client: nil, accountID: nil) { opened = $0 }
        #expect(web == .openedWeb)
        #expect(opened == JunoHandoff.chat("c1").webURL(base: DesktopHandoff.webBase))
        let phone = await DesktopHandoff.continueOn(.ios, .chat("c1"), client: nil, accountID: nil) { _ in }
        #expect(phone == .failed("Sign in to send this thread to your iPhone."))
    }

    @Test
    func theConversationMenuOffersContinueRowsInTitleCase() {
        #expect(DesktopConversationMenu.continueRows.map(\.title) == ["Continue on iPhone", "Continue on the Web"])
        #expect(DesktopConversationMenu.continueRows.map(\.target) == [.ios, .web])
    }
}

// MARK: - Thread sync

private actor FakeSyncService: DesktopThreadSyncService {
    var stored: [String: ThreadSyncState] = [:]
    var writes: [(String, ThreadSyncUpdate)] = []

    func put(_ state: ThreadSyncState) { stored[state.key] = state }

    func thread(_ key: String) async throws -> ThreadSyncState? { stored[key] }

    func write(_ key: String, _ update: ThreadSyncUpdate) async throws { writes.append((key, update)) }

    func changes(after cursor: String?, waitMs: Int, keys: [String]) async throws -> (threads: [ThreadSyncState], cursor: String?) {
        if waitMs > 0 { try await Task.sleep(for: .seconds(30)) }
        return ([], "c0")
    }
}

@MainActor
struct DesktopThreadSyncTests {
    private func state(_ key: String, draft: String, at: Date, by: String = "iphone") -> ThreadSyncState {
        ThreadSyncState(key: key, draft: draft, draftUpdatedAt: at, draftBy: by, updatedAt: at)
    }

    @Test
    func openingFillsOnlyAnEmptyFieldAndNeverWithItsOwnEcho() {
        let s = state("chat:c1", draft: "from the phone", at: base)
        #expect(DesktopThreadSync.shouldApplyDraft(s, local: "", lastLocalEdit: nil, now: base, syncerAllows: true, opening: true))
        #expect(!DesktopThreadSync.shouldApplyDraft(s, local: "mine", lastLocalEdit: nil, now: base, syncerAllows: true, opening: true))
        let echo = state("chat:c1", draft: "typed here", at: base, by: DesktopThreadSync.device)
        #expect(!DesktopThreadSync.shouldApplyDraft(echo, local: "", lastLocalEdit: nil, now: base, syncerAllows: true, opening: true))
        #expect(!DesktopThreadSync.shouldApplyDraft(s, local: "", lastLocalEdit: nil, now: base, syncerAllows: false, opening: true))
    }

    @Test
    func aLiveDraftWaitsForTypingHereToSettle() {
        let typed = base
        let newer = state("chat:c1", draft: "phone wins", at: typed.addingTimeInterval(5))
        #expect(!DesktopThreadSync.shouldApplyDraft(newer, local: "half", lastLocalEdit: typed, now: typed.addingTimeInterval(1), syncerAllows: true, opening: false),
            "typing a second ago holds it off")
        #expect(DesktopThreadSync.shouldApplyDraft(newer, local: "half", lastLocalEdit: typed, now: typed.addingTimeInterval(6), syncerAllows: true, opening: false))
        let older = state("chat:c1", draft: "stale", at: typed.addingTimeInterval(-5))
        #expect(!DesktopThreadSync.shouldApplyDraft(older, local: "half", lastLocalEdit: typed, now: typed.addingTimeInterval(6), syncerAllows: true, opening: false),
            "an older draft never replaces newer typing")
    }

    @Test
    func newerPrefsOnly() {
        var s = state("code:mac1:s1", draft: "", at: base)
        s.prefs = ThreadSyncPrefs(model: "claude/opus", mode: "full")
        s.prefsUpdatedAt = base
        #expect(DesktopThreadSync.newerPrefs(s, than: nil) == s.prefs)
        #expect(DesktopThreadSync.newerPrefs(s, than: base) == nil)
        #expect(DesktopThreadSync.newerPrefs(s, than: base.addingTimeInterval(-1)) == s.prefs)
    }

    @Test
    func openMarksReadFillsTheFieldAndSendIsClearedEverywhere() async throws {
        let service = FakeSyncService()
        await service.put(state("chat:c1", draft: "draft from the phone", at: base))
        let sync = DesktopThreadSync()
        sync.configure(service: service, draftDelay: .milliseconds(20))
        var field = ""
        sync.open("chat:c1", currentDraft: { field }, applyDraft: { field = $0 })
        try await Task.sleep(for: .milliseconds(200))
        #expect(field == "draft from the phone")
        let writes = await service.writes
        #expect(writes.first?.0 == "chat:c1")
        #expect(writes.first?.1.read == true)

        // The field change that applying caused is not written back.
        sync.draftChanged("chat:c1", text: field)
        try await Task.sleep(for: .milliseconds(100))
        #expect(await service.writes.count == 1)

        // Typing is debounced into one write; sending clears at once.
        sync.draftChanged("chat:c1", text: "draft from the phone, edited")
        try await Task.sleep(for: .milliseconds(150))
        sync.draftChanged("chat:c1", text: "")
        try await Task.sleep(for: .milliseconds(100))
        let all = await service.writes.map(\.1.draft)
        #expect(all.compactMap { $0 } == ["draft from the phone, edited", ""])
        sync.close("chat:c1")
        sync.reset()
    }

    @Test
    func codePrefsRoundTripThroughTheSeam() {
        let synced = CodeV2SyncedPrefs(model: "claude/claude-opus-5", effort: "high", mode: "full", interactionMode: "plan", team: "solo", skills: ["tidy"])
        let wire = DesktopCodeThreadContinuity.prefs(synced)
        #expect(wire == ThreadSyncPrefs(model: "claude/claude-opus-5", effort: "high", mode: "full", interactionMode: "plan", team: "solo", skills: ["tidy"]))
        #expect(DesktopCodeThreadContinuity.prefs(wire) == synced)
        #expect(DesktopCodeThreadContinuity(deviceID: "mac1").key("s1") == "code:mac1:s1")
    }
}
