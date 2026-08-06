import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// The wire between a Mac's claim loop and the relay.
///
/// `WorkRemoteHost` was written against the `WorkRelaying` protocol so its
/// interesting states — a claim landing after sign-out, a revocation arriving
/// mid-poll, a lease expiring while a command runs — could be exercised without
/// a server. This is the production conformance.
///
/// Kept in its own file rather than beside the client's other methods because
/// these three have a different caller and a different failure posture. The
/// client's methods serve a person looking at a screen who can retry; these
/// serve a loop deciding, with nobody watching, whether a failure is worth
/// retrying at all. Both directions are bad in ways the other methods are not:
/// a revoked host that retries forever keeps polling a relay that has already
/// told it to stop, and a transient failure treated as permanent takes the Mac
/// offline until someone notices and restarts the app.
/// `registerWorkHost` already has the shape; the conformance is what lets a host
/// model hold a seam rather than the concrete client, so the first registration
/// of a Mac — the one case with no `hostID` to fall back on — can be exercised
/// without a server.
extension NativeWorkClient: WorkHostRegistering {}

extension NativeWorkClient: WorkRelaying {
    /// The wire generation this build speaks.
    ///
    /// Bumped only when a command kind's payload changes shape, never for an
    /// additive field — the relay refuses to hand a host a kind its declared
    /// version cannot parse, so a version bumped for a harmless addition takes
    /// every older Mac out of service for no reason.
    ///
    /// **2, matching `RELAY_PROTOCOL_VERSION` in `src/lib/work/relay.ts`.** It
    /// said 1 while the relay was at 2, and `hostUnderstands` withholds any kind
    /// whose required version is above what the host declares — so `undo`,
    /// `grant_folder` and `revoke_grant` were never handed to this Mac at all.
    /// They are implemented here and were unreachable, which presents as a
    /// person tapping Undo on their phone and nothing whatsoever happening.
    static let protocolVersion = 2

    /// The relay's own ceiling on an acknowledgement's error text.
    static let maximumErrorCharacters = 10_000

    /// Long-polls for the next command.
    ///
    /// The relay holds the request open and answers with a null command when
    /// nothing arrives, so nil is the normal idle outcome rather than a failure
    /// and the loop goes straight back round.
    public func claimNextWorkCommand(
        hostID: String, for accountID: AccountID
    ) async throws -> WorkCommand? {
        try validateRelayIdentifier(hostID)
        let response = try await relayGet(
            "/api/work/hosts/\(hostID)/commands",
            query: [
                URLQueryItem(name: "protocolVersion", value: String(Self.protocolVersion))
            ],
            for: accountID
        )
        guard let root = try relayObject(response) else { throw WorkRemoteError.malformedResponse }
        guard case .object(let command)? = root["command"] else {
            // Explicitly not an error: `command: null` is what an idle poll
            // returns, and treating it as malformed would make every quiet
            // minute look like a broken relay.
            return nil
        }
        return try WorkCommand(relayPayload: command)
    }

    /// Reports the outcome of a command.
    ///
    /// A failed command still has to be acknowledged. Leaving it claimed
    /// strands it: no other process can take it while the lease holds, so
    /// silence here is a command that never completes and never fails, which
    /// the user reads as a task that is starting for ever.
    public func acknowledgeWorkCommand(
        hostID: String,
        commandID: String,
        status: String,
        result: [String: JunoJSONValue]?,
        error: String?,
        for accountID: AccountID
    ) async throws {
        try validateRelayIdentifier(hostID)
        try validateRelayIdentifier(commandID)

        var body: [String: JunoJSONValue] = ["status": .string(status)]
        if let result { body["result"] = .object(result) }
        if let error {
            // Truncated to the relay's ceiling rather than sent whole. A
            // rejected acknowledgement is worse than a shortened one: the
            // command stays claimed, and the reason it stayed claimed is that
            // the explanation of why it failed was too long to accept.
            body["error"] = .string(String(error.prefix(Self.maximumErrorCharacters)))
        }

        _ = try await relaySend(
            .post,
            "/api/work/hosts/\(hostID)/commands/\(commandID)",
            body: .object(body),
            for: accountID
        )
    }

    /// Re-advertises what this Mac can currently do.
    ///
    /// Sent on every pass of the loop, not once at registration. The answer
    /// changes when the user revokes a folder or flips a switch, and a relay
    /// routing local work on a stale manifest dispatches a task the host will
    /// refuse at every step — which the user reads as a Mac that took the job
    /// and then did nothing.
    ///
    /// The capability list comes from `advertisedCapabilities` rather than
    /// being passed separately, so a manifest that disagrees with the switches
    /// cannot be assembled at this layer either.
    ///
    /// **`POST /register`, not `PATCH /api/work/hosts/{id}`.** The PATCH route
    /// is the *owner's* surface — the narrowing a person applies from their
    /// phone — and its schema has no `capabilities`, no `platform` and no
    /// `lastSeenAt`. So a heartbeat sent there wrote a few booleans, silently
    /// discarded the whole manifest, and never refreshed presence: the relay
    /// aged this Mac out to `offline` while it was awake and beating twice a
    /// minute, and `selectTarget` routed every local task away from it. The
    /// register route is the one that treats an advertisement as an
    /// advertisement.
    public func advertiseWorkHost(
        hostID: String,
        policy: WorkHostPolicy,
        for accountID: AccountID
    ) async throws {
        try validateRelayIdentifier(hostID)
        guard let identity = hostIdentity?() else { throw WorkRemoteError.hostNotRegistered }
        _ = try await relaySend(
            .post,
            "/api/work/hosts/register",
            body: Self.hostRegistrationBody(
                identity: identity,
                policy: policy,
                counts: await runCounts?() ?? .none
            ),
            for: accountID
        )
    }
}

// MARK: - Decoding

extension WorkCommand {
    /// Builds a command from the relay's filtered serialiser output.
    ///
    /// An unreadable `expiresAt` becomes the distant past rather than the
    /// distant future, so a command whose expiry cannot be parsed is treated as
    /// already expired and refused. The opposite default would make a malformed
    /// timestamp the one reliable way to obtain a command that never stops
    /// being valid.
    init(relayPayload: [String: JunoJSONValue]) throws {
        func string(_ key: String) -> String? {
            if case .string(let value)? = relayPayload[key] { return value }
            return nil
        }
        guard let id = string("id"), let sessionID = string("sessionId"),
              let kind = string("kind"), let status = string("status")
        else { throw WorkRemoteError.malformedResponse }

        var payload: [String: JunoJSONValue] = [:]
        if case .object(let object)? = relayPayload["payload"] { payload = object }

        self.init(
            id: id,
            sessionID: sessionID,
            runID: string("runId"),
            kind: kind,
            payload: payload,
            status: status,
            leaseExpiresAt: string("leaseExpiresAt").flatMap(WorkCommand.parseTimestamp),
            expiresAt: string("expiresAt").flatMap(WorkCommand.parseTimestamp) ?? .distantPast
        )
    }

    /// ISO-8601, with and without fractional seconds.
    ///
    /// Both are tried because the relay emits whatever `Date.toISOString()`
    /// produced, and a parser accepting only one form fails on a subset of
    /// timestamps for a reason nobody would guess from the symptom.
    static func parseTimestamp(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }
}
