import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Testing
@testable import JunoChatKit

/// Phase 3 Stage C's data: the settings fields the sync record does not carry,
/// the plan's quota and spend, and the clients behind Settings, Upgrade,
/// onboarding and announcements — each decoder over recorded JSON and each
/// request's shape.
@Suite struct NativeSettingsParityTests {
    private let account = try! AccountID("account-parity")

    // MARK: Settings patch

    @Test func patchSplitsSyncedFieldsFromDirectOnes() throws {
        let patch = NativeSettingsPatch(
            theme: .dark,
            name: "Ines",
            memoryBackgroundLearning: true,
            monthlySpendCapEur: .some(nil)
        )
        #expect(patch.syncedFieldNames == ["theme"])
        #expect(patch.directFieldNames == ["memoryBackgroundLearning", "name", "monthlySpendCapEur"])
        let body = try #require(try patch.directBody())
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["name"] as? String == "Ines")
        #expect(object["memoryBackgroundLearning"] as? Bool == true)
        #expect(object["monthlySpendCapEur"] is NSNull, "null restores the default ceiling")
        #expect(object["theme"] == nil, "a synced field never goes to PATCH")
    }

    @Test func backgroundProviderModeGoesDirect() {
        // The strict sync schema refuses it, so it must take the REST route.
        let patch = NativeSettingsPatch(backgroundProviderMode: .localOnly)
        #expect(patch.directFieldNames == ["backgroundProviderMode"])
        #expect(patch.syncedFieldNames.isEmpty)
    }

    @Test func aPatchWithOnlySyncedFieldsHasNoDirectBody() throws {
        #expect(try NativeSettingsPatch(accent: "teal").directBody() == nil)
    }

    @Test func directFieldsApplyToARecord() throws {
        var settings = Self.settings()
        try NativeMemorySettingsStore<InMemoryTransactionalStore>.applyDirectFields(
            [
                "memorySensitiveTopics": ["health", "finances"],
                "actionApprovalPolicy": "ask_for_any_change",
                "lockdownMode": true,
                "blockedConnectors": ["github"],
                "monthlySpendCapEur": 40,
                "backgroundProviderMode": "local_only",
            ],
            to: &settings
        )
        #expect(settings.memorySensitiveTopics == ["health", "finances"])
        #expect(settings.actionApprovalPolicy == "ask_for_any_change")
        #expect(settings.lockdownMode == true)
        #expect(settings.blockedConnectors == ["github"])
        #expect(settings.monthlySpendCapEur == 40)
        #expect(settings.backgroundProviderMode == .localOnly)

        try NativeMemorySettingsStore<InMemoryTransactionalStore>.applyDirectFields(
            ["monthlySpendCapEur": NSNull()],
            to: &settings
        )
        #expect(settings.monthlySpendCapEur == nil)
    }

    @Test func anOutOfRangeCeilingIsRefused() {
        var settings = Self.settings()
        #expect(throws: NativeMemorySettingsError.self) {
            try NativeMemorySettingsStore<InMemoryTransactionalStore>.applyDirectFields(
                ["monthlySpendCapEur": 100_001],
                to: &settings
            )
        }
    }

    // MARK: Server settings client

    @Test func serverSettingsDecodeTheRouteBody() async throws {
        let sender = RecordingSender(routes: [
            "/api/settings": (200, """
            {"settings":{"customInstructions":"","memoryEnabled":true,"memorySensitiveTopics":["health"],
             "memoryBackgroundLearning":false,"backgroundProviderMode":"same_provider",
             "actionApprovalPolicy":"ask_for_important_actions","lockdownMode":false,
             "blockedConnectors":["composio:gmail"],"monthlySpendCapEur":null,"spendCapDisabled":false}}
            """),
        ])
        let fetched = try await NativeServerSettingsClient(sender: sender).fetch(for: account)
        #expect(fetched.memorySensitiveTopics == ["health"])
        #expect(fetched.memoryBackgroundLearning == false)
        #expect(fetched.actionApprovalPolicy == "ask_for_important_actions")
        #expect(fetched.blockedConnectors == ["composio:gmail"])
        #expect(fetched.monthlySpendCapEur == nil)
        #expect(fetched.spendCapDisabled == false)
    }

    @Test func serverSettingsPatchIsAJSONPatch() async throws {
        let sender = RecordingSender(routes: ["/api/settings": (200, #"{"ok":true}"#)])
        let body = try #require(try NativeSettingsPatch(lockdownMode: true).directBody())
        try await NativeServerSettingsClient(sender: sender).patch(body: body, for: account)
        let request = try #require(await sender.requests.first)
        #expect(request.method == .patch)
        #expect(request.headers["content-type"] == "application/json")
        #expect(String(data: request.body ?? Data(), encoding: .utf8) == #"{"lockdownMode":true}"#)
    }

    @Test func aRefusedPatchCarriesTheServersSentence() async throws {
        let sender = RecordingSender(routes: ["/api/settings": (400, #"{"error":"Invalid input"}"#)])
        await #expect(throws: NativeMemoryAPIError.server(statusCode: 400, message: "Invalid input", retryable: false)) {
            try await NativeServerSettingsClient(sender: sender).patch(body: Data("{}".utf8), for: account)
        }
    }

    // MARK: Usage plan

    @Test func thePlanDecodesQuotaAndSpend() throws {
        let plan = try NativeUsagePlan.decode(Data("""
        {"quota":{"plan":"PRO","used":214,"limit":null,"remaining":null},
         "spend":{"spentMicroUsd":7430000,"budgetMicroUsd":20000000,"remainingMicroUsd":12570000,
          "eurPerUsd":0.92,"reservedMicroUsd":120000,"capSource":"plan","capDisabled":false,
          "windows":{"session":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.37,"resetsAtMs":1790000000000},
                     "weekly":{"spentMicroUsd":1,"budgetMicroUsd":2,"pct":0.61,"resetsAtMs":1790400000000}},
          "billing":{"renewsAtMs":1791000000000,"cancelAtPeriodEnd":false}}}
        """.utf8))
        #expect(plan.planID == "PRO")
        #expect(plan.quota.used == 214)
        #expect(plan.quota.limit == nil)
        #expect(plan.spend.reservedMicroUsd == 120_000)
        #expect(plan.spend.eurPerUsd == 0.92)
        #expect(plan.spend.capSource == "plan")
        #expect(plan.spend.capDisabled == false)
        #expect(plan.session.fraction == 0.37)
    }

    @Test func anOlderUsageBodyStillDecodes() throws {
        let plan = try NativeUsagePlan.decode(Data("""
        {"quota":{"plan":"FREE"},
         "spend":{"spentMicroUsd":0,"budgetMicroUsd":0,
          "windows":{"session":{"pct":0,"resetsAtMs":null},"weekly":{"pct":0,"resetsAtMs":null}},
          "billing":{"renewsAtMs":null,"cancelAtPeriodEnd":false}}}
        """.utf8))
        #expect(plan.quota.used == nil)
        #expect(plan.spend.capSource == nil)
        #expect(plan.spend.eurPerUsd == nil)
    }

    @Test func historyDaysCarryTheirCost() throws {
        let breakdown = try NativeUsageBreakdown.decode(Data("""
        {"range":{"startMs":1788000000000,"endMs":1790592000000,"days":30},
         "totals":{"requests":3,"promptTokens":10,"completionTokens":20,"totalTokens":30,"costMicroUsd":4100},
         "surfaces":[],"models":[],
         "daily":[{"dayMs":1788048000000,"requests":3,"totalTokens":30,"costMicroUsd":4100}],
         "activeDays":1,"currentStreakDays":1,"longestStreakDays":1,"pace":{"lastHour":0,"last24h":3}}
        """.utf8))
        #expect(breakdown.daily.first?.costMicroUsd == 4100)
    }

    // MARK: Billing

    @Test func checkoutPostsThePlanAndReturnsTheStripePage() async throws {
        let sender = RecordingSender(routes: ["/api/stripe/checkout": (200, #"{"url":"https://checkout.stripe.com/c/pay/cs_test_a1"}"#)])
        let url = try await NativeBillingClient(sender: sender).checkout(plan: .pro, for: account)
        #expect(url.absoluteString == "https://checkout.stripe.com/c/pay/cs_test_a1")
        let request = try #require(await sender.requests.first)
        #expect(request.method == .post)
        let object = try #require(try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String])
        #expect(object == ["plan": "PRO", "interval": "month"])
    }

    @Test func aPortalRefusalIsTheServersSentence() async throws {
        let sender = RecordingSender(routes: ["/api/stripe/portal": (400, #"{"error":"No billing account found."}"#)])
        await #expect(throws: NativeWebRouteError(statusCode: 400, message: "No billing account found.")) {
            _ = try await NativeBillingClient(sender: sender).portal(for: account)
        }
    }

    @Test func aNonHTTPSRedirectIsRefused() async throws {
        let sender = RecordingSender(routes: ["/api/stripe/portal": (200, #"{"url":"http://example.test/x"}"#)])
        await #expect(throws: NativeWebRouteError.self) {
            _ = try await NativeBillingClient(sender: sender).portal(for: account)
        }
    }

    // MARK: Announcements

    @Test func announcementsDecodeAndDismissByID() async throws {
        let sender = RecordingSender(routes: [
            "/api/announcements": (200, """
            {"announcement":{"id":"ann_71","title":"Claude Opus 4.8 is here","description":"Longer context and steadier tools.",
             "imageUrl":null,"videoUrl":null,"provider":"anthropic","modelName":"Claude Opus 4.8",
             "newsLabel":null,"newsHref":null,"ctaLabel":"Try it","ctaHref":"/chat/new","published":true}}
            """),
            "/api/announcements/ann_71/dismiss": (200, #"{"ok":true}"#),
        ])
        let client = NativeAnnouncementsClient(sender: sender)
        let announcement = try #require(try await client.current(for: account))
        #expect(announcement.provider == "anthropic")
        #expect(announcement.hasCallToAction)
        try await client.dismiss(id: announcement.id, for: account)
        #expect(await sender.requests.last?.path == "/api/announcements/ann_71/dismiss")
    }

    @Test func noAnnouncementIsNil() throws {
        #expect(try NativeAnnouncementsClient.decode(Data(#"{"announcement":null}"#.utf8)) == nil)
    }

    @Test func anUnsafeAnnouncementIDIsNeverPutInAPath() async throws {
        let sender = RecordingSender(routes: [:])
        try await NativeAnnouncementsClient(sender: sender).dismiss(id: "../admin", for: account)
        #expect(await sender.requests.isEmpty)
    }

    // MARK: Security

    @Test func securityStatusDecodes() async throws {
        let sender = RecordingSender(routes: [
            "/api/account/mfa": (200, #"{"enabled":true,"pending":false,"enabledAt":null,"recoveryCodesRemaining":7,"hasPassword":false}"#),
        ])
        let status = try await NativeAccountSecurityClient(sender: sender).status(for: account)
        #expect(status == NativeAccountSecurityStatus(enabled: true, pending: false, recoveryCodesRemaining: 7, hasPassword: false))
    }

    @Test func theQRCodeDataURLIsDecoded() {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let url = "data:image/png;base64,\(png.base64EncodedString())"
        #expect(NativeAccountSecurityClient.dataURLBytes(url) == png)
        #expect(NativeAccountSecurityClient.dataURLBytes("https://example.test/qr.png") == nil)
    }

    @Test func aWrongPasswordNamesItsField() async throws {
        let sender = RecordingSender(routes: [
            "/api/account/password": (400, #"{"error":"That isn't your current password.","field":"currentPassword"}"#),
        ])
        do {
            try await NativeAccountSecurityClient(sender: sender).changePassword(current: "a", new: "bbbbbbbb", for: account)
            Issue.record("should have thrown")
        } catch let error as NativeWebRouteError {
            #expect(error.field == "currentPassword")
            #expect(error.message == "That isn't your current password.")
        }
    }

    @Test func theAvatarIsMultipart() async throws {
        let sender = RecordingSender(routes: ["/api/profile/avatar": (200, #"{"url":"/api/files/avatars/u1.png"}"#)])
        let url = try await NativeAccountSecurityClient(sender: sender).uploadAvatar(
            data: Data([1, 2, 3]), fileName: "me.png", mimeType: "image/png", for: account
        )
        #expect(url?.absoluteString == "/api/files/avatars/u1.png")
        let request = try #require(await sender.requests.first)
        #expect(request.headers["content-type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    }

    // MARK: Import and account data

    @Test func importRefusesTheWebsWay() {
        #expect(NativeImportClient.refusal(fileName: "export.pdf", byteCount: 10)
            == "Choose a .zip or .json export from ChatGPT, Claude, Gemini or Juno.")
        #expect(NativeImportClient.refusal(fileName: "conversations.zip", byteCount: 101 * 1024 * 1024)
            == "The export must be under 100 MB.")
        #expect(NativeImportClient.refusal(fileName: "Conversations.JSON", byteCount: 10) == nil)
    }

    @Test func importDecodesWhatWasRestored() async throws {
        let sender = RecordingSender(routes: [
            "/api/import": (200, #"{"imported":42,"skipped":3,"projectsImported":2,"memoriesImported":9,"attachmentsImported":5,"attachmentsSkipped":1,"format":"chatgpt"}"#),
        ])
        let result = try await NativeImportClient(sender: sender).importHistory(
            data: Data("{}".utf8), fileName: "conversations.json", for: account
        )
        #expect(result.imported == 42)
        #expect(result.providerLabel == "ChatGPT")
        #expect(result.restoredAnything)
    }

    @Test func deleteAllConversationsIsADelete() async throws {
        let sender = RecordingSender(routes: ["/api/conversations": (200, #"{"ok":true}"#)])
        try await NativeAccountDataClient(sender: sender).deleteAllConversations(for: account)
        #expect(await sender.requests.first?.method == .delete)
    }

    @Test func theJunoPackageAsksForItsFormat() async throws {
        let sender = RecordingSender(routes: ["/api/account/export": (200, #"{"schemaVersion":"juno.export.v2"}"#)])
        let url = try await NativeAccountDataClient(sender: sender).export(format: .juno, for: account)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(await sender.requests.first?.queryItems == [URLQueryItem(name: "format", value: "juno")])
        // The server answered JSON (no file storage), so the file says so.
        #expect(url.pathExtension == "json")
    }

    // MARK: Fixtures

    static func settings() -> NativeAccountSettings {
        NativeAccountSettings(
            id: "settings-1", theme: .system, accent: "coral", defaultModel: "auto",
            customInstructions: "", responseLanguage: "auto", interfaceLocale: "auto",
            personality: "default", memoryEnabled: true, voiceID: nil, favoriteModels: [],
            emailBudgetAlerts: true, emailWeeklyDigest: false,
            updatedAt: Date(timeIntervalSince1970: 1_790_000_000), revision: 1
        )
    }
}

/// Answers each path with a canned status and body, and keeps every request.
private actor RecordingSender: NativeAuthenticatedRequestSending {
    private let routes: [String: (Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(routes: [String: (Int, String)]) {
        self.routes = routes
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = routes[request.path] ?? (404, #"{"error":"Not found"}"#)
        return HTTPResponse(
            statusCode: status,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            body: Data(body.utf8)
        )
    }
}
