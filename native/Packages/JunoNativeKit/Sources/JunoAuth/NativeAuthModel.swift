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

    public private(set) var phase: Phase
    public private(set) var lastErrorDescription: String?

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

    public func restore() async {
        guard !attemptedRestore, let runtime else { return }
        attemptedRestore = true
        phase = .restoring
        lastErrorDescription = nil
        do {
            if let session = try await runtime.restore() {
                phase = .signedIn(session)
            } else {
                phase = .signedOut
            }
        } catch {
            phase = .signedOut
            lastErrorDescription = error.localizedDescription
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

    public func signOut() async {
        guard let runtime else { return }
        let previousPhase = phase
        do {
            try await runtime.signOut()
            lastErrorDescription = nil
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
