import AuthenticationServices
import JunoAuth
import UIKit

enum JunoMobileWebAuthenticationError: Error, LocalizedError {
    case alreadyInProgress
    case cancelled
    case invalidCallback
    case unavailable

    var errorDescription: String? {
        switch self {
        case .alreadyInProgress:
            String(localized: "auth.error.in-progress")
        case .cancelled:
            String(localized: "auth.error.cancelled")
        case .invalidCallback:
            String(localized: "auth.error.invalid-callback")
        case .unavailable:
            String(localized: "auth.error.unavailable")
        }
    }
}

@MainActor
final class JunoMobileWebAuthenticationClient: NSObject,
    NativeSystemBrowserAuthorizing,
    ASWebAuthenticationPresentationContextProviding
{
    private var session: ASWebAuthenticationSession?

    func authenticate(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL {
        guard session == nil else {
            throw JunoMobileWebAuthenticationError.alreadyInProgress
        }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callback: .customScheme(callbackScheme)
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    if let error {
                        let nsError = error as NSError
                        if nsError.domain == ASWebAuthenticationSessionError.errorDomain,
                            nsError.code
                                == ASWebAuthenticationSessionError.canceledLogin.rawValue
                        {
                            continuation.resume(
                                throwing: JunoMobileWebAuthenticationError.cancelled
                            )
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }
                    guard let callbackURL else {
                        continuation.resume(
                            throwing: JunoMobileWebAuthenticationError.invalidCallback
                        )
                        return
                    }
                    continuation.resume(returning: callbackURL)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(
                    throwing: JunoMobileWebAuthenticationError.unavailable
                )
                return
            }
        }
    }

    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        let activeScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        return activeScene?.keyWindow
            ?? activeScene?.windows.first
            ?? ASPresentationAnchor()
    }
}
