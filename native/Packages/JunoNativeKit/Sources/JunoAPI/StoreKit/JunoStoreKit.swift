import Foundation
import StoreKit
import JunoCore

/// Standard App Store product identifiers for Juno subscriptions across iOS and macOS.
public enum JunoStoreKitProductIDs {
    public static let proMonthly = "com.liammagnier.juno.pro.monthly"
    public static let proYearly = "com.liammagnier.juno.pro.yearly"
    public static let maxMonthly = "com.liammagnier.juno.max.monthly"
    public static let maxYearly = "com.liammagnier.juno.max.yearly"
    public static let max20Monthly = "com.liammagnier.juno.max20.monthly"
    public static let max20Yearly = "com.liammagnier.juno.max20.yearly"

    public static let all: Set<String> = [
        proMonthly, proYearly,
        maxMonthly, maxYearly,
        max20Monthly, max20Yearly,
    ]
}

public enum JunoSubscriptionTier: String, Codable, Sendable {
    case free = "FREE"
    case pro = "PRO"
    case max = "MAX"
    case max20 = "MAX20"
}

public struct JunoSubscriptionState: Equatable, Sendable {
    public var tier: JunoSubscriptionTier
    public var isActive: Bool
    public var productID: String?
    public var expirationDate: Date?
    public var willAutoRenew: Bool

    public init(
        tier: JunoSubscriptionTier = .free,
        isActive: Bool = false,
        productID: String? = nil,
        expirationDate: Date? = nil,
        willAutoRenew: Bool = false
    ) {
        self.tier = tier
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
        let tier: JunoSubscriptionTier
        switch decoded.subscription.plan.uppercased() {
        case "PRO": tier = .pro
        case "MAX": tier = .max
        case "MAX20": tier = .max20
        default: tier = .free
        }

        let state = JunoSubscriptionState(
            tier: tier,
            isActive: decoded.subscription.status.uppercased() == "ACTIVE" && tier != .free,
            productID: decoded.subscription.productId,
            expirationDate: nil,
            willAutoRenew: tier != .free
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
        let lower = productID.lowercased()
        if lower.contains("max20") { return .max20 }
        if lower.contains("max") { return .max }
        if lower.contains("pro") { return .pro }
        return .free
    }

    private func tierRank(_ tier: JunoSubscriptionTier) -> Int {
        switch tier {
        case .free: return 0
        case .pro: return 1
        case .max: return 2
        case .max20: return 3
        }
    }
}
