import Foundation
import StoreKit
import JunoCore

/// Standard App Store product identifiers for Juno subscriptions across iOS and macOS.
///
/// One monthly and one yearly auto-renewable subscription per plan for sale,
/// all in one subscription group so moving between them is an upgrade or a
/// downgrade rather than a second subscription. The server maps the same ids
/// to plans (`APP_STORE_PRODUCT_IDS` in src/lib/billing/app-store.ts) and
/// docs/pricing/APP_STORE_PRODUCTS.md lists them for App Store Connect.
public enum JunoStoreKitProductIDs {
    public static let liteMonthly = "com.liammagnier.juno.lite.monthly"
    public static let liteYearly = "com.liammagnier.juno.lite.yearly"
    public static let proMonthly = "com.liammagnier.juno.pro.monthly"
    public static let proYearly = "com.liammagnier.juno.pro.yearly"
    public static let plusMonthly = "com.liammagnier.juno.plus.monthly"
    public static let plusYearly = "com.liammagnier.juno.plus.yearly"
    public static let maxMonthly = "com.liammagnier.juno.max.monthly"
    public static let maxYearly = "com.liammagnier.juno.max.yearly"
    public static let max20Monthly = "com.liammagnier.juno.max20.monthly"
    public static let max20Yearly = "com.liammagnier.juno.max20.yearly"
    public static let ultraMonthly = "com.liammagnier.juno.ultra.monthly"
    public static let ultraYearly = "com.liammagnier.juno.ultra.yearly"

    /// Every product, by the plan and interval it sells.
    public static let catalog: [String: (tier: JunoSubscriptionTier, interval: JunoBillingInterval)] = [
        liteMonthly: (.lite, .month), liteYearly: (.lite, .year),
        proMonthly: (.pro, .month), proYearly: (.pro, .year),
        plusMonthly: (.plus, .month), plusYearly: (.plus, .year),
        maxMonthly: (.max, .month), maxYearly: (.max, .year),
        max20Monthly: (.max20, .month), max20Yearly: (.max20, .year),
        ultraMonthly: (.ultra, .month), ultraYearly: (.ultra, .year),
    ]

    public static let all: Set<String> = Set(catalog.keys)

    /// The product that sells `tier` billed every `interval`, or nil for Free.
    public static func productID(for tier: JunoSubscriptionTier, interval: JunoBillingInterval) -> String? {
        catalog.first { $0.value.tier == tier && $0.value.interval == interval }?.key
    }

    /// The plan a product sells; Free for an id this build does not sell.
    public static func tier(for productID: String) -> JunoSubscriptionTier {
        catalog[productID]?.tier ?? .free
    }
}

/// A plan the App Store sells, plus Free. The cases are `JunoPlanTier`'s
/// for-sale ones; Owner is never bought.
public enum JunoSubscriptionTier: String, Codable, CaseIterable, Sendable {
    case free = "FREE"
    case lite = "LITE"
    case pro = "PRO"
    case plus = "PLUS"
    case max = "MAX"
    case max20 = "MAX20"
    case ultra = "ULTRA"

    public var planTier: JunoPlanTier { JunoPlanTier(rawValue: rawValue) ?? .free }

    public init?(planTier: JunoPlanTier) {
        self.init(rawValue: planTier.rawValue)
    }

    /// `planRank`.
    public var rank: Int { planTier.rank }
}

public struct JunoSubscriptionState: Equatable, Sendable {
    public var tier: JunoSubscriptionTier
    /// The plan the server says the account is on — the one to show. It can
    /// name a plan this build does not know, which `tier` cannot, and such a
    /// plan is never shown as Free.
    public var plan: JunoAccountPlan
    public var isActive: Bool
    public var productID: String?
    public var expirationDate: Date?
    public var willAutoRenew: Bool

    public init(
        tier: JunoSubscriptionTier = .free,
        isActive: Bool = false,
        productID: String? = nil,
        expirationDate: Date? = nil,
        willAutoRenew: Bool = false,
        plan: JunoAccountPlan? = nil
    ) {
        self.tier = tier
        self.plan = plan ?? JunoAccountPlan(tier: tier.planTier)
        self.isActive = isActive
        self.productID = productID
        self.expirationDate = expirationDate
        self.willAutoRenew = willAutoRenew
    }
}

