import AppKit
import AuthenticationServices
import JunoAuth

enum JunoCodeWebAuthenticationError: Error, LocalizedError {
    case alreadyInProgress
    case cancelled
    case invalidCallback
    case unavailable

    var errorDescription: String? {
        switch self {
        case .alreadyInProgress:
            "A sign-in window is already open."
        case .cancelled:
            "Sign-in was cancelled."
        case .invalidCallback:
            "Juno returned an invalid sign-in callback."
        case .unavailable:
            "Juno could not open the sign-in window."
        }
    }
}

@MainActor
final class JunoCodeWebAuthenticationClient: NSObject,
    NativeSystemBrowserAuthorizing,
    ASWebAuthenticationPresentationContextProviding
{
    private var session: ASWebAuthenticationSession?

    func authenticate(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL {
        guard session == nil else {
            throw JunoCodeWebAuthenticationError.alreadyInProgress
        }
        let latch = WebAuthenticationResumeLatch()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callback: .customScheme(callbackScheme)
            ) { @Sendable [weak self] callbackURL, error in
                // AuthenticationServices calls this from an XPC reply queue;
                // hop explicitly before touching the main-actor client or the
                // checked continuation.
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
                                throwing: JunoCodeWebAuthenticationError.cancelled
                            )
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }
                    guard let callbackURL else {
                        continuation.resume(
                            throwing: JunoCodeWebAuthenticationError.invalidCallback
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
                    throwing: JunoCodeWebAuthenticationError.unavailable
                )
                return
            }
        }
    }

    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow
            ?? NSApplication.shared.mainWindow
            ?? NSApplication.shared.windows.first
            ?? ASPresentationAnchor()
    }
}
