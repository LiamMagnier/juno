import Foundation

/// A failed model request, in the terms the loop acts on: whether waiting
/// helps, whether another model might, and what the reader is told.
///
/// Classified once, from the typed error the client raised at the point
/// where the HTTP status still existed, rather than by matching words in a
/// message — which is how a rate limit used to fail a run after one fixed
/// half-second retry.
enum ModelFailure: Equatable {
    /// The Juno account's allowance. Neither waiting nor a fallback helps.
    case planLimit(String)
    case rateLimited(retryAfter: TimeInterval?)
    case overloaded(retryAfter: TimeInterval?)
    /// Longer than the window: only a shorter history helps.
    case contextOverflow
    /// The provider's own quota or billing. Another model may answer.
    case quota(String)
    case unauthorized
    /// Nothing can be sent until something outside the run changes.
    case unavailable(String)
    /// A dropped or refused connection, a timeout, a 5xx.
    case transient
    /// A stream that went quiet or overran its deadline: tried once more,
    /// since each attempt costs the whole wait.
    case stalled
    /// A response Juno could not read. Possibly garbled in transit, so tried
    /// once more, but no more than once.
    case malformed
    /// The provider refused the request as one it cannot serve. The same
    /// request fails the same way; another model may not.
    case rejected(String)

    init(_ error: Error) {
        switch error as? AgentModelClientError {
        case let .planLimitReached(message)?:
            self = .planLimit(message)
        case let .rateLimited(retryAfter)?:
            self = .rateLimited(retryAfter: retryAfter)
        case let .overloaded(retryAfter)?:
            self = .overloaded(retryAfter: retryAfter)
        case .contextWindowExceeded?:
            self = .contextOverflow
        case let .quotaExhausted(message)?:
            self = .quota(message)
        case .unauthorized?:
            self = .unauthorized
        case let .unavailable(message)?:
            self = .unavailable(message)
        case .stalled?:
            self = .stalled
        case .invalidResponse?:
            self = .malformed
        case let .rejected(message)?:
            self = .rejected(message)
        case .transport?, nil:
            // An error of no known kind came from below the client — a
            // socket, a URL session — where another attempt is the fix.
            self = .transient
        }
    }

    /// How many times the same model is asked again.
    func retryLimit(_ policy: ModelRetryPolicy) -> Int {
        switch self {
        case .rateLimited, .overloaded, .transient:
            policy.maximumRetries
        case .malformed, .stalled:
            min(1, policy.maximumRetries)
        case .planLimit, .contextOverflow, .quota, .unauthorized, .unavailable, .rejected:
            0
        }
    }

    /// How long the provider asked to be left alone, when it said.
    var retryAfter: TimeInterval? {
        switch self {
        case let .rateLimited(retryAfter), let .overloaded(retryAfter):
            retryAfter
        default:
            nil
        }
    }

    /// Whether a model from another lab could plausibly answer where this one
    /// did not. A limit, an overload and a quota belong to the provider; the
    /// credentials, the window and the account's allowance follow the run.
    var warrantsFallback: Bool {
        switch self {
        case .rateLimited, .overloaded, .quota, .transient, .stalled, .rejected:
            // A rejected request is very often one model's quirk — a retired
            // id, a parameter one lab refuses — that the next lab takes.
            true
        case .planLimit, .contextOverflow, .unauthorized, .unavailable, .malformed:
            false
        }
    }

    /// What the reader is told, without a status code or a stack.
    var sentence: String {
        switch self {
        case let .planLimit(message):
            message
        case .rateLimited:
            "The model's provider is limiting how fast Juno may call it."
        case .overloaded:
            "The model's provider is overloaded right now."
        case .contextOverflow:
            "The conversation is longer than the model's context window."
        case .quota:
            "The model's provider refused the request for its own quota or billing."
        case .unauthorized:
            "The model provider rejected Juno's credentials."
        case let .unavailable(message):
            message
        case .transient:
            "The connection to the model failed."
        case .stalled:
            "The model stopped responding."
        case .malformed:
            "The model sent a response Juno could not read."
        case .rejected:
            "The model's provider rejected the request as one it cannot serve."
        }
    }
}
