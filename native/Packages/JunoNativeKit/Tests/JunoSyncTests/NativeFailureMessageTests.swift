import Foundation
import Testing

@testable import JunoSync

/// Caught by looking at the screen, not the code: with no signal, the Settings
/// banner read "The operation couldn't be completed. (NSURLErrorDomain error
/// -1009.)". These pin that no Foundation domain string can reach a banner
/// again, while Juno's own written messages still get through intact.
@Suite struct NativeFailureMessageTests {
    /// The exact string that was on screen.
    @Test func transportErrorsNeverShowTheirDomainCode() {
        for code: URLError.Code in [
            .notConnectedToInternet, .timedOut, .networkConnectionLost,
            .cannotFindHost, .dataNotAllowed,
        ] {
            let message = NativeFailureMessage.presentable(URLError(code))
            #expect(message == NativeFailureMessage.offline)
            #expect(!message.contains("NSURLErrorDomain"))
            #expect(!message.contains("-100"))
        }
    }

    /// An exhausted retry ladder is the shape a real outage actually takes.
    @Test func retryLimitExceededReadsAsAnOutage() {
        #expect(
            NativeFailureMessage.presentable(NativeSyncCoordinatorError.retryLimitExceeded)
                == NativeFailureMessage.offline
        )
    }

    @Test func cancellationDoesNotClaimToBeAnOutage() {
        let message = NativeFailureMessage.presentable(URLError(.cancelled))
        #expect(message == NativeFailureMessage.cancelled)
        #expect(message != NativeFailureMessage.offline)
    }

    /// Juno's own errors are already written for a reader and name the specific
    /// reason. Replacing them with a generic sentence would lose that.
    @Test func junosOwnMessagesArePassedThroughUnchanged() {
        let refusal = NativeBootstrapError.server(statusCode: 401, code: "unauthenticated")
        #expect(NativeFailureMessage.presentable(refusal) == refusal.localizedDescription)
        #expect(NativeFailureMessage.presentable(refusal).contains("unauthenticated"))

        let mismatch = NativeBootstrapError.contractVersionMismatch(
            expected: "1.3.0", received: "1.0.1"
        )
        #expect(NativeFailureMessage.presentable(mismatch) == mismatch.localizedDescription)
    }

    /// A banner must never leak a credential, whatever the error carried.
    @Test func presentedMessagesCarryNoCredentials() {
        let errors: [any Error] = [
            URLError(.userAuthenticationRequired),
            NativeBootstrapError.server(statusCode: 403, code: "forbidden"),
            NativeSyncAPIError.server(
                statusCode: 401, code: "unauthenticated", retryable: false,
                retryAfterMilliseconds: nil
            ),
        ]
        for error in errors {
            let message = NativeFailureMessage.presentable(error).lowercased()
            #expect(!message.contains("bearer"))
            #expect(!message.contains("authorization:"))
        }
    }
}
