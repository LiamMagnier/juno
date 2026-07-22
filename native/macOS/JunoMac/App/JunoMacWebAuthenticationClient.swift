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
        let latch = WebAuthenticationResumeLatch()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callback: .customScheme(callbackScheme)
            ) { @Sendable [weak self] callbackURL, error in
                // `@Sendable` is load-bearing, not decoration.
                //
                // AuthenticationServices invokes this on an XPC reply queue
                // (`com.apple.NSXPCConnection…SafariLaunchAgent`), never the
                // main thread. This type is `@MainActor`, so without `@Sendable`
                // the closure *inherits* that isolation, Swift emits an executor
                // check at its entry point, and the check aborts the process
                // with EXC_BREAKPOINT before a single line of the body runs —
                // including before the `Task { @MainActor }` hop below, which is
                // why that hop alone did not protect anything. Signing in
                // crashed the shipped app.
                //
                // `@Sendable` opts the closure out of isolation inheritance, so
                // it starts non-isolated on whatever queue AuthenticationServices
                // used, and the hop below is what actually reaches the main
                // actor.
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
                // `start()` can have already delivered a completion (it runs a
                // dry run inline), so this path must not assume it owns the
                // continuation.
                guard latch.claim() else { return }
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
