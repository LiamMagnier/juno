import Foundation
import Testing

@testable import JunoCore

/// Pins `JunoPlans.swift` to `src/lib/plans.ts` and `src/lib/price-display.ts`.
@Suite struct JunoPlanCatalogTests {
    private let english = Locale(identifier: "en_IE")
    private let french = Locale(identifier: "fr_FR")

    @Test func theTiersRankAsPlanRankDoes() {
        #expect(JunoPlanTier.allCases.map(\.rawValue) == ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA", "OWNER"])
        #expect(JunoPlanTier.allCases.map(\.rank) == Array(0...7))
        #expect(JunoPlanTier.lite < .pro && JunoPlanTier.max20 < .ultra && JunoPlanTier.ultra < .owner)
        #expect(JunoPlanTier.forSale == [.lite, .pro, .plus, .max, .max20, .ultra])
        #expect(JunoPlanTier(serverID: " pro ") == .pro)
        #expect(JunoPlanTier(serverID: "max20") == .max20)
        #expect(JunoPlanTier(serverID: "TEAM") == nil)
        #expect(JunoPlanTier(serverID: "") == nil)
    }

    @Test func theNamesAndPricesAreTheWebs() {
        #expect(JunoPlanCatalog.all.map(\.name) == ["Free", "Lite", "Pro", "Plus", "Max ×5", "Max ×10", "Ultra", "Owner"])
        #expect(JunoPlanCatalog.all.map(\.priceHT) == [0, 9, 20, 50, 100, 200, 500, 0])
        #expect(JunoPlanCatalog.pro.tagline == "For everyday power use.")
        #expect(JunoPlanCatalog.free.features.first == "A small monthly allowance on fast models")
    }

    @Test func theGatesAreTheWebs() {
        for tier in [JunoPlanTier.free, .lite] {
            let info = tier.info
            #expect(!info.code && !info.agents && !info.research && !info.voice, "\(tier)")
        }
        #expect(!JunoPlanCatalog.free.webSearch)
        #expect(JunoPlanCatalog.lite.webSearch)
        for tier in JunoPlanTier.allCases where tier >= .pro {
            #expect(JunoPlanFeature.allCases.allSatisfy(tier.info.includes), "\(tier)")
        }
        #expect(JunoPlanFeature.code.minimumTier == .pro)
        #expect(JunoPlanFeature.agents.minimumTier == .pro)
        #expect(JunoPlanFeature.research.minimumTier == .pro)
        #expect(JunoPlanFeature.voice.minimumTier == .pro)
        #expect(JunoPlanFeature.webSearch.minimumTier == .lite)
        #expect(JunoPlanFeature.code.upgradePrompt == "Code is part of Pro and up.")
        #expect(JunoPlanFeature.code.upgradeAction == "Upgrade to Pro")
    }

    @Test func pricesAreShownTaxIncluded() {
        #expect(JunoPlanTier.forSale.map { $0.info.price.monthlyCents } == [1080, 2400, 6000, 12000, 24000, 60000])
        #expect(JunoPlanCatalog.lite.price.monthly(locale: english) == "€10.80")
        #expect(JunoPlanCatalog.pro.price.monthly(locale: english) == "€24")
        #expect(JunoPlanCatalog.ultra.price.monthly(locale: english) == "€600")
        #expect(JunoPlanCatalog.lite.price.monthly(locale: french).replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "\u{00A0}", with: " ") == "10,80 €")
        #expect(JunoPlanCatalog.lite.price.monthlyHT(locale: english) == "€9")
        #expect(JunoPlanCatalog.free.price.isFree)
    }

    @Test func aYearIsTenMonths() {
        #expect(JunoPlanPrice.annualMonthsBilled == 10)
        #expect(JunoPlanCatalog.lite.price.yearlyCents == 10_800)
        #expect(JunoPlanCatalog.pro.price.yearly(locale: english) == "€240")
        #expect(JunoPlanCatalog.pro.price.yearlyPerMonth(locale: english) == "€20")
        #expect(JunoPlanCatalog.lite.price.yearlyPerMonth(locale: english) == "€9")
        #expect(JunoPlanCatalog.pro.price.yearlySavingCents == 4800, "two months of 24 €")
        #expect(JunoPlanPrice.annualOffer == "2 months free")
    }

    @Test func anUnknownPlanIsNeverFree() throws {
        let team = JunoAccountPlan(serverID: "team_plus")
        #expect(team.tier == nil)
        #expect(team.id == "TEAM_PLUS")
        #expect(team.displayName == "Team Plus")
        #expect(team.isPaid)
        #expect(JunoPlanFeature.allCases.allSatisfy(team.includes))
        #expect(team.isAtLeast(.ultra) && !team.isAtLeast(.owner))
        #expect(!team.canUpgrade)

        let decoded = try JSONDecoder().decode([JunoAccountPlan].self, from: Data(#"["max20", "SOLO", null]"#.utf8))
        #expect(decoded.map(\.displayName) == ["Max ×10", "Solo", "Free"])
        #expect(String(decoding: try JSONEncoder().encode(decoded[0]), as: UTF8.self) == #""MAX20""#)
    }

    @Test func knownPlansGateAndUpgrade() {
        let lite = JunoAccountPlan(serverID: "lite")
        #expect(!lite.includes(.code) && lite.includes(.webSearch))
        #expect(lite.upgrades == [.pro, .plus, .max, .max20, .ultra])
        #expect(JunoAccountPlan(serverID: nil) == .free)
        #expect(JunoAccountPlan(serverID: "ULTRA").upgrades.isEmpty)
        #expect(JunoAccountPlan(serverID: "OWNER").upgrades.isEmpty)
        #expect(JunoAccountPlan(serverID: "max20").upgrades == [.ultra])
    }
}
