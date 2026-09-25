import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// A refusal from one of the web's own routes (`{ "error": "…", "field": "…" }`),
/// with the server's sentence kept whole so the surface can say it.
public struct NativeWebRouteError: Error, Equatable, LocalizedError, Sendable {
    public let statusCode: Int
    public let message: String
    /// The form field the server blamed, when it named one
    /// (`currentPassword`, `newPassword`, `email`).
    public let field: String?

    public init(statusCode: Int, message: String, field: String? = nil) {
        self.statusCode = statusCode
        self.message = message
        self.field = field
    }

    public var errorDescription: String? { message }

    /// Reads a failed response, or returns nil for a success.
    static func from(_ response: HTTPResponse, fallback: String) -> NativeWebRouteError? {
        guard !(200...299).contains(response.statusCode) else { return nil }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return NativeWebRouteError(
            statusCode: response.statusCode,
            message: message ?? fallback,
            field: object?["field"] as? String
        )
    }
}

/// Checkout and the billing portal: both are Stripe pages the browser opens
/// (`POST /api/stripe/checkout`, `POST /api/stripe/portal`). The app never
/// sees a card; it only asks the server for the address to send the reader to.
public struct NativeBillingClient: Sendable {
    /// The plans checkout sells, as the route's schema names them.
    public enum Plan: String, Sendable, CaseIterable {
        case pro = "PRO"
        case max = "MAX"
        case max20 = "MAX20"
    }

    /// `month` or `year`. Only monthly is offered on the Mac until the server
    /// says which intervals are for sale (P3-8).
    public enum Interval: String, Sendable {
        case month
        case year
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// The Stripe Checkout page for `plan`.
    public func checkout(plan: Plan, interval: Interval = .month, for accountID: AccountID) async throws -> URL {
        let body = try JSONSerialization.data(
            withJSONObject: ["plan": plan.rawValue, "interval": interval.rawValue],
            options: [.sortedKeys]
        )
        return try await redirect(
            path: "/api/stripe/checkout",
            body: body,
            fallback: "Couldn’t start checkout.",
            for: accountID
        )
    }

    /// The Stripe billing portal for this account.
    public func portal(for accountID: AccountID) async throws -> URL {
        try await redirect(
            path: "/api/stripe/portal",
            body: nil,
            fallback: "Couldn’t open the billing portal.",
            for: accountID
        )
    }

    private func redirect(path: String, body: Data?, fallback: String, for accountID: AccountID) async throws -> URL {
        var headers = ["accept": "application/json"]
        if body != nil { headers["content-type"] = "application/json" }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                method: .post,
                headers: try HTTPHeaders(headers),
                body: body
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: fallback) { throw error }
        guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
            let address = object["url"] as? String,
            let url = URL(string: address),
            url.scheme == "https"
        else {
            throw NativeWebRouteError(statusCode: response.statusCode, message: fallback)
        }
        return url
    }
}
