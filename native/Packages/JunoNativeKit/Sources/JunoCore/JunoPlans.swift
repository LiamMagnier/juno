import Foundation

// The plan lineup as the apps see it: a Swift copy of `src/lib/plans.ts` and
// `src/lib/price-display.ts`. The Mac's Upgrade sheet, the iPhone's plans
// page, Plan & usage and every plan gate read this one file, so no surface can
// print a price or a plan name of its own. `JunoPlanCatalogTests` pins it to
// the web's values.

// MARK: - Tier

/// A plan this build knows, lowest to highest (`planRank` in plans.ts).
///
/// `MAX` and `MAX20` keep the ids Stripe and the database carry; what a
/// person reads is "Max ×5" and "Max ×10".
public enum JunoPlanTier: String, CaseIterable, Comparable, Codable, Sendable {
    case free = "FREE"
    case lite = "LITE"
    case pro = "PRO"
    case plus = "PLUS"
    case max = "MAX"
    case max20 = "MAX20"
    case ultra = "ULTRA"
    case owner = "OWNER"

    /// Reads a plan id however the server spelled it ("pro", "PRO", " Pro ").
    /// Nil for an id this build does not know — see `JunoAccountPlan` for
    /// what to do with one.
    public init?(serverID: String?) {
        guard let raw = serverID?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            !raw.isEmpty
        else { return nil }
        self.init(rawValue: raw)
    }

    /// `planRank`.
    public var rank: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rank < rhs.rank }

    /// The plans checkout and the App Store sell, lowest first. Free is not
    /// bought and Owner is granted.
    public static let forSale: [JunoPlanTier] = [.lite, .pro, .plus, .max, .max20, .ultra]

    public var isForSale: Bool { Self.forSale.contains(self) }

    public var info: JunoPlanInfo { JunoPlanCatalog.info(self) }
}

// MARK: - Features

/// What a plan unlocks beyond chat (`PlanFeature` in plans.ts).
public enum JunoPlanFeature: String, CaseIterable, Sendable {
    /// The Code product and code execution in chat.
    case code
    /// Orbit, background Work and the chat task tool.
    case agents
    /// Deep research runs.
    case research
    /// Voice mode and voice-to-chat.
    case voice
    /// Web search in chat.
    case webSearch

    /// The lowest plan that includes it — the plan an upgrade prompt names.
    public var minimumTier: JunoPlanTier {
        JunoPlanTier.allCases.first { JunoPlanCatalog.info($0).includes(self) } ?? .pro
    }

    /// How a sentence names it: "Code is part of Pro and up."
    public var title: String {
        switch self {
        case .code: "Code"
        case .agents: "Agents"
        case .research: "Deep research"
        case .voice: "Voice"
        case .webSearch: "Web search"
        }
    }

    /// The one-line upgrade prompt a locked entry point shows, naming the plan
    /// that unlocks it.
    public var upgradePrompt: String {
        "\(title) is part of \(minimumTier.info.name) and up."
    }

    /// The prompt's button.
    public var upgradeAction: String {
        "Upgrade to \(minimumTier.info.name)"
    }
}

// MARK: - Account plan

/// The plan an account is on, as the server named it — including a plan id
/// newer than this build.
///
/// An unknown id is never read as Free: a paying customer on a plan this build
/// has not heard of keeps every feature (the server still enforces its own
/// gates) and sees the server's name for it.
public struct JunoAccountPlan: Hashable, Codable, Sendable, CustomStringConvertible {
    /// The id, upper-cased, exactly as the server sent it otherwise.
    public let id: String
    /// The known tier, or nil for an id this build does not know.
    public let tier: JunoPlanTier?

    public static let free = JunoAccountPlan(tier: .free)

    public init(tier: JunoPlanTier) {
        self.id = tier.rawValue
        self.tier = tier
    }

