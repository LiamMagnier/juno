import AppKit
import AuthenticationServices
import JunoAuth

enum JunoMacWebAuthenticationError: Error, LocalizedError {
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
final class JunoMacWebAuthenticationClient: NSObject,
    NativeSystemBrowserAuthorizing,
    ASWebAuthenticationPresentationContextProviding
{
    private var session: ASWebAuthenticationSession?

    func authenticate(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL {
        guard session == nil else {
            throw JunoMacWebAuthenticationError.alreadyInProgress
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
                                throwing: JunoMacWebAuthenticationError.cancelled
                            )
                        } else {
                            continuation.resume(throwing: error)
                        }
                        return
                    }
                    guard let callbackURL else {
                        continuation.resume(
                            throwing: JunoMacWebAuthenticationError.invalidCallback
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
                    throwing: JunoMacWebAuthenticationError.unavailable
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