public enum JunoPurchaseOutcome: Sendable {
    case success(tier: JunoSubscriptionTier, transactionID: String)
    case userCancelled
    case pending
    case failed(String)
}

public protocol JunoStoreKitManaging: Sendable {
    func loadProducts() async throws -> [Product]
    func purchase(productID: String) async throws -> JunoPurchaseOutcome
    func restorePurchases() async throws -> JunoSubscriptionState
    func currentSubscriptionState() async -> JunoSubscriptionState
    func verifyAndSync(signedTransactionInfo: String) async throws -> JunoSubscriptionState
}

/// StoreKit 2 In-App Purchase and Subscription Manager for macOS and iOS.
public actor JunoStoreKitManager: JunoStoreKitManaging {
    public static let shared = JunoStoreKitManager()

    private var cachedProducts: [String: Product] = [:]
    private var state: JunoSubscriptionState = JunoSubscriptionState()
    private var transactionListenerTask: Task<Void, Never>?
    private var backendSyncHandler: (@Sendable (String) async throws -> JunoSubscriptionState)?
    private var serverBaseURL: URL?
    private var tokenProvider: (@Sendable () async -> String?)?

    public init(
        backendSyncHandler: (@Sendable (String) async throws -> JunoSubscriptionState)? = nil,
        serverBaseURL: URL? = nil,
        tokenProvider: (@Sendable () async -> String?)? = nil
    ) {
        self.backendSyncHandler = backendSyncHandler
        self.serverBaseURL = serverBaseURL
        self.tokenProvider = tokenProvider
    }

    deinit {
        transactionListenerTask?.cancel()
    }

    public func setBackendSyncHandler(
        _ handler: @escaping @Sendable (String) async throws -> JunoSubscriptionState
    ) {
        self.backendSyncHandler = handler
    }

    public func configureServerSync(
        baseURL: URL,
        tokenProvider: (@Sendable () async -> String?)? = nil
    ) {
        self.serverBaseURL = baseURL
        self.tokenProvider = tokenProvider
    }

    /// Starts listening for outside transaction updates and renewals.
    public func startListener() {
        guard transactionListenerTask == nil else { return }
        transactionListenerTask = Task.detached(priority: .background) { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                await self.handleTransactionUpdate(result)
            }
        }
    }

    /// Loads all available subscription products from the App Store.
    public func loadProducts() async throws -> [Product] {
        startListener()
        let products = try await Product.products(for: JunoStoreKitProductIDs.all)
        var map: [String: Product] = [:]
        for product in products {
            map[product.id] = product
        }
        self.cachedProducts = map
        return products
    }

    /// Purchases a given product by product identifier.
    public func purchase(productID: String) async throws -> JunoPurchaseOutcome {
        startListener()
        var product = cachedProducts[productID]
        if product == nil {
            _ = try await loadProducts()
            product = cachedProducts[productID]
        }
        guard let product else {
            return .failed("Product not found in StoreKit catalog: \(productID)")
        }

        let result = try await product.purchase()

        switch result {
        case .success(let verification):
            let transaction = try checkVerified(verification)
            let tier = tierForProductID(transaction.productID)

            // Deliver signed JWS receipt to server for verification
            let jws = verification.jwsRepresentation
            if let handler = backendSyncHandler {
                _ = try? await handler(jws)
            } else if let baseURL = serverBaseURL {
                let token = await tokenProvider?()
                _ = try? await postTransactionToServer(
                    signedTransactionInfo: jws,
                    baseURL: baseURL,
                    bearerToken: token
                )
            }

            await transaction.finish()

            self.state = JunoSubscriptionState(
                tier: tier,
                isActive: true,
                productID: transaction.productID,
                expirationDate: transaction.expirationDate,
                willAutoRenew: true
            )

            return .success(tier: tier, transactionID: String(transaction.id))

        case .userCancelled:
            return .userCancelled

        case .pending:
            return .pending

        @unknown default:
            return .failed("Unknown StoreKit purchase status.")
        }
    }

    /// Restores previous purchases via AppStore sync and refreshes current entitlement state.
    public func restorePurchases() async throws -> JunoSubscriptionState {
        startListener()
        try? await AppStore.sync()
        return await updateCurrentEntitlements()
    }

    public func currentSubscriptionState() async -> JunoSubscriptionState {
        return state
    }

    public func verifyAndSync(signedTransactionInfo: String) async throws -> JunoSubscriptionState {
        if let handler = backendSyncHandler {
            let updated = try await handler(signedTransactionInfo)
            self.state = updated
            return updated
        }
        if let baseURL = serverBaseURL {
            let token = await tokenProvider?()
            let updated = try await postTransactionToServer(
                signedTransactionInfo: signedTransactionInfo,
                baseURL: baseURL,
                bearerToken: token
            )
            self.state = updated
            return updated
        }
        return state
    }

    /// Posts signed StoreKit 2 transaction info to the server verification endpoint.
    public func postTransactionToServer(
        signedTransactionInfo: String,
        baseURL: URL,
        bearerToken: String? = nil
    ) async throws -> JunoSubscriptionState {
        let endpoint = baseURL.appendingPathComponent("api/v1/billing/app-store")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearerToken, !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let bodyObj = ["signedTransactionInfo": signedTransactionInfo]
        request.httpBody = try JSONSerialization.data(withJSONObject: bodyObj)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "JunoStoreKit", code: status, userInfo: [NSLocalizedDescriptionKey: "Server sync failed: HTTP \(status) - \(body)"])
        }

        struct SyncResponse: Decodable {
            struct Sub: Decodable {
                let plan: String
                let status: String
                let productId: String?
                let currentPeriodEnd: String?
            }
            let success: Bool
            let subscription: Sub
        }

        let decoded = try JSONDecoder().decode(SyncResponse.self, from: data)
        let plan = JunoAccountPlan(serverID: decoded.subscription.plan)
        let tier = plan.tier.flatMap(JunoSubscriptionTier.init(planTier:))
            ?? decoded.subscription.productId.map(JunoStoreKitProductIDs.tier(for:))
            ?? .free
        let state = JunoSubscriptionState(
            tier: tier,
            isActive: decoded.subscription.status.uppercased() == "ACTIVE" && plan.isPaid,
            productID: decoded.subscription.productId,
            expirationDate: nil,
            willAutoRenew: plan.isPaid,
            plan: plan
        )
        return state
    }

    // MARK: - Private Helpers

    private func handleTransactionUpdate(_ verification: VerificationResult<Transaction>) async {
        guard let transaction = try? checkVerified(verification) else { return }

        let jws = verification.jwsRepresentation
        if let handler = backendSyncHandler {
            _ = try? await handler(jws)
        } else if let baseURL = serverBaseURL {
            let token = await tokenProvider?()
            _ = try? await postTransactionToServer(
                signedTransactionInfo: jws,
                baseURL: baseURL,
                bearerToken: token
            )
        }

        await transaction.finish()
        _ = await updateCurrentEntitlements()
    }

    private func updateCurrentEntitlements() async -> JunoSubscriptionState {
        var activeTier: JunoSubscriptionTier = .free
        var activeProductID: String?
        var activeExpiration: Date?

        for await result in Transaction.currentEntitlements {
            guard let transaction = try? checkVerified(result) else { continue }
            if transaction.revocationDate == nil {
                if let exp = transaction.expirationDate, exp <= Date() {
                    continue
                }
                let tier = tierForProductID(transaction.productID)
                if tierRank(tier) > tierRank(activeTier) {
                    activeTier = tier
                    activeProductID = transaction.productID
                    activeExpiration = transaction.expirationDate
                }
            }
        }

        let updated = JunoSubscriptionState(
            tier: activeTier,
            isActive: activeTier != .free,
            productID: activeProductID,
            expirationDate: activeExpiration,
            willAutoRenew: activeTier != .free
        )
        self.state = updated
        return updated
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }

    private func tierForProductID(_ productID: String) -> JunoSubscriptionTier {
        JunoStoreKitProductIDs.tier(for: productID)
    }

    private func tierRank(_ tier: JunoSubscriptionTier) -> Int {
        tier.rank
    }
}