    /// A missing or empty id is Free (no subscription); anything else is
    /// kept, known or not.
    public init(serverID: String?) {
        let raw = serverID?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        if raw.isEmpty {
            self = .free
        } else {
            self.id = raw
            self.tier = JunoPlanTier(rawValue: raw)
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(serverID: container.decodeNil() ? nil : try container.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(id)
    }

    public var isKnown: Bool { tier != nil }

    /// "Max ×10" for MAX20; an unknown id in title case ("Team" for TEAM).
    public var displayName: String {
        if let tier { return tier.info.name }
        return id.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }.joined(separator: " ")
    }

    /// Anything but Free counts as paid, an unknown plan included.
    public var isPaid: Bool { tier != .free }

    /// Whether the plan includes `feature`. An unknown plan does: the gate
    /// here only decides whether to show an upgrade prompt, and showing one
    /// to a paying customer is the worse mistake.
    public func includes(_ feature: JunoPlanFeature) -> Bool {
        guard let tier else { return true }
        return tier.info.includes(feature)
    }

    /// Whether the plan is `other` or higher. An unknown plan is treated as
    /// at least every plan for sale, below Owner.
    public func isAtLeast(_ other: JunoPlanTier) -> Bool {
        guard let tier else { return other != .owner }
        return tier >= other
    }

    /// The plans an upgrade can move to from here, lowest first. Empty for
    /// Owner, the top plan for sale, and a plan this build does not know.
    public var upgrades: [JunoPlanTier] {
        guard let tier else { return [] }
        return JunoPlanTier.forSale.filter { $0 > tier }
    }

    public var canUpgrade: Bool { !upgrades.isEmpty }

    public var description: String { id }
}

// MARK: - Catalogue

/// One plan's name, price, pitch and gates (`PlanConfig` in plans.ts).
public struct JunoPlanInfo: Equatable, Identifiable, Sendable {
    public let tier: JunoPlanTier
    public let name: String
    /// Whole euros a month, before VAT (`PLANS[plan].price`). Never shown to a
    /// consumer as-is: every price on screen goes through `JunoPlanPrice`.
    public let priceHT: Int
    public let tagline: String
    /// "2.5× Pro": how much usage it carries against Pro, or nil when the
    /// comparison says nothing (Free, Lite, Pro, Owner).
    public let usageMultiple: String?
    public let maxUploadMB: Int
    public let voice: Bool
    public let webSearch: Bool
    public let code: Bool
    public let agents: Bool
    public let research: Bool
    public let features: [String]

    public var id: String { tier.rawValue }

    public func includes(_ feature: JunoPlanFeature) -> Bool {
        switch feature {
        case .code: code
        case .agents: agents
        case .research: research
        case .voice: voice
        case .webSearch: webSearch
        }
    }

    public var price: JunoPlanPrice { JunoPlanPrice(ht: priceHT) }
}

public enum JunoPlanCatalog {
    public static func info(_ tier: JunoPlanTier) -> JunoPlanInfo {
        switch tier {
        case .free: free
        case .lite: lite
        case .pro: pro
        case .plus: plus
        case .max: max
        case .max20: max20
        case .ultra: ultra
        case .owner: owner
        }
    }

    public static var all: [JunoPlanInfo] { JunoPlanTier.allCases.map(info) }

    public static let free = JunoPlanInfo(
        tier: .free, name: "Free", priceHT: 0,
        tagline: "Try it, no card needed.",
        usageMultiple: nil, maxUploadMB: 5,
        voice: false, webSearch: false, code: false, agents: false, research: false,
        features: [
            "A small monthly allowance on fast models",
            "Claude Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash",
            "Import your ChatGPT or Claude history",
            "Export everything you own, any time",
        ]
    )

    public static let lite = JunoPlanInfo(
        tier: .lite, name: "Lite", priceHT: 9,
        tagline: "Everyday chat at an everyday price.",
        usageMultiple: nil, maxUploadMB: 10,
        voice: false, webSearch: true, code: false, agents: false, research: false,
        features: [
            "Fast everyday models: Claude Sonnet, Gemini Flash, GPT-6 Luna, GLM",
            "Monthly usage limit based on tokens",
            "Web search",
            "Memory, canvas, artifacts & file uploads",
        ]
    )

    public static let pro = JunoPlanInfo(
        tier: .pro, name: "Pro", priceHT: 20,
        tagline: "For everyday power use.",
        usageMultiple: nil, maxUploadMB: 20,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Every model: Claude Opus, GPT-6, Gemini Pro, GLM, Muse Spark",
            "Monthly usage limit based on tokens",
            "Code, agents & deep research",
            "Voice mode & voice-to-chat",
            "Memory, canvas, artifacts & file uploads",
        ]
    )

