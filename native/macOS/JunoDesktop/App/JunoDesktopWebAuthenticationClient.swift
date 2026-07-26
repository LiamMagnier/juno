import AppKit
import AuthenticationServices
import JunoAuth

enum JunoDesktopWebAuthenticationError: Error, LocalizedError {
    case alreadyInProgress
    case cancelled
    case invalidCallback
    case unavailable

    var errorDescription: String? {
        switch self {
        case .alreadyInProgress:
            "A Juno sign-in window is already open."
        case .cancelled:
            "Sign-in was cancelled."
        case .invalidCallback:
            "Juno returned an invalid sign-in response."
        case .unavailable:
            "The system sign-in window is unavailable."
        }
    }
}

@MainActor
final class JunoDesktopWebAuthenticationClient: NSObject,
    NativeSystemBrowserAuthorizing,
    ASWebAuthenticationPresentationContextProviding
{
    private var session: ASWebAuthenticationSession?

    func authenticate(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL {
        guard session == nil else {
            throw JunoDesktopWebAuthenticationError.alreadyInProgress
        }

        let latch = WebAuthenticationResumeLatch()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callback: .customScheme(callbackScheme)
            ) { @Sendable [weak self] callbackURL, error in
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
                                throwing: JunoDesktopWebAuthenticationError.cancelled
                            )
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }

                    guard let callbackURL else {
                        continuation.resume(
                            throwing: JunoDesktopWebAuthenticationError.invalidCallback
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
                guard latch.claim() else { return }
                continuation.resume(
                    throwing: JunoDesktopWebAuthenticationError.unavailable
                )
                return
            }
        }
    }

    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow
            ?? NSApplication.shared.windows.first
            ?? ASPresentationAnchor()
    }
}

