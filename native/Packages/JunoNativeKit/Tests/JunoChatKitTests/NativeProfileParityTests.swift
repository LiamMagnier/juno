import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Testing
@testable import JunoChatKit

/// The profile page, the @username and the Mac's billing extras: the pure
/// arithmetic against the same cases as tests/profile-activity.test.ts, each
/// decoder over the routes' JSON, each request's shape, and the view models.
@Suite struct NativeProfileParityTests {
    private let account = try! AccountID("account-profile")

    // MARK: Day keys (profile-activity.test.ts)

    @Test func dayKeysStepAcrossMonthYearAndDSTByWholeDays() {
        #expect(NativeProfileDays.addDays("2026-02-28", 1) == "2026-03-01")
        #expect(NativeProfileDays.addDays("2026-12-31", 1) == "2027-01-01")
        #expect(NativeProfileDays.addDays("2026-03-29", 1) == "2026-03-30")
        #expect(NativeProfileDays.addDays("2026-10-03", -7) == "2026-09-26")
        #expect(NativeProfileDays.weekdayMondayFirst("2026-10-05") == 0)
        #expect(NativeProfileDays.weekdayMondayFirst("2026-10-04") == 6)
        #expect(NativeProfileDays.daysBetween("2026-09-28", "2026-10-03") == 5)
    }

    @Test func todayIsCutInTheReadersZone() throws {
        let instant = try #require(ISO8601DateFormatter().date(from: "2026-10-03T23:30:00Z"))
        #expect(NativeProfileDays.today(in: TimeZone(identifier: "UTC")!, now: instant) == "2026-10-03")
        #expect(NativeProfileDays.today(in: TimeZone(identifier: "Europe/Paris")!, now: instant) == "2026-10-04")
        #expect(NativeProfileDays.today(in: TimeZone(identifier: "America/Los_Angeles")!, now: instant) == "2026-10-03")
    }

    @Test func streaksCurrentMayEndYesterday() {
        let today = "2026-10-03"
        #expect(NativeProfileMath.streaks([], today: today) == .init(current: 0, longest: 0))
        #expect(NativeProfileMath.streaks(["2026-10-01", "2026-10-02", "2026-10-03"], today: today) == .init(current: 3, longest: 3))
        #expect(NativeProfileMath.streaks(["2026-10-01", "2026-10-02"], today: today) == .init(current: 2, longest: 2))
        #expect(NativeProfileMath.streaks(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-10-01"], today: today) == .init(current: 0, longest: 4))
        #expect(NativeProfileMath.streaks(["2026-10-01", "2026-09-30", "2026-09-30", "2026-10-03"], today: today) == .init(current: 1, longest: 2))
    }

    @Test func theGridIs53MondayFirstWeeksEndingWithToday() {
        let today = "2026-10-03" // a Saturday
        let weeks = NativeProfileMath.buildWeeks([.init(date: "2026-10-01", tokens: 500)], today: today)
        #expect(weeks.count == 53)
        #expect(weeks.allSatisfy { $0.count == 7 })
        let last = weeks[52]
        #expect(last[0]?.date == "2026-09-28")
        #expect(last[5]?.date == today)
        #expect(last[6] == nil)
        #expect(last[3]?.tokens == 500)
        #expect(weeks[0][0]?.date == NativeProfileDays.addDays("2026-09-28", -52 * 7))
    }

