import Testing
@testable import JunoDesktop

/// What the Artifacts column says when it is not simply working.
///
/// The bug these pin down shipped: a failed fetch printed the transport's own
/// two words, "Not found", under the list — naming no subject, suggesting no
/// cause, offering no way out. These assert that no bare status phrase can reach
/// the reader again, and equally that a server which *did* write a real
/// explanation is not talked over by a generic one.
struct DesktopArtifactStatusTests {
    private func status(
        localError: String? = nil,
        phase: DesktopArtifactLoadPhase = .ready,
        serverError: String? = nil
    ) -> DesktopArtifactStatus? {
        DesktopArtifactStatus(localError: localError, phase: phase, serverError: serverError)
    }

    // MARK: - Nothing to say

    @Test
    func aWorkingIndexShowsNothing() {
        #expect(status(phase: .ready, serverError: nil) == nil)
        #expect(status(phase: .loading, serverError: nil) == nil)
        #expect(status(phase: .idle, serverError: "") == nil)
    }

    // MARK: - The regression

    @Test
    func aBareNotFoundBecomesASentence() {
        let result = status(phase: .failed, serverError: "Not found")
        #expect(result != nil)
        #expect(result?.message.contains("couldn't find this artifact") == true)
        // The whole point: the reader is never left holding the raw phrase.
        #expect(result?.message != "Not found")
        #expect(result?.isRetryable == true)
    }

    @Test
    func statusCodesAndPhrasesResolveToTheSameSentence() {
        #expect(status(phase: .failed, serverError: "404")?.message
            == status(phase: .failed, serverError: "not found")?.message)
        #expect(status(phase: .failed, serverError: "401")?.message.contains("session expired") == true)
        #expect(status(phase: .failed, serverError: "500")?.message.contains("Try again") == true)
    }

    // MARK: - Unrecognised strings

    /// An unknown short phrase still gets a subject: the reader learns *what*
    /// failed, and the original is preserved for a bug report.
    @Test
    func anUnknownShortPhraseIsGivenASubjectAndKept() {
        let message = status(phase: .failed, serverError: "ECONNRESET")?.message
        #expect(message?.contains("couldn't load your artifacts") == true)
        #expect(message?.contains("ECONNRESET") == true)
    }

    /// A server that wrote a real sentence knows more about the failure than
    /// this enum does, so it is shown as-is rather than buried in parentheses.
    @Test
    func aRealServerSentenceIsShownUntouched() {
        let prose = "Your workspace exceeded its storage quota, so new artifacts were not saved."
        #expect(status(phase: .failed, serverError: prose)?.message == prose)
    }

    // MARK: - Offline

    /// Offline is a state, not a fault: no retry button, and not coloured like
    /// an error — otherwise closing a laptop lid makes the app look broken.
    @Test
    func offlineExplainsItselfAndOffersNoRetry() {
        let result = status(phase: .offline)
        #expect(result?.isRetryable == false)
        #expect(result?.icon == .wifiOff)
        #expect(result?.message.contains("saved on this Mac") == true)
    }

    // MARK: - Precedence

    /// A failure caused by what the reader just did outranks a background
    /// refresh failure, and reloading the index would not fix it.
    @Test
    func aLocalFailureWinsAndIsNotRetryable() {
        let result = status(
            localError: "The export could not be written to that folder.",
            phase: .failed,
            serverError: "Not found"
        )
        #expect(result?.message == "The export could not be written to that folder.")
        #expect(result?.isRetryable == false)
    }
}
