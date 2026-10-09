import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// The Plan & usage section's three self-contained blocks on the web
// (`cancel-subscription.tsx`, `top-up-card.tsx`, `referral-card.tsx`), for the
// Mac, which subscribes through Stripe. The iPhone buys in the App Store, so
// none of this is drawn there.

/// `GET /api/stripe/cancel`: where the plan was bought, whether a cancellation
/// is pending, and the recap the dialog shows before anything is sent
/// (Code de la consommation D215-3).
public struct NativeCancellationState: Equatable, Sendable, Decodable {
    public enum Source: String, Sendable, Decodable {
        case stripe
        case appStore = "app_store"
        case none
    }

    public struct Recap: Equatable, Sendable, Decodable {
        public let reference: String
        public let name: String?
        public let email: String?
        public let planName: String
        public let interval: String?
        /// ISO 8601; nil when the period end is not known.
        public let endsAt: String?

        public init(reference: String, name: String?, email: String?, planName: String, interval: String? = nil, endsAt: String?) {
            self.reference = reference
            self.name = name
            self.email = email
            self.planName = planName
            self.interval = interval
            self.endsAt = endsAt
        }

        public var endsAtDate: Date? {
            guard let endsAt else { return nil }
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return fractional.date(from: endsAt) ?? ISO8601DateFormatter().date(from: endsAt)
        }
    }

    public let source: Source
    public let active: Bool
    public let cancelAtPeriodEnd: Bool
    public let recap: Recap

    public init(source: Source, active: Bool, cancelAtPeriodEnd: Bool, recap: Recap) {
        self.source = source
        self.active = active
        self.cancelAtPeriodEnd = cancelAtPeriodEnd
        self.recap = recap
    }

    /// Nothing to show: no paid plan.
    public var isHidden: Bool { !active || source == .none }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? c.decode(Source.self, forKey: .source)) ?? .none
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
        cancelAtPeriodEnd = try c.decodeIfPresent(Bool.self, forKey: .cancelAtPeriodEnd) ?? false
        recap = try c.decode(Recap.self, forKey: .recap)
    }

    private enum CodingKeys: String, CodingKey { case source, active, cancelAtPeriodEnd, recap }
}

/// `GET /api/billing/credits`.
public struct NativeTopUpCredits: Equatable, Sendable, Decodable {
    public struct Pack: Equatable, Sendable, Decodable, Identifiable {
        /// `"5"` or `"20"`, as `POST /api/stripe/topup` takes it.
        public let id: String
        /// The price before VAT, EUR.
        public let htEur: Double
        /// The model budget it adds, EUR.
        public let creditEur: Double

        public init(id: String, htEur: Double, creditEur: Double) {
            self.id = id
            self.htEur = htEur
            self.creditEur = creditEur
        }
    }

    public let availableEur: Double
    public let nextExpiryMs: Double?
    public let canBuy: Bool
    public let plan: String
    public let packs: [Pack]

    public init(availableEur: Double, nextExpiryMs: Double?, canBuy: Bool, plan: String, packs: [Pack]) {
        self.availableEur = availableEur
        self.nextExpiryMs = nextExpiryMs
        self.canBuy = canBuy
        self.plan = plan
        self.packs = packs
    }

