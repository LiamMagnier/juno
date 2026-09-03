import Foundation
import Observation

@MainActor
public protocol NativeSystemBrowserAuthorizing: AnyObject {
    func authenticate(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL
}

@MainActor
@Observable
public final class NativeAuthModel {
    public enum Phase: Equatable, Sendable {
        case signedOut
        case restoring
        case signingIn
        case signedIn(NativeAuthenticatedSession)
        case unavailable
    }

    /// Whether the server has actually confirmed the session behind `.signedIn`.
    ///
    /// `.unreachable` means the app opened on Keychain credentials and a cached
    /// profile because Juno could not be reached. The user stays in the app on
    /// their local data; only the freshness of what they see is in question.
    public enum Connectivity: Equatable, Sendable {
        case confirmed
        case unreachable(String)

        public var isUnreachable: Bool {
            if case .unreachable = self { return true }
            return false
        }
    }

    public private(set) var phase: Phase
    public private(set) var lastErrorDescription: String?
    public private(set) var connectivity: Connectivity = .confirmed

    private let runtime: NativeAuthRuntime?
    private let browser: (any NativeSystemBrowserAuthorizing)?
    private var attemptedRestore = false

    public init(
        runtime: NativeAuthRuntime,
        browser: any NativeSystemBrowserAuthorizing
    ) {
        self.runtime = runtime
        self.browser = browser
        phase = .signedOut
    }

    public init(configurationErrorDescription: String) {
        runtime = nil
        browser = nil
        phase = .unavailable
        lastErrorDescription = configurationErrorDescription
    }

    /// Runs once per launch. A restore that failed only because Juno was
    /// unreachable stays retryable — see `retryRestore()` — since that outcome
    /// is about the network, not about the account.
    public func restore() async {
        guard !attemptedRestore else { return }
        attemptedRestore = true
        await performRestore()
    }

    /// Re-attempts a restore that ended `.unreachable`, e.g. from a "Try again"
    /// button or when the app returns to the foreground.
    public func retryRestore() async {
        guard connectivity.isUnreachable else { return }
        await performRestore()
    }

    private func performRestore() async {
        guard let runtime else { return }
        lastErrorDescription = nil

        // Optimistic fast path: if we have a locally cached session, immediately
        // open into .signedIn(cached) so the workspace renders instantly (0ms lag).
        if let cached = await runtime.cachedSession() {
            phase = .signedIn(cached)
        } else {
            phase = .restoring
        }

        do {
            switch try await runtime.restore() {
            case .verified(let session):
                connectivity = .confirmed
                phase = .signedIn(session)
            case .unverified(let session, let cause):
                // Credentials are intact and only the server is missing. Opening
                // the app on cached data beats a sign-in screen the user cannot
                // complete while that same server is down.
                connectivity = .unreachable(cause)
                lastErrorDescription = cause
                phase = .signedIn(session)
            case nil:
                connectivity = .confirmed
                phase = .signedOut
            }
        } catch {
            if case .signedIn = phase {
                connectivity = .unreachable(error.localizedDescription)
                lastErrorDescription = error.localizedDescription
            } else {
                connectivity = .confirmed
                phase = .signedOut
                lastErrorDescription = error.localizedDescription
            }
        }
    }

    public func signIn() async {
        guard let runtime, let browser else { return }
        guard phase != .signingIn else { return }
        phase = .signingIn
        lastErrorDescription = nil
        do {
            let attempt = try await runtime.beginAuthorization()
            let callbackURL = try await browser.authenticate(
                authorizationURL: attempt.authorizationURL,
                callbackScheme: attempt.callbackScheme
            )
            connectivity = .confirmed
            phase = .signedIn(
                try await runtime.completeAuthorization(
                    attempt,
                    callbackURL: callbackURL
                )
            )
        } catch {
            phase = .signedOut
            lastErrorDescription = error.localizedDescription
        }
    }

    /// Signs in with an email and password, no browser hand-off.
    ///
    /// The password is passed straight to the runtime for one request and is
    /// never held by this model, so it cannot end up in an `@Observable`
    /// snapshot or a view's state.
    public func signIn(email: String, password: String) async {
        guard let runtime else { return }
        guard phase != .signingIn else { return }
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else { return }
        phase = .signingIn
        lastErrorDescription = nil
        do {
            let session = try await runtime.signIn(
                email: trimmedEmail,
                password: password
            )
            connectivity = .confirmed
            phase = .signedIn(session)
        } catch {
            phase = .signedOut
            lastErrorDescription = error.localizedDescription
        }
    }

    public func signOut() async {
        guard let runtime else { return }
        let previousPhase = phase
        do {
            try await runtime.signOut()
            lastErrorDescription = nil
            connectivity = .confirmed
            phase = .signedOut
        } catch let error as NativeAuthRuntimeError
            where error == .localDataPurgeFailed
        {
            // Keep the authenticated phase so secure local deletion can be
            // retried instead of orphaning data after credentials disappear.
            phase = previousPhase
            lastErrorDescription = error.localizedDescription
        } catch {
            // Local credentials are removed even if the remote logout was offline.
            lastErrorDescription = error.localizedDescription
            phase = .signedOut
        }
    }
}

#if DEBUG
extension NativeAuthModel {
    /// A signed-out model with no runtime behind it, for the UI preview
    /// harness.
    ///
    /// The harness used to hand the signed-out shell an `.unavailable` model,
    /// and the sign-in form hides its credentials card and browser button on
    /// `.unavailable` — correctly, since nothing could act on them. The result
    /// was a front door with no door: a title, a description and a banner
    /// reading "UI Preview". This one is `.signedOut`; its actions return
    /// without doing anything, because there is no runtime to do it with.
    public static func previewSignedOut() -> NativeAuthModel {
        let model = NativeAuthModel(configurationErrorDescription: "")
        model.phase = .signedOut
        model.lastErrorDescription = nil
        return model
    }
}
#endif
