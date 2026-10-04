import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoWorkKit
import Testing

@testable import JunoDesktop

/// Phase 3 Stage C: Settings in the web's order with the web's aliases, the
/// save status's timing, text size, the plan catalogue, the meters' words, the
/// first-run rules and the announcement links.
@MainActor
@Suite struct DesktopSettingsParityTests {
    // MARK: Sections

    @Test func sectionsAreTheWebsOrderThenCode() {
        #expect(DesktopSettingsSection.allCases.map(\.label) == [
            "General", "Personalization", "Memory", "Models", "Apps", "Devices",
            "Voice", "Data & privacy", "Account", "Plan & usage", "Code",
        ])
        // Stored and routed by, so the raw value never changes.
        #expect(DesktopSettingsSection.billing.rawValue == "billing")
        #expect(DesktopSettingsSection.usage == .billing)
        #expect(DesktopSettingsSection.connections == .connectors)
    }

    /// The rail's groups change its rhythm, never its order or its set.
    @Test func railGroupsFlattenToTheContractOrder() {
        #expect(DesktopSettingsSection.railGroups.flatMap { $0 } == DesktopSettingsSection.allCases)
    }

    /// Software Update's download line, and its fallback without a size.
    @Test func updateDownloadAmount() {
        #expect(DesktopUpdatePanel.amount(fraction: 0.5, size: nil) == "Downloading")
        #expect(DesktopUpdatePanel.amount(fraction: 0.5, size: 100_000_000).contains(" of "))
    }

    @Test func theWebsAliasesResolve() {
        let cases: [(String, DesktopSettingsSection)] = [
            ("permissions", .devices), ("macs", .devices), ("hosts", .devices),
            ("usage", .billing), ("plan", .billing), ("plan-usage", .billing),
            ("profile", .account), ("security", .account), ("danger", .account),
            ("privacy", .data), ("theme", .general), ("instructions", .personalization),
            ("connected-apps", .connectors), ("billing", .billing), ("Devices", .devices),
            ("nonsense", .general), ("", .general),
        ]
        for (name, section) in cases {
            #expect(DesktopSettingsSection.resolve(name) == section, "\(name)")
        }
    }

    @Test func searchFindsASectionByItsRows() {
        #expect(DesktopSettingsSection.matching("accent") == [.general])
        #expect(DesktopSettingsSection.matching("digest") == [.account])
        #expect(DesktopSettingsSection.matching("ceiling") == [.billing])
        #expect(DesktopSettingsSection.matching("lockdown") == [.connectors])
        #expect(DesktopSettingsSection.matching("SENSITIVE") == [.memory])
        #expect(DesktopSettingsSection.matching("  ").count == DesktopSettingsSection.allCases.count)
        #expect(DesktopSettingsSection.matching("zzzz").isEmpty)
    }

    // MARK: Save status

    @Test func aSaveShowsSavedThenClears() async {
        let saves = DesktopSaveStates(savedHold: .milliseconds(80), failedHold: .milliseconds(160))
        #expect(saves.status("theme") == .idle)
        let ok = await saves.track("theme") { true }
        #expect(ok)
        #expect(saves.status("theme") == .saved)
        try? await Task.sleep(for: .milliseconds(200))
        #expect(saves.status("theme") == .idle)
    }

    @Test func aFailureShowsNotSavedLonger() async {
        let saves = DesktopSaveStates(savedHold: .milliseconds(40), failedHold: .milliseconds(240))
        await saves.track("accent") { false }
        #expect(saves.status("accent") == .failed)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(saves.status("accent") == .failed, "Not saved holds for longer than Saved")
        try? await Task.sleep(for: .milliseconds(300))
        #expect(saves.status("accent") == .idle)
    }

    @Test func aNewerWriteWinsOverALateOlderOne() async {
        let saves = DesktopSaveStates(savedHold: .seconds(5), failedHold: .seconds(5))
        async let slow = saves.track("name") {
            try? await Task.sleep(for: .milliseconds(150))
            return false
        }
        try? await Task.sleep(for: .milliseconds(20))
        await saves.track("name") { true }
        _ = await slow
        #expect(saves.status("name") == .saved, "the older write's failure must not overwrite the newer save")
    }

    @Test func savingShowsNothing() async {
        let saves = DesktopSaveStates()
        let started = AsyncStream<Void>.makeStream()
        let task = Task {
            await saves.track("x") {
                started.continuation.yield()
                try? await Task.sleep(for: .milliseconds(100))
                return true
            }
        }
        for await _ in started.stream { break }
        #expect(saves.status("x") == .saving)
        _ = await task.value
    }

    // MARK: Text size

    @Test func textSizeIsTheWebsSixSteps() {
        #expect(DesktopTextSize.allCases.map(\.rawValue) == ["xs", "small", "default", "large", "xl", "xxl"])
        #expect(DesktopTextSize.allCases.map(\.px) == [14, 15, 16, 17, 18, 20])
        #expect(DesktopTextSize.default.scale == 1)
        #expect(DesktopTextSize.xxl.scale == 1.25)
        #expect(DesktopTextSize.xs.scale == 0.875)
        #expect(DesktopTextSize(stored: "huge") == .default)
        #expect(DesktopTextSize(stored: nil) == .default)
        #expect(DesktopTextSize(step: 9) == .xxl)
        #expect(DesktopTextSize(step: -1) == .xs)
        #expect(DesktopTextSize.storageKey == "juno.textSize")
    }

    // MARK: Plans

    @Test func thePlanCatalogueMatchesTheWeb() {
        let plans = DesktopPlanCatalog.all
        #expect(plans.map(\.id) == ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA", "OWNER"])
        #expect(plans.map(\.name) == ["Free", "Lite", "Pro", "Plus", "Max ×5", "Max ×10", "Ultra", "Owner"])
        #expect(plans.map(\.priceHT) == [0, 9, 20, 50, 100, 200, 500, 0])
        #expect(DesktopPlanCatalog.everyday.map(\.id) == ["LITE", "PRO", "PLUS"])
        #expect(DesktopPlanCatalog.moreUsage.map(\.id) == ["MAX", "MAX20", "ULTRA"])
        #expect(DesktopPlanCatalog.free.tagline == "Try it, no card needed.")
        #expect(DesktopPlanCatalog.free.features.first == "A small monthly allowance on fast models")
        #expect(DesktopPlanCatalog.pro.tagline == "For everyday power use.")
        #expect(!DesktopPlanCatalog.free.voice && !DesktopPlanCatalog.lite.voice && DesktopPlanCatalog.pro.voice)
        #expect(!DesktopPlanCatalog.lite.code && DesktopPlanCatalog.pro.code)
        #expect(DesktopPlanCatalog.plan(id: "pro") == DesktopPlanCatalog.pro)
        #expect(DesktopPlanCatalog.plan(id: "TEAM") == nil)
        #expect(DesktopPlanCatalog.questions.contains { $0.question == "What does yearly billing save?" })
        for plan in DesktopPlanCatalog.everyday + DesktopPlanCatalog.moreUsage {
            #expect(!DesktopUpgradeSheet.highlights(plan).isEmpty, "\(plan.id)")
        }
    }

    @Test func pricesReadAsTheWebWritesThem() {
        let english = Locale(identifier: "en_US")
        #expect(DesktopPlanCatalog.price(cents: 2400, locale: english) == "€24")
        #expect(DesktopPlanCatalog.price(cents: 1080, locale: english) == "€10.80")
        let renews = Date(timeIntervalSince1970: 1_791_331_200) // Oct 7, 2026
        #expect(DesktopSettingsPlanPane.priceSentence(price: 20, renewsAt: renews, cancelAtPeriodEnd: false, locale: english)
            .hasPrefix("€24 a month incl. VAT. Renews Oct"))
        #expect(DesktopSettingsPlanPane.priceSentence(price: 9, renewsAt: nil, cancelAtPeriodEnd: false, locale: english)
            == "€10.80 a month incl. VAT.")
        #expect(DesktopSettingsPlanPane.priceSentence(price: 0, renewsAt: nil, cancelAtPeriodEnd: false) == "Free.")
        #expect(DesktopSettingsPlanPane.priceSentence(price: 100, renewsAt: renews, cancelAtPeriodEnd: true)
            .contains("Access ends"))
    }

    @Test func theGateOpensOnlyForPlansThatIncludeTheFeature() {
        let presenter = DesktopUpgradePresenter()
        let gate = DesktopPlanGate()
        #expect(gate.allows(.code), "open until a plan has been read")
        gate.update(planID: "lite")
        #expect(!gate.allows(.code) && !gate.allows(.agents) && !gate.allows(.research) && !gate.allows(.voice))
        #expect(gate.allows(.webSearch))
        #expect(!gate.require(.code, presenter: presenter))
        #expect(presenter.reason == .code)
        #expect(presenter.presented != nil)
        presenter.dismiss()
        #expect(presenter.reason == nil)
        gate.update(planID: "free")
        #expect(!gate.require(.webSearch, presenter: presenter))
        #expect(presenter.reason?.minimumTier == .lite)
        gate.update(planID: "PRO")
        #expect(JunoPlanFeature.allCases.allSatisfy(gate.allows))
        gate.update(planID: "STUDIO")
        #expect(JunoPlanFeature.allCases.allSatisfy(gate.allows), "an unknown plan is not locked out")
        gate.update(planID: nil)
        #expect(gate.plan?.id == "STUDIO", "a failed read keeps the last plan")
    }

    @Test func checkoutUsesTheChosenInterval() {
        let model = DesktopUpgradeModel(sender: nil, accountID: nil, currentPlanID: "max20")
        #expect(model.interval == .month)
        #expect(model.currentPlan.displayName == "Max ×10")
        #expect(model.currentPlan.upgrades == [.ultra])
    }

    @Test func theMetersSpeakTheWebsWords() {
        #expect(DesktopPlanMeters.countdown(2 * 3600 + 14 * 60 + 30) == "2 hr 14 min")
        #expect(DesktopPlanMeters.countdown(45 * 60) == "45 min")
        #expect(DesktopPlanMeters.countdown(3 * 86_400) == "3 days")
        #expect(DesktopPlanMeters.countdown(26 * 3600) == "1 day")
        #expect(DesktopPlanMeters.countdown(-5) == "now")
        #expect(DesktopPlanMeters.eur(12.4) == "€12.40")
        #expect(DesktopPlanMeters.eur(0.004) == "<€0.01")
        let now = Date()
        #expect(DesktopPlanMeters.sessionSentence(resetsAt: nil, now: now) == "A rolling 5-hour window.")
        #expect(DesktopPlanMeters.sessionSentence(resetsAt: now.addingTimeInterval(-1), now: now) == "Resetting now.")
        #expect(DesktopPlanMeters.weekSentence(resetsAt: nil, now: now) == "A rolling 7-day window.")
        #expect(DesktopSpendCeilingRow.sourceNote("user") == "Set by you")
        #expect(DesktopSpendCeilingRow.sourceNote("personal-default") == "Juno's default for accounts without a plan budget")
        #expect(DesktopSpendCeilingRow.sourceNote(nil) == "Set by your plan")
    }

    @Test func historyFillsThirtyDays() throws {
        let start = 1_788_048_000_000.0
        let breakdown = try NativeUsageBreakdown.decode(Data("""
        {"range":{"startMs":\(start),"endMs":\(start + 29 * 86_400_000),"days":30},
         "totals":{"requests":9,"promptTokens":1,"completionTokens":1,"totalTokens":2,"costMicroUsd":3},
         "surfaces":[],"models":[],
         "daily":[{"dayMs":\(start),"requests":4,"totalTokens":1,"costMicroUsd":1},
                  {"dayMs":\(start + 29 * 86_400_000),"requests":5,"totalTokens":1,"costMicroUsd":2}],
         "activeDays":2,"currentStreakDays":1,"longestStreakDays":1,"pace":{"lastHour":0,"last24h":5}}
        """.utf8))
        let days = DesktopUsageHistory.days(breakdown)
        #expect(days.count == 30)
        #expect(days.first?.requests == 4)
        #expect(days.last?.requests == 5)
        #expect(days.dropFirst().dropLast().allSatisfy { $0.requests == 0 })
    }

    // MARK: Import

    @Test func theImportSentenceIsTheWebs() {
        let result = NativeImportResult(
            imported: 42, skipped: 2, projectsImported: 1, memoriesImported: 7,
            attachmentsImported: 3, attachmentsSkipped: 1, format: "claude"
        )
        #expect(DesktopImportProgress.summary(result)
            == "42 conversations, 1 project, 7 memories and 3 files restored from Claude. 3 already here or unavailable.")
        let nothing = NativeImportResult(
            imported: 0, skipped: 12, projectsImported: 0, memoriesImported: 0,
            attachmentsImported: 0, attachmentsSkipped: 0, format: "juno"
        )
        #expect(DesktopImportProgress.summary(nothing) == "Everything in that export is already here.")
    }

    // MARK: Devices

    @Test func revokedMacsSortLastAndOnlyAnAwakeMacHasTheDot() {
        let now = Date()
        func host(_ id: String, state: String, revoked: Bool = false) -> WorkHostSummary {
            WorkHostSummary(
                hostID: id, deviceID: "d-\(id)", displayName: id, state: state, enabled: true,
                capabilities: [], activeRunCount: 0, queuedRunCount: 0, lastSeenAt: now,
                revokedAt: revoked ? now : nil
            )
        }
        let hosts = [host("old", state: "offline", revoked: true), host("studio", state: "online"), host("air", state: "idle")]
        #expect(DesktopSettingsDevicesPane.ordered(hosts).map(\.hostID) == ["studio", "air", "old"])
    }

    // MARK: First run

    @Test func onboardingOpensOnlyForAnEmptySyncedAccountInChat() {
        #expect(DesktopFirstRunPresenter.shouldOnboard(alreadyOnboarded: false, hasSynced: true, conversationCount: 0, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldOnboard(alreadyOnboarded: true, hasSynced: true, conversationCount: 0, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldOnboard(alreadyOnboarded: false, hasSynced: false, conversationCount: 0, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldOnboard(alreadyOnboarded: false, hasSynced: true, conversationCount: 3, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldOnboard(alreadyOnboarded: false, hasSynced: true, conversationCount: 0, chatShowing: false))
    }

    @Test func anAnnouncementWaitsItsTurnAndStaysDismissed() {
        let item = NativeAnnouncement(id: "ann_1", title: "New", description: "A thing.")
        #expect(DesktopFirstRunPresenter.shouldAnnounce(item, dismissed: [], onboardingPending: false, sheetShowing: false, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldAnnounce(item, dismissed: ["ann_1"], onboardingPending: false, sheetShowing: false, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldAnnounce(item, dismissed: [], onboardingPending: true, sheetShowing: false, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldAnnounce(item, dismissed: [], onboardingPending: false, sheetShowing: true, chatShowing: true))
        #expect(!DesktopFirstRunPresenter.shouldAnnounce(item, dismissed: [], onboardingPending: false, sheetShowing: false, chatShowing: false))
        #expect(!DesktopFirstRunPresenter.shouldAnnounce(nil, dismissed: [], onboardingPending: false, sheetShowing: false, chatShowing: true))
    }

    @Test func evaluateOpensOnboardingThenMarksAnAccountWithChatsDone() throws {
        let defaults = try #require(UserDefaults(suiteName: "juno.tests.first-run.\(UUID().uuidString)"))
        let presenter = DesktopFirstRunPresenter(defaults: defaults)
        let empty = try AccountID("acct-empty")
        presenter.evaluate(accountID: empty, hasSynced: true, conversationCount: 0, chatShowing: true)
        #expect(presenter.sheet == .onboarding)
        presenter.finishOnboarding(accountID: empty)
        #expect(presenter.isOnboarded(empty))
        #expect(presenter.sheet == nil)

        let busy = try AccountID("acct-busy")
        presenter.evaluate(accountID: busy, hasSynced: true, conversationCount: 12, chatShowing: true)
        #expect(presenter.sheet == nil)
        #expect(presenter.isOnboarded(busy), "an account that already has chats needs no tour")
    }

    @Test func dismissingAnAnnouncementIsRememberedOnThisMac() throws {
        let defaults = try #require(UserDefaults(suiteName: "juno.tests.announce.\(UUID().uuidString)"))
        let presenter = DesktopFirstRunPresenter(defaults: defaults)
        let item = NativeAnnouncement(id: "ann_9", title: "New", description: "A thing.")
        presenter.dismissAnnouncement(item, accountID: try AccountID("a"), client: nil)
        #expect(presenter.dismissedAnnouncements.contains("ann_9"))
    }

    @Test func announcementLinksRouteInsideTheApp() {
        #expect(DesktopAnnouncementLink.resolve("/chat/conv_12", base: "https://juno.test")
            == .route(.conversation(id: "conv_12")))
        #expect(DesktopAnnouncementLink.resolve("/agents/agent-iris", base: "https://juno.test")
            == .route(.agent(id: "agent-iris")))
        #expect(DesktopAnnouncementLink.resolve("/news/opus-4-8", base: "https://juno.test")
            == .browser(URL(string: "https://juno.test/news/opus-4-8")!))
        #expect(DesktopAnnouncementLink.resolve("https://anthropic.com/news", base: "https://juno.test")
            == .browser(URL(string: "https://anthropic.com/news")!))
        #expect(DesktopAnnouncementLink.resolve("javascript:alert(1)", base: "https://juno.test") == nil)
        #expect(DesktopAnnouncementLink.resolve("//evil.test/x", base: "https://juno.test") == nil)
        #expect(DesktopAnnouncementLink.resolve(nil) == nil)
    }

    // MARK: Accent

    @Test func aCustomAccentIsClampedTheWebsWay() throws {
        let pale = try #require(JunoCustomAccent(hex: "#f4d7c8"))
        #expect(pale.hsl(dark: false).l == 0.55, "light caps lightness at 55%")
        #expect(pale.hsl(dark: true).l > 0.6)
        #expect(pale.takesDarkInk(dark: true), "a pale accent in dark takes the dark ink")
        #expect(!pale.takesDarkInk(dark: false), "light mode never exceeds 55%, so white")
        let deep = try #require(JunoCustomAccent(hex: "#1d3557"))
        #expect(deep.hsl(dark: true).l == 0.55, "dark lifts lightness to at least 55%")
        #expect(JunoCustomAccent(hex: "coral") == nil)
        #expect(JunoCustomAccent(hex: "#12345") == nil)
    }

    @Test func thePresetsRoundTripAndACustomAccentSticks() {
        let selection = JunoAccentSelection.shared
        let before = selection.custom
        defer { selection.apply(setting: before?.hex ?? "coral") }
        selection.apply(setting: "teal")
        #expect(selection.current == .teal && selection.custom == nil)
        selection.apply(setting: "#ea580c")
        #expect(selection.custom?.hex == "#ea580c")
        #expect(selection.current == .coral)
        selection.apply(setting: "violet")
        #expect(selection.custom == nil && selection.current == .violet)
    }
}

@Suite struct DesktopMenuTitleTests {
    @Test func menuRowsAreTitleCase() {
        #expect("Ask for important actions".desktopMenuTitle == "Ask for Important Actions")
        #expect("Allow what I’ve approved".desktopMenuTitle == "Allow What I’ve Approved")
        #expect("Match my message".desktopMenuTitle == "Match My Message")
        #expect("Juno’s own models only".desktopMenuTitle == "Juno’s Own Models Only")
        #expect("The lab I chat with".desktopMenuTitle == "The Lab I Chat With")
    }
}
