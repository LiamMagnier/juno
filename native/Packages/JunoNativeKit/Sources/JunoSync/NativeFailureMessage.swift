import Foundation
import JunoCore

/// Turns a failure into a sentence a reader can act on.
///
/// This exists because of something only visible on screen: the Settings banner
/// was rendering `URLError.notConnectedToInternet.localizedDescription`
/// verbatim, so a phone with no signal said
///
///     The operation couldn't be completed. (NSURLErrorDomain error -1009.)
///
/// The screens did carry a written fallback — "Offline — showing saved
/// settings" — but it was only used when no error had been recorded at all.
/// Once the stores started always recording the error (which they must, or a
/// hard failure is silent), the fallback became unreachable and every outage
/// surfaced as a Foundation dump.
///
/// The split is deliberate: Juno's *own* error types already carry sentences
/// written for a reader, so they are passed through unchanged. Only Foundation
/// transport errors, which carry domain codes, get replaced. The precise
/// technical detail is not lost — it is on the Diagnostics screen, as the
/// failure kind and the HTTP status.
public enum NativeFailureMessage {
    public static func presentable(_ error: any Error) -> String {
        if let coordinator = error as? NativeSyncCoordinatorError,
            coordinator == .retryLimitExceeded
        {
            return offline
        }
        if let urlError = error as? URLError {
            // Cancellation is control flow. It should not produce a banner at
            // all, but if one is asked for, it must not claim to be an outage.
            return urlError.code == .cancelled ? cancelled : offline
        }
        // NativeBootstrapError, NativeSyncAPIError and the store errors all
        // define `errorDescription` as a written sentence. Rewriting those here
        // would throw away the specific reason — which code was refused, which
        // contract mismatched — for no gain.
        return error.localizedDescription
    }

    /// Written as literals rather than catalog lookups to match the
    /// surrounding stores, which state their user-facing strings the same way.
    /// The package declares no resource bundle, so there is nothing to look
    /// them up in.
    public static let offline =
        "Juno can’t reach the server. Your changes are saved and will sync when you’re back online."

    public static let cancelled = "That request was cancelled." 
}