    @Test func weeklyTotalsAndCumulativeSeries() {
        let today = "2026-10-03"
        let days: [NativeProfileActivity.Day] = [
            .init(date: "2026-09-21", tokens: 10),
            .init(date: "2026-09-27", tokens: 5),
            .init(date: "2026-09-29", tokens: 7),
            .init(date: "2026-10-03", tokens: 3),
        ]
        let weekly = NativeProfileMath.weeklyTotals(NativeProfileMath.buildWeeks(days, today: today, weeks: 2))
        #expect(weekly == [
            .init(start: "2026-09-21", end: "2026-09-27", tokens: 15),
            .init(start: "2026-09-28", end: "2026-10-03", tokens: 10),
        ])
        let cumulative = NativeProfileMath.cumulativeSeries(days, start: "2026-09-28", today: today)
        #expect(cumulative.count == 6)
        #expect(cumulative.map(\.total) == [0, 7, 7, 7, 7, 10])
    }

    @Test func monthLabelsSitOnTheColumnHoldingTheFirst() {
        let weeks = NativeProfileMath.buildWeeks([], today: "2026-10-03")
        let labels = NativeProfileMath.monthLabels(weeks)
        #expect(labels.last?.label == "Oct")
        #expect(labels.filter { $0.label == "Oct" }.count == 2)
        for i in 1..<labels.count { #expect(labels[i].column - labels[i - 1].column >= 3) }
        let october = labels[labels.count - 1]
        #expect(weeks[october.column].contains { $0?.date == "2026-10-01" })
    }

    @Test func heatLevelsAreQuartilesOfActiveDays() {
        let t = NativeProfileMath.heatThresholds([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1_000_000])
        #expect(NativeProfileMath.heatLevel(0, t) == 0)
        #expect(NativeProfileMath.heatLevel(1, t) == 1)
        #expect(NativeProfileMath.heatLevel(1_000_000, t) == 4)
        #expect(NativeProfileMath.heatLevel(5, t) == 3)
        #expect(NativeProfileMath.heatLevel(42, NativeProfileMath.heatThresholds([0, 42, 0])) == 4)
        let quiet = NativeProfileMath.heatThresholds([0, 0])
        #expect(quiet.0 == .infinity && quiet.1 == .infinity && quiet.2 == .infinity)
    }

    @Test func tokenDurationAndDayFormats() {
        #expect(NativeProfileMath.formatTokens(0) == "0")
        #expect(NativeProfileMath.formatTokens(999) == "999")
        #expect(NativeProfileMath.formatTokens(1000) == "1K")
        #expect(NativeProfileMath.formatTokens(12_345) == "12.3K")
        #expect(NativeProfileMath.formatTokens(171_500_000) == "171.5M")
        #expect(NativeProfileMath.formatTokens(71_412_345) == "71.4M")
        #expect(NativeProfileMath.formatTokens(999_960) == "1M")
        #expect(NativeProfileMath.formatTokens(1_234_000_000) == "1.2B")
        #expect(NativeProfileMath.formatDuration(ms: 42_000) == "42s")
        #expect(NativeProfileMath.formatDuration(ms: 38 * 60_000) == "38m")
        #expect(NativeProfileMath.formatDuration(ms: 98 * 60_000) == "1h 38m")
        #expect(NativeProfileMath.formatDuration(ms: 2 * 3_600_000) == "2h")
        #expect(NativeProfileMath.formatDuration(ms: 28 * 3_600_000) == "1d 4h")
        #expect(NativeProfileMath.formatDays(1) == "1 day")
        #expect(NativeProfileMath.formatDays(0) == "0 days")
        #expect(NativeProfileMath.formatShare(0.004) == "<1%")
        #expect(NativeProfileMath.formatShare(0.375) == "38%")
        #expect(NativeProfileMath.formatDayLong("2026-10-02", locale: Locale(identifier: "en_US")) == "Fri, Oct 2, 2026")
    }

    @Test func theHandleComesFromTheEmailLocalPart() {
        #expect(NativeProfileIdentity.derivedHandle(email: "Liam.Magnier+alevr@example.com", name: "Liam") == "liam.magnier")
        #expect(NativeProfileIdentity.derivedHandle(email: "", name: "Zoë Durand") == "zoe.durand")
        #expect(NativeProfileIdentity.derivedHandle(email: "", name: nil) == "you")
    }

    // MARK: Activity read

    static let activityJSON = #"""
    {"username":"liam","handle":"liam","timeZone":"Europe/Paris","today":"2026-10-03","memberSince":"2026-01-12T09:00:00.000Z",
     "lifetimeTokens":171500000,"peakDay":{"date":"2026-09-14","tokens":4200000},"longestTask":{"ms":5880000,"kind":"research"},
     "streak":{"current":5,"longest":19},"activeDays":212,
     "days":[{"date":"2026-09-14","tokens":4200000},{"date":"2026-10-03","tokens":12000.0}],
     "models":[{"model":"anthropic:claude-opus-5-5","label":"Claude Opus 5.5","provider":"anthropic","tokens":120000000,"requests":900,"share":0.7},
               {"model":"other","label":"3 other models","provider":null,"tokens":51500000,"requests":40,"share":0.3}],
     "modelCount":5}
    """#

    @Test func activityDecodesTheRoutesShape() throws {
        let activity = try NativeProfileActivity.decode(Data(Self.activityJSON.utf8))
        #expect(activity.handle == "liam")
        #expect(activity.timeZone == "Europe/Paris")
        #expect(activity.lifetimeTokens == 171_500_000)
        #expect(activity.peakDay == .init(date: "2026-09-14", tokens: 4_200_000))
        #expect(activity.longestTask == .init(ms: 5_880_000, kind: "research"))
        #expect(activity.streak == .init(current: 5, longest: 19))
        #expect(activity.days.last?.tokens == 12_000, "a float count is read as a whole number")
        #expect(activity.models.map(\.provider) == ["anthropic", nil])
        #expect(activity.modelCount == 5)
        #expect(activity.yearTokens == 4_212_000)
    }

    @Test func aNewAccountDecodesWithNullsAndNoModels() throws {
        let json = #"{"username":null,"handle":"you","timeZone":"UTC","today":"2026-10-03","memberSince":null,"lifetimeTokens":0,"peakDay":null,"longestTask":null,"streak":{"current":0,"longest":0},"activeDays":0,"days":[],"models":[],"modelCount":0}"#
        let activity = try NativeProfileActivity.decode(Data(json.utf8))
        #expect(activity.isEmpty)
        #expect(activity.peakDay == nil && activity.longestTask == nil && activity.username == nil)
    }

    @Test func activityRequestCarriesTheZone() async throws {
        let sender = ProfileSender { _ in (200, Self.activityJSON) }
        let activity = try await NativeProfileClient(sender: sender).activity(timeZone: "Europe/Paris", for: account)
        #expect(activity.today == "2026-10-03")
        let request = try #require(await sender.requests.first)
        #expect(request.path == "/api/profile/activity")
        #expect(request.method == .get)
        #expect(request.queryItems == [URLQueryItem(name: "tz", value: "Europe/Paris")])
    }

    @MainActor @Test func theModelLoadsAndKeepsWhatItHasOnAFailedRefresh() async {
        let failing = ProfileSender { _ in (500, #"{"error":"Internal"}"#) }
        let failed = NativeProfileModel(client: NativeProfileClient(sender: failing), accountID: account)
        await failed.load()
        #expect(failed.state == .failed("Internal"))

        let flaky = ProfileSender(script: [(200, Self.activityJSON), (503, #"{"error":"down"}"#)])
        let model = NativeProfileModel(client: NativeProfileClient(sender: flaky), accountID: account, timeZone: "UTC")
        await model.load()
        #expect(model.activity?.handle == "liam")
        await model.load()
        #expect(model.activity?.handle == "liam", "a failed refresh keeps the page")
    }

    // MARK: Username

    @Test func usernameShapeRulesMatchTheWeb() {
        #expect(NativeUsernameRules.shapeProblem("liam") == nil)
        #expect(NativeUsernameRules.shapeProblem("  @Liam.Magnier ") == nil)
        #expect(NativeUsernameRules.normalize("@@Maren") == "maren")
        #expect(NativeUsernameRules.shapeProblem("ab") == .tooShort)
        #expect(NativeUsernameRules.shapeProblem("") == .tooShort)
        #expect(NativeUsernameRules.shapeProblem(String(repeating: "a", count: 31)) == .tooLong)
        #expect(NativeUsernameRules.shapeProblem("liam magnier") == .characters)
        #expect(NativeUsernameRules.shapeProblem("zoë") == .characters)
        #expect(NativeUsernameRules.shapeProblem("liam@home") == .characters)
        #expect(NativeUsernameRules.shapeProblem(".liam") == .start)
        #expect(NativeUsernameRules.shapeProblem("_liam") == .start)
        #expect(NativeUsernameRules.shapeProblem("liam..m") == .dots)
        #expect(NativeUsernameRules.shapeProblem("liam.") == .dots)
        #expect(NativeUsernameRules.shapeProblem("liam__m") == nil)
        #expect(NativeUsernameRules.message(.tooShort) == "Use at least 3 characters.")
    }

    @Test func usernameClientShapes() async throws {
        let sender = ProfileSender { request in
            if request.method == .patch { return (200, #"{"ok":true,"username":"maren","handle":"maren"}"#) }
            if request.queryItems.isEmpty { return (200, #"{"username":null,"handle":"liam.magnier"}"#) }
            return (200, #"{"username":"admin","available":false,"problem":"reserved","message":"That name is reserved."}"#)
        }
        let client = NativeUsernameClient(sender: sender)
        let current = try await client.current(for: account)
        #expect(current.username == nil && current.handle == "liam.magnier")
        let check = try await client.check("admin", for: account)
        #expect(!check.available && check.problem == .reserved && check.message == "That name is reserved.")
        let saved = try await client.save("maren", for: account)
        #expect(saved.username == "maren")
        let requests = await sender.requests
        #expect(requests.map(\.path).allSatisfy { $0 == "/api/account/username" })
        #expect(requests[1].queryItems == [URLQueryItem(name: "check", value: "admin")])
        #expect(requests[2].method == .patch)
        let body = try #require(requests[2].body)
        #expect(String(decoding: body, as: UTF8.self) == #"{"username":"maren"}"#)
    }

    @MainActor @Test func usernameModelChecksSavesAndReportsTaken() async {
        let taken = ProfileFlag()
        let sender = ProfileSender { request in
            if request.method == .patch {
                return taken.value ? (409, #"{"error":"That username is taken.","problem":"taken","field":"username"}"#) : (200, #"{"ok":true,"username":"maren","handle":"maren"}"#)
            }
            if request.queryItems.isEmpty { return (200, #"{"username":"liam","handle":"liam"}"#) }
            let name = request.queryItems.first?.value ?? ""
            if name == "taken1" { return (200, #"{"username":"taken1","available":false,"problem":"taken","message":"That username is taken."}"#) }
            return (200, #"{"username":"\#(name)","available":true}"#)
        }
        let model = NativeUsernameModel(client: NativeUsernameClient(sender: sender), accountID: account, debounce: .zero)
        await model.load()
        #expect(model.username == "liam")
        model.beginEditing()
        #expect(model.check == .current)

        model.setValue("@Ab")
        #expect(model.value == "ab")
        await model.settle()
        #expect(model.check == .invalid("Use at least 3 characters."))
        #expect(model.statusText == "Not allowed. Use at least 3 characters.")

        model.setValue("taken1")
        await model.settle()
        #expect(model.check == .taken("That username is taken."))
        #expect(!model.canSave)

        model.setValue("maren")
        await model.settle()
        #expect(model.check == .available)
        #expect(model.statusText == "Available")
        #expect(await model.save())
        #expect(model.username == "maren" && model.check == .current)

        model.setValue("other1")
        await model.settle()
        taken.value = true
        #expect(await model.save() == false)
        #expect(model.check == .taken("That username is taken."))
        let checks = await sender.requests.filter { !$0.queryItems.isEmpty }.compactMap { $0.queryItems.first?.value }
        #expect(!checks.contains("ab"), "a name the shape refuses never reaches the server")
    }

    @MainActor @Test func usernameModelSurfacesTheRateLimit() async {
        let sender = ProfileSender { request in
            request.method == .patch
                ? (429, #"{"error":"You’ve changed your username a lot today. Try again tomorrow."}"#)
                : (200, #"{"username":"zed1","available":true}"#)
        }
        let model = NativeUsernameModel(client: NativeUsernameClient(sender: sender), accountID: account, debounce: .zero)
        model.setValue("zed1")
        await model.settle()
        #expect(await model.save() == false)
        #expect(model.saveError == "You’ve changed your username a lot today. Try again tomorrow.")
        #expect(model.check == .available)
    }

    // MARK: Billing extras

    @Test func cancellationStateDecodesAndPostsTheAction() async throws {
        let sender = ProfileSender { request in
            request.method == .get
                ? (200, #"{"source":"stripe","active":true,"cancelAtPeriodEnd":false,"recap":{"reference":"AL-SUB-1A2B","name":"Liam","email":"liam@example.com","planName":"Plus","interval":null,"endsAt":"2026-11-03T10:00:00.000Z"}}"#)
                : (200, #"{"ok":true,"cancelAtPeriodEnd":true,"emailed":true}"#)
        }
        let client = NativeBillingClient(sender: sender)
        let state = try await client.cancellationState(for: account)
        #expect(state.source == .stripe && state.active && !state.isHidden)
        #expect(state.recap.planName == "Plus")
        #expect(state.recap.endsAtDate != nil)
        try await client.setCancellation(.cancel, for: account)
        let post = try #require(await sender.requests.last)
        #expect(post.path == "/api/stripe/cancel" && post.method == .post)
        #expect(String(decoding: post.body ?? Data(), as: UTF8.self) == #"{"action":"cancel"}"#)
    }

    @Test func anAppStorePlanAndNoPlanAreTold() throws {
        let appStore = try JSONDecoder().decode(NativeCancellationState.self, from: Data(#"{"source":"app_store","active":true,"cancelAtPeriodEnd":false,"recap":{"reference":"u1","name":null,"email":null,"planName":"Pro","interval":null,"endsAt":null}}"#.utf8))
        #expect(appStore.source == .appStore && !appStore.isHidden)
        let none = try JSONDecoder().decode(NativeCancellationState.self, from: Data(#"{"source":"none","active":false,"cancelAtPeriodEnd":false,"recap":{"reference":"u1","name":null,"email":null,"planName":"Free","interval":null,"endsAt":null}}"#.utf8))
        #expect(none.isHidden)
    }

    @Test func creditsAndTopUpCheckout() async throws {
        let sender = ProfileSender { request in
            switch request.path {
            case "/api/billing/credits":
                return (200, #"{"availableEur":3.5,"nextExpiryMs":1790000000000,"canBuy":true,"plan":"PLUS","packs":[{"id":"5","htEur":5,"creditEur":5},{"id":"20","htEur":20,"creditEur":21}]}"#)
            default:
                return (200, #"{"url":"https://checkout.stripe.com/c/pay/cs_test_top"}"#)
            }
        }
        let client = NativeBillingClient(sender: sender)
        let credits = try await client.credits(for: account)
        #expect(credits.packs.map(\.id) == ["5", "20"])
        #expect(credits.nextExpiry != nil && !credits.isHidden)
        let url = try await client.topUp(pack: "20", for: account)
        #expect(url.host == "checkout.stripe.com")
        let post = try #require(await sender.requests.last)
        #expect(post.path == "/api/stripe/topup")
        #expect(String(decoding: post.body ?? Data(), as: UTF8.self) == #"{"pack":"20"}"#)
    }

    @Test func aTopUpOnFreeSaysTheServersSentence() async {
        let sender = ProfileSender { _ in (402, #"{"error":"plan_required","message":"Top-ups extend a paid plan. Upgrade to Lite or above to add usage."}"#) }
        await #expect(throws: NativeWebRouteError(statusCode: 402, message: "Top-ups extend a paid plan. Upgrade to Lite or above to add usage.")) {
            _ = try await NativeBillingClient(sender: sender).topUp(pack: "5", for: account)
        }
    }

    @Test func pricesShowVATAndWholeEurosDropCents() {
        #expect(NativeBillingFormat.withVat(5) == 6)
        #expect(NativeBillingFormat.withVat(20) == 24)
        #expect(NativeBillingFormat.withVat(8.99) == 10.79)
        #expect(NativeBillingFormat.eur(24) == "€24")
        #expect(NativeBillingFormat.eur(10.8) == "€10.80")
    }

    @Test func referralsDecodeAndSayTheirSentence() async throws {
        let sender = ProfileSender { _ in (200, #"{"code":"LIAM7Q","link":"https://alevr.com/r/LIAM7Q","rewarded":2,"pending":1,"rewardEur":5,"maxRewards":10}"#) }
        let referrals = try await NativeBillingClient(sender: sender).referrals(for: account)
        #expect(referrals.link == "https://alevr.com/r/LIAM7Q")
        #expect(referrals.rewardsSentence == "1 person has joined and not started a paid plan yet.")
        let capped = NativeReferrals(code: "x", link: "x", rewarded: 10, pending: 0, rewardEur: 5, maxRewards: 10)
        #expect(capped.rewardsSentence == "You’ve reached the 10 rewarded invitations an account can earn.")
        #expect(await sender.requests.first?.path == "/api/referrals")
    }

    @MainActor @Test func extrasModelLoadsEachBlockOnItsOwn() async {
        let sender = ProfileSender { request in
            switch request.path {
            case "/api/referrals": return (503, #"{"error":"Referrals are unavailable right now."}"#)
            case "/api/billing/credits": return (200, #"{"availableEur":0,"nextExpiryMs":null,"canBuy":false,"plan":"FREE","packs":[]}"#)
            case "/api/stripe/cancel":
                return request.method == .get
                    ? (200, #"{"source":"stripe","active":true,"cancelAtPeriodEnd":true,"recap":{"reference":"r","name":null,"email":null,"planName":"Plus","interval":null,"endsAt":null}}"#)
                    : (502, #"{"error":"Couldn’t reach the billing provider. Please try again."}"#)
            default: return (404, "{}")
            }
        }
        let model = NativeBillingExtrasModel(client: NativeBillingClient(sender: sender), accountID: account)
        await model.load()
        #expect(model.referrals == nil, "a failed read hides only its own block")
        #expect(model.credits?.isHidden == true)
        #expect(model.cancellation?.cancelAtPeriodEnd == true)
        #expect(await model.setCancellation(.resume) == false)
        #expect(model.cancellationError == "Couldn’t reach the billing provider. Please try again.")
    }
}

private final class ProfileFlag: @unchecked Sendable {
    var value = false
}

/// Answers through a closure (or a script, in order) and keeps every request.
private actor ProfileSender: NativeAuthenticatedRequestSending {
    private let respond: @Sendable (NativeBearerRequest) -> (Int, String)
    private var script: [(Int, String)]
    private(set) var requests: [NativeBearerRequest] = []

    init(respond: @escaping @Sendable (NativeBearerRequest) -> (Int, String)) {
        self.respond = respond
        self.script = []
    }

    init(script: [(Int, String)]) {
        self.respond = { _ in (404, "{}") }
        self.script = script
    }

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = script.isEmpty ? respond(request) : script.removeFirst()
        return HTTPResponse(statusCode: status, headers: try HTTPHeaders(["content-type": "application/json"]), body: Data(body.utf8))
    }
}