    /// The web renders nothing with no credit and nothing to buy.
    public var isHidden: Bool { availableEur <= 0 && packs.isEmpty }
    public var nextExpiry: Date? { nextExpiryMs.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// `GET /api/referrals`.
public struct NativeReferrals: Equatable, Sendable, Decodable {
    public let code: String
    public let link: String
    public let rewarded: Int
    public let pending: Int
    public let rewardEur: Double
    public let maxRewards: Int

    public init(code: String, link: String, rewarded: Int, pending: Int, rewardEur: Double, maxRewards: Int) {
        self.code = code
        self.link = link
        self.rewarded = rewarded
        self.pending = pending
        self.rewardEur = rewardEur
        self.maxRewards = maxRewards
    }

    public var isCapped: Bool { rewarded >= maxRewards }

    /// The Rewards row's sentence, in the web's words.
    public var rewardsSentence: String {
        if isCapped { return "You’ve reached the \(maxRewards) rewarded invitations an account can earn." }
        if pending > 0 {
            return "\(pending) \(pending == 1 ? "person has" : "people have") joined and not started a paid plan yet."
        }
        return "Each invitation counts once its first payment goes through."
    }
}

/// Prices as the web shows them (`price-display.ts`).
public enum NativeBillingFormat {
    /// The display VAT rate the web uses by default.
    public static let displayVatRate = 0.2

    /// HT → TTC at the display rate, to the cent.
    public static func withVat(_ htEur: Double) -> Double {
        (htEur * (1 + displayVatRate) * 100).rounded() / 100
    }

    /// "€24" / "€10.80" (English), "24 €" (French). Whole euros drop the cents.
    public static func eur(_ amount: Double, locale: Locale = Locale(identifier: "en_IE")) -> String {
        let whole = amount.rounded() == amount
        return amount.formatted(
            .currency(code: "EUR")
                .locale(locale)
                .precision(.fractionLength(whole ? 0 : 2))
        )
    }
}

extension NativeBillingClient {
    public static let cancelPath = "/api/stripe/cancel"
    public static let creditsPath = "/api/billing/credits"
    public static let topUpPath = "/api/stripe/topup"
    public static let referralsPath = "/api/referrals"

    public enum CancellationAction: String, Sendable {
        case cancel
        case resume
    }

    public func cancellationState(for accountID: AccountID) async throws -> NativeCancellationState {
        try await decode(path: Self.cancelPath, fallback: "Couldn’t load your subscription.", for: accountID)
    }

    /// Notifies the cancellation (it ends at the close of the period paid for,
    /// and the confirmation goes out by email), or undoes a pending one.
    public func setCancellation(_ action: CancellationAction, for accountID: AccountID) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["action": action.rawValue], options: [.sortedKeys])
        let response = try await sender.send(
            try NativeBearerRequest(
                path: Self.cancelPath,
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
                body: body
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Couldn’t send that. Please try again.") { throw error }
    }

    public func credits(for accountID: AccountID) async throws -> NativeTopUpCredits {
        try await decode(path: Self.creditsPath, fallback: "Couldn’t load your credit.", for: accountID)
    }

    /// The Stripe Checkout page for a top-up pack (`"5"` or `"20"`), for the
    /// browser. The credit is granted by the webhook once it is paid.
    public func topUp(pack: String, for accountID: AccountID) async throws -> URL {
        let body = try JSONSerialization.data(withJSONObject: ["pack": pack], options: [.sortedKeys])
        let response = try await sender.send(
            try NativeBearerRequest(
                path: Self.topUpPath,
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
                body: body
            ),
            for: accountID
        )
        let object = (try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]) ?? [:]
        let fallback = "Couldn’t start the top-up."
        guard (200...299).contains(response.statusCode) else {
            // A 402 says `{ error: "plan_required", message }`: the sentence is the message.
            let message = (object["message"] as? String) ?? (object["error"] as? String).flatMap { $0.contains(" ") ? $0 : nil }
            throw NativeWebRouteError(statusCode: response.statusCode, message: message ?? fallback)
        }
        guard let address = object["url"] as? String, let url = URL(string: address), url.scheme == "https" else {
            throw NativeWebRouteError(statusCode: response.statusCode, message: fallback)
        }
        return url
    }

    public func referrals(for accountID: AccountID) async throws -> NativeReferrals {
        try await decode(path: Self.referralsPath, fallback: "Referrals are unavailable right now.", for: accountID)
    }

    private func decode<T: Decodable>(path: String, fallback: String, for accountID: AccountID) async throws -> T {
        let response = try await sender.send(
            try NativeBearerRequest(path: path, method: .get, headers: try HTTPHeaders(["accept": "application/json"])),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: fallback) { throw error }
        do {
            return try JSONDecoder().decode(T.self, from: response.body)
        } catch {
            throw NativeWebRouteError(statusCode: response.statusCode, message: fallback)
        }
    }
}

/// The Mac's Plan & usage extras: the cancellation recap, top-ups and the
/// invitation link, each loaded on its own so one failing hides only itself
/// (the web's cards render nothing when their read fails).
@MainActor
@Observable
public final class NativeBillingExtrasModel {
    public private(set) var cancellation: NativeCancellationState?
    public private(set) var credits: NativeTopUpCredits?
    public private(set) var referrals: NativeReferrals?
    /// The pack whose checkout is being opened.
    public private(set) var buyingPack: String?
    public private(set) var sendingCancellation = false
    /// Set once a cancellation is notified, so the sheet shows its receipt.
    public private(set) var cancellationReceived = false
    public private(set) var cancellationError: String?

    private let client: NativeBillingClient?
    private let accountID: AccountID

    public init(client: NativeBillingClient?, accountID: AccountID) {
        self.client = client
        self.accountID = accountID
    }

    public func load() async {
        guard let client else { return }
        async let cancellation = try? client.cancellationState(for: accountID)
        async let credits = try? client.credits(for: accountID)
        async let referrals = try? client.referrals(for: accountID)
        let (c, cr, r) = await (cancellation, credits, referrals)
        self.cancellation = c
        self.credits = cr
        self.referrals = r
    }

    public func reloadCancellation() async {
        guard let client else { return }
        if let state = try? await client.cancellationState(for: accountID) { cancellation = state }
    }

    /// Clears the sheet's receipt and error before it opens.
    public func prepareCancellation() {
        cancellationReceived = false
        cancellationError = nil
    }

    /// Sends the cancellation (or its undo). True when the server took it.
    @discardableResult
    public func setCancellation(_ action: NativeBillingClient.CancellationAction) async -> Bool {
        guard let client else { return false }
        sendingCancellation = true
        cancellationError = nil
        defer { sendingCancellation = false }
        do {
            try await client.setCancellation(action, for: accountID)
            if action == .cancel {
                cancellationReceived = true
            } else {
                await reloadCancellation()
            }
            return true
        } catch {
            cancellationError = (error as? NativeWebRouteError)?.message ?? "Couldn’t send that. Please try again."
            return false
        }
    }

    /// The checkout page for a pack; nil (with the reason thrown) when the
    /// server refused.
    public func checkout(pack: String) async throws -> URL {
        guard let client else { throw NativeWebRouteError(statusCode: 0, message: "Couldn’t start the top-up.") }
        buyingPack = pack
        defer { buyingPack = nil }
        return try await client.topUp(pack: pack, for: accountID)
    }
}
