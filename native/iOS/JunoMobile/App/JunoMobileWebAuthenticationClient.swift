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
        let latch = WebAuthenticationResumeLatch()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callback: .customScheme(callbackScheme)
            ) { @Sendable [weak self] callbackURL, error in
                // `@Sendable` is load-bearing. AuthenticationServices invokes
                // this on an XPC reply queue, not the main thread. This type is
                // `@MainActor`, so without `@Sendable` the closure inherits that
                // isolation, Swift emits an executor check at its entry point,
                // and the check aborts the process before the body runs —
                // before the `Task { @MainActor }` hop below can help. The same
                // defect crashed the macOS app at sign-in.
                Task { @MainActor in
                    guard latch.claim() else { return }
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
                // `start()` can deliver a completion inline, so this path must
                // not assume it owns the continuation.
                guard latch.claim() else { return }
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
