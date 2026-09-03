import JunoDesignSystem
import SwiftUI

/// A synchronized collection's load state, decoupled from its store.
///
/// Each store nests its own `Phase` inside a generic over the repository type,
/// so depending on one here would drag a storage generic into a value whose
/// whole job is choosing a sentence — and would make these cases unreachable
/// from a test without standing up a repository.
enum DesktopArtifactLoadPhase: Equatable {
    case idle
    case loading
    case ready
    case offline
    case failed
}

/// What to tell the reader when a collection screen is not simply working.
///
/// This exists because the Artifacts column used to print whatever string came
/// back from the transport, straight under the list. In practice that meant a
/// failed fetch rendered as the bare words **"Not found"** — two words that name
/// no subject, suggest no cause and offer no recovery. Projects and Tasks did
/// the same with their own `lastErrorDescription`. The website never does this:
/// it says "Couldn't load your artifacts", explains that something went wrong on
/// the way, and gives you a Try again button.
///
/// The rule is that a *raw* server string is never shown as the whole message.
/// Short, machine-ish strings are recognised and replaced with a sentence;
/// anything long enough to be a real explanation is kept, because a server that
/// took the trouble to write prose knows more about the failure than this type
/// does.
///
/// `subject` is the plural noun the sentences are built around ("artifacts",
/// "projects", "scheduled tasks"), so one implementation serves every collection
/// screen instead of each inventing its own wording for the same 404.
struct DesktopArtifactStatus: Equatable {
    let message: String
    let icon: JunoIcon
    let isRetryable: Bool
    /// `.caution` for the ordinary "try again" cases, `.mutedForeground` for
    /// offline — being offline is a state, not a fault, and colouring it like an
    /// error makes the app feel broken every time a laptop closes.
    let tint: Color

    init?(
        localError: String?,
        phase: DesktopArtifactLoadPhase,
        serverError: String?,
        subject: String = "artifacts",
        singular: String = "artifact"
    ) {
        let copy = DesktopStatusCopy(subject: subject, singular: singular)

        // A local failure is about the thing the reader just did (an export, a
        // save), so it outranks a background refresh failure and is never
        // retried by reloading the whole collection.
        if let localError, !localError.isEmpty {
            message = copy.humanized(localError, fallback: copy.genericLocal)
            icon = .triangleAlert
            isRetryable = false
            tint = .junoCaution
            return
        }

        switch phase {
        case .offline:
            message = copy.offline
            icon = .wifiOff
            // Nothing to retry: the sync layer reconnects on its own, and a
            // button that cannot succeed is worse than no button.
            isRetryable = false
            tint = .junoMutedForeground
        case .failed:
            message = copy.humanized(serverError, fallback: copy.genericLoad)
            icon = .triangleAlert
            isRetryable = true
            tint = .junoCaution
        case .idle, .loading, .ready:
            guard let serverError, !serverError.isEmpty else { return nil }
            message = copy.humanized(serverError, fallback: copy.genericLoad)
            icon = .triangleAlert
            isRetryable = true
            tint = .junoCaution
        }
    }
}

/// The sentences themselves, parameterised by what the screen is showing.
struct DesktopStatusCopy {
    let subject: String
    let singular: String

    var genericLoad: String { "Juno couldn't load your \(subject). Something went wrong on the way here." }
    var genericLocal: String { "Juno couldn't complete that. Please try again." }
    var offline: String { "You're offline — showing the \(subject) saved on this Mac." }

    /// The shortest length at which a server message is treated as prose.
    ///
    /// Below this a string is almost always a status phrase rather than an
    /// explanation ("Not found", "Unauthorized", "Bad Request", "500"), and
    /// showing it alone is what made these screens look broken.
    static let proseThreshold = 40

    func humanized(_ raw: String?, fallback: String) -> String {
        guard let raw else { return fallback }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return fallback }

        if let known = knownPhrase(trimmed) { return known }
        // Long enough to be a real sentence the server wrote on purpose.
        guard trimmed.count < Self.proseThreshold else { return trimmed }
        // Short and unrecognised: keep it, but give it a subject so the reader
        // knows what failed rather than only how.
        return "\(fallback) (\(trimmed))"
    }

    /// The status phrases a transport actually produces, in the words the
    /// product uses for them.
    private func knownPhrase(_ trimmed: String) -> String? {
        switch trimmed.lowercased() {
        case "not found", "notfound", "404":
            // Deliberately not "this was deleted": a 404 covers a removed record
            // *and* a stale identifier, and asserting which would be a guess.
            "Juno couldn't find this \(singular). It may have been deleted from another device."
        case "unauthorized", "401":
            "Your session expired. Sign in again to see your \(subject)."
        case "forbidden", "403":
            "This account doesn't have access to that \(singular)."
        case "bad request", "400":
            "Juno couldn't ask for your \(subject) correctly. This is a bug — please report it."
        case "internal server error", "500", "502", "503", "504":
            "Juno's server had a problem loading your \(subject). Try again in a moment."
        case "offline", "the internet connection appears to be offline.":
            offline
        case "timeout", "timed out", "request timed out":
            "That took too long to load. Try again."
        default:
            nil
        }
    }
}