    public static let plus = JunoPlanInfo(
        tier: .plus, name: "Plus", priceHT: 50,
        tagline: "For the days Pro runs out by Thursday.",
        usageMultiple: "2.5× Pro", maxUploadMB: 50,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Every model, at higher priority",
            "2.5× more usage than Pro every month",
            "Code, agents & deep research",
            "Voice mode & voice-to-chat",
            "Memory, canvas, artifacts & file uploads",
        ]
    )

    public static let max = JunoPlanInfo(
        tier: .max, name: "Max ×5", priceHT: 100,
        tagline: "For professionals who live in Alevr.",
        usageMultiple: "5× Pro", maxUploadMB: 50,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Every model, at highest priority",
            "5× more usage than Pro every month",
            "Code, agents & deep research",
            "Voice mode & voice-to-chat",
            "Memory, canvas, artifacts & file uploads",
        ]
    )

    public static let max20 = JunoPlanInfo(
        tier: .max20, name: "Max ×10", priceHT: 200,
        tagline: "For teams of one who never stop.",
        usageMultiple: "10× Pro", maxUploadMB: 50,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Every model, at highest priority",
            "10× more usage than Pro every month",
            "Code, agents & deep research",
            "Voice mode & voice-to-chat",
            "Memory, canvas, artifacts & file uploads",
        ]
    )

    public static let ultra = JunoPlanInfo(
        tier: .ultra, name: "Ultra", priceHT: 500,
        tagline: "Agents running all day, every day.",
        usageMultiple: "25× Pro", maxUploadMB: 200,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Every model, at highest priority",
            "25× more usage than Pro every month",
            "Code, agents & deep research",
            "Uploads up to 200 MB",
            "Voice mode & voice-to-chat",
        ]
    )

    public static let owner = JunoPlanInfo(
        tier: .owner, name: "Owner", priceHT: 0,
        tagline: "Full, unlimited access to everything.",
        usageMultiple: nil, maxUploadMB: 1000,
        voice: true, webSearch: true, code: true, agents: true, research: true,
        features: [
            "Unlimited messages & tokens",
            "Every model, incl. experimental",
            "No rate limits",
            "Uploads up to 1 GB",
            "All current and future features",
        ]
    )
}

// MARK: - Price

/// How a plan's price is shown to a person (`price-display.ts`).
///
/// Plans are sold before VAT and Stripe Tax adds the buyer's VAT at checkout,
/// but a consumer must be shown the price they will pay, tax included
/// (Directive 98/6/EC; Code de la consommation L112-1). So every figure here is
/// HT × 1.2, the French rate, and a year is ten months' price: two months free.
public struct JunoPlanPrice: Equatable, Sendable {
    /// The French standard rate.
    public static let vatRate: Decimal = 0.2
    /// Annual billing charges ten months for twelve.
    public static let annualMonthsBilled = 10

    /// Whole euros a month, before VAT.
    public let ht: Int

    public init(ht: Int) { self.ht = ht }

    public var isFree: Bool { ht == 0 }

    /// Tax-included cents a month: 1080 for Lite.
    public var monthlyCents: Int { Self.ttcCents(ht * 100) }

    /// Tax-included cents a year on annual billing: 10 800 for Lite.
    public var yearlyCents: Int { Self.ttcCents(ht * 100 * Self.annualMonthsBilled) }

    /// What a year costs per month on annual billing, to the cent.
    public var yearlyPerMonthCents: Int { Int((Double(yearlyCents) / 12).rounded()) }

    /// What a year saves against twelve monthly payments, in cents.
    public var yearlySavingCents: Int { monthlyCents * 12 - yearlyCents }

    public func monthly(locale: Locale = .current) -> String { Self.format(cents: monthlyCents, locale: locale) }
    public func yearly(locale: Locale = .current) -> String { Self.format(cents: yearlyCents, locale: locale) }
    public func yearlyPerMonth(locale: Locale = .current) -> String { Self.format(cents: yearlyPerMonthCents, locale: locale) }
    public func monthlyHT(locale: Locale = .current) -> String { Self.format(cents: ht * 100, locale: locale) }

    /// "€24" / "€10.80" in English, "24 €" / "10,80 €" in French. Whole euros
    /// drop the cents, as on the web.
    public static func format(cents: Int, locale: Locale = .current) -> String {
        let whole = cents % 100 == 0
        let amount = Decimal(cents) / 100
        return amount.formatted(
            .currency(code: "EUR")
                .precision(.fractionLength(whole ? 0 : 2))
                .locale(locale)
        )
    }

    /// HT cents → TTC cents, rounded to the cent.
    static func ttcCents(_ htCents: Int) -> Int {
        let ttc = Decimal(htCents) * (1 + vatRate)
        var rounded = Decimal()
        var source = ttc
        NSDecimalRound(&rounded, &source, 0, .plain)
        return NSDecimalNumber(decimal: rounded).intValue
    }

    /// The suffix after a monthly price.
    public static let perMonthSuffix = "/ month incl. VAT"
    /// The suffix after a yearly price.
    public static let perYearSuffix = "/ year incl. VAT"
    /// What annual billing gives, in the words the web uses.
    public static let annualOffer = "2 months free"

    /// The one line under a price list.
    public static let vatNote =
        "Prices include 20% French VAT. Checkout shows the exact amount for your country before you pay; EU businesses with a VAT number pay excl. VAT (reverse charge)."
}

/// Monthly or yearly billing.
public enum JunoBillingInterval: String, CaseIterable, Sendable {
    case month
    case year
}
