import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import XCTest

@testable import JunoWorkKit

/// The Work client and the model both apps read from.
///
/// Weighted towards the boundaries rather than the happy path, because the
/// happy path here is one decode and the boundaries are the whole product: an
/// approval that must not be spendable twice, a cursor that must not lose
/// events, and a Mac that has gone quiet without telling anybody.
final class NativeWorkClientTests: XCTestCase {
    private let account = try! AccountID("account-a")

    // MARK: - Path safety

    /// Identifiers are interpolated into the path, and the neighbouring routes
    /// on this API are the ones that stop runs and answer approvals. A `..`
    /// segment or an encoded slash would address one of them.
    func testHostileIdentifiersNeverReachTheNetwork() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)

        let hostile = [
            "../../hosts", "sess/../other", "a%2Fb", "with space",
            "with\nnewline", "q?x=1", "frag#ment", "back\\slash", "",
        ]
        for identifier in hostile {
            do {
                _ = try await client.session(id: identifier, for: account)
                XCTFail("\(identifier.debugDescription) should have been refused")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .invalidIdentifier, identifier.debugDescription)
            }
            do {
                _ = try await client.control(
                    runID: identifier, .stop, idempotencyKey: "k", for: account
                )
                XCTFail("\(identifier.debugDescription) should have been refused")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .invalidIdentifier, identifier.debugDescription)
            }
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0, "Not one hostile identifier may reach the transport.")
    }

    // MARK: - Control

    /// The host-plane kinds are the relay's to mint. A phone sending one is a
    /// request the server refuses, so it is refused here instead — locally and
    /// immediately rather than as an opaque 400 after a round trip.
    func testOnlyRunControlKindsMayBeSent() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)

        for kind in [JunoWorkCommandKind.grantFolder, .approve, .ping, .start] {
            do {
                _ = try await client.control(
                    runID: "run_1", kind, idempotencyKey: "k", for: account
                )
                XCTFail("\(kind.rawValue) is not a run control")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .unsupportedCommand(kind.rawValue))
            }
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)

        XCTAssertEqual(NativeWorkClient.controlKinds, [.pause, .resume, .stop])
    }

    // MARK: - Approvals

    /// Approving a send at 09:00 must not still authorise it at 17:00 after the
    /// draft has been rewritten. The window closes on the client too, so an
    /// expired card cannot even produce a request.
    func testAnExpiredApprovalIsRefusedBeforeTheNetwork() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)
        let now = Date(timeIntervalSince1970: 1_000_000)

        do {
            _ = try await client.decide(
                on: approval(expiresIn: -1, at: now), decision: .allowed, at: now, for: account
            )
            XCTFail("an expired approval must not be answerable")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .approvalExpired)
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// `pending`, `expired` and `superseded` are things that happen to an
    /// approval rather than answers to it. A client able to send one would be
    /// claiming to have decided something nobody decided.
    func testOnlyRealDecisionsMayBeSent() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)
        let now = Date(timeIntervalSince1970: 1_000_000)

        for decision in [JunoWorkApprovalDecision.pending, .expired, .superseded] {
            do {
                _ = try await client.decide(
                    on: approval(at: now), decision: decision, at: now, for: account
                )
                XCTFail("\(decision.rawValue) is not a decision anyone made")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, .unsupportedCommand(decision.rawValue))
            }
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// The action identity is a second safety boundary independent of risk. A
    /// stale executor that labels a send as safe must not make a persistent
    /// approval available or put one on the wire.
    func testAMisgradedAlwaysConfirmActionRefusesStandingApprovalBeforeTheNetwork() async throws {
        let transport = WorkTransport()
        let client = NativeWorkClient(transport: transport)
        let now = Date(timeIntervalSince1970: 1_000_000)
        let request = approval(
            action: JunoWorkAlwaysConfirmAction.workConnectorSendMessage.rawValue,
            risk: JunoWorkRiskLevel.safe.rawValue,
            at: now
        )

        XCTAssertFalse(request.allowsStandingGrant)
        do {
            _ = try await client.decide(
                on: request, decision: .allowedAlways, at: now, for: account
            )
            XCTFail("an always-confirm action must never acquire a standing approval")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .standingApprovalForbidden)
        }
        let count = await transport.requests.count
        XCTAssertEqual(count, 0)
    }

    /// The digest is what stops an approval shown for one action authorising a
    /// different one, so it has to be on the wire.
    func testTheActionDigestTravelsWithTheDecision() async throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let transport = WorkTransport(routes: [
            "/api/work/approvals/appr_1/decision": json(
                #"{"approval":{"id":"appr_1","runId":"run_1","action":"work.connector.send_message","#
                    + #""risk":"irreversible","summary":"Send the draft to Dana","detail":{},"#
                    + #""actionDigest":"digest-abc","expiresAt":"2026-08-05T10:10:00.000Z","#
                    + #""decision":"allowed"}}"#
            )
        ])
        let client = NativeWorkClient(transport: transport)

        let decided = try await client.decide(
            on: approval(at: now), decision: .allowed, at: now, for: account
        )

        XCTAssertEqual(decided.decision, JunoWorkApprovalDecision.allowed.rawValue)
        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["actionDigest"] as? String, "digest-abc")
        XCTAssertEqual(object["decision"] as? String, "allowed")
    }

    /// If the row the server wrote is not the one that was on screen, the
    /// request was superseded between render and tap. Reporting that as a
    /// success would show a decided card for an action the user never saw.
    func testADifferentDigestComingBackIsAMismatchRatherThanASuccess() async throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let transport = WorkTransport(routes: [
            "/api/work/approvals/appr_1/decision": json(
                #"{"approval":{"id":"appr_1","runId":"run_1","action":"work.file.permanent_delete","#
                    + #""risk":"irreversible","summary":"Delete 3 files","detail":{},"#
                    + #""actionDigest":"digest-SOMETHING-ELSE","#
                    + #""expiresAt":"2026-08-05T10:10:00.000Z","decision":"allowed"}}"#
            )
        ])
        let client = NativeWorkClient(transport: transport)

        do {
            _ = try await client.decide(
                on: approval(at: now), decision: .allowed, at: now, for: account
            )
            XCTFail("a digest mismatch must not read as a success")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .approvalDigestMismatch)
        }
    }

    // MARK: - Sessions

    /// The joined fields are what the screen needs and none of them are
    /// guaranteed, so the decode has to survive their absence rather than fail
    /// a whole list because one task has never run.
    func testASessionDecodesWithItsJoinedRunAndHostFields() async throws {
        let transport = WorkTransport(routes: ["/api/work/sessions": json(sessionListJSON)])
        let client = NativeWorkClient(transport: transport)

        let listed = try await client.sessions(for: account)
        let session = try XCTUnwrap(listed.first)

        XCTAssertEqual(session.sessionID, "sess_1")
        XCTAssertEqual(session.status, JunoWorkStatus.running.rawValue)
        XCTAssertEqual(session.hostID, "host_1")
        XCTAssertEqual(session.hostDisplayName, "Liam’s MacBook Pro")
        XCTAssertEqual(session.effectiveTarget, JunoWorkTarget.local.rawValue)
        XCTAssertEqual(session.currentRunID, "run_1")
        XCTAssertEqual(session.lastSeq, 12)
        XCTAssertEqual(session.requestedModel, "anthropic:claude-sonnet-5")
        XCTAssertEqual(session.reasoningEffort, "high")
        XCTAssertEqual(session.permissionPolicy, .balanced)
        XCTAssertFalse(session.pinned)

        let bare = try await client.sessions(for: account)
        XCTAssertEqual(bare.count, 2, "a session that has never run must still decode")
        XCTAssertNil(bare[1].hostID)
        XCTAssertEqual(bare[1].lastSeq, 0)
    }

    /// The whole grant design keeps the phone from learning where anything
    /// lives on the Mac. Nothing that reaches this client may look like a path.
    func testNothingOnASessionLooksLikeAFilesystemPath() async throws {
        let transport = WorkTransport(routes: ["/api/work/sessions": json(sessionListJSON)])
        let client = NativeWorkClient(transport: transport)

        for session in try await client.sessions(for: account) {
            for value in [session.title, session.goal, session.hostDisplayName].compactMap({ $0 }) {
                XCTAssertFalse(value.hasPrefix("/"), value)
                XCTAssertFalse(value.contains("/Users/"), value)
            }
        }
    }

    /// A PATCH is a partial update, and the difference is load-bearing: sending
    /// `archived: false` whenever somebody pins a task would silently restore
    /// everything they had put away.
    func testPinningDoesNotAlsoSendArchived() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1": json(#"{"session":"# + soleSessionJSON + "}")
        ])
        let client = NativeWorkClient(transport: transport)

        _ = try await client.updateSession(
            id: "sess_1", WorkSessionEdit(pinned: true), for: account
        )

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["pinned"] as? Bool, true)
        XCTAssertNil(object["archived"], "an untouched field must not be sent")
        XCTAssertNil(object["title"])
    }

    /// A task's connected-app scope and approval posture are part of the
    /// composition, not UI-only hints. If either field is dropped here, the
    /// server has to infer reach and risk from whatever happens to be linked
    /// to the account — the opposite of an explicit, reviewable task boundary.
    func testTaskCreationCarriesConnectorAndPermissionContract() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions": json(#"{"session":"# + soleSessionJSON + "}")
        ])
        let client = NativeWorkClient(transport: transport)

        _ = try await client.createSession(
            goal: "Prepare the report",
            target: .cloud,
            model: "anthropic:claude-sonnet-5",
            reasoningEffort: "high",
            attachmentIDs: ["attachment_1"],
            connectorIDs: ["github", "composio:gmail"],
            permissionPolicy: .conservative,
            idempotencyKey: "session-key",
            for: account
        )

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["goal"] as? String, "Prepare the report")
        XCTAssertEqual(object["requestedTarget"] as? String, "cloud")
        XCTAssertEqual(object["model"] as? String, "anthropic:claude-sonnet-5")
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
        XCTAssertEqual(object["attachmentIds"] as? [String], ["attachment_1"])
        XCTAssertEqual(object["connectorIds"] as? [String], ["github", "composio:gmail"])
        XCTAssertEqual(object["permissionPolicy"] as? String, "conservative")
        XCTAssertEqual(object["idempotencyKey"] as? String, "session-key")
    }

    /// A retry can change the model or thinking depth for one attempt without
    /// rewriting the task's durable context. Those fields therefore belong on
    /// the run request as well as on creation, and the native client must not
    /// silently discard them when the user starts again from a thread.
    func testRunStartCarriesModelAndReasoningOverride() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/runs": json(
                #"{"run":{"id":"run_1","sessionId":"sess_1","status":"queued","attempt":1,"requestedTarget":"cloud","lastSeq":0}}"#
            )
        ])
        let client = NativeWorkClient(transport: transport)

        _ = try await client.startRun(
            sessionID: "sess_1",
            target: .cloud,
            model: "anthropic:claude-sonnet-5",
            reasoningEffort: "high",
            idempotencyKey: "run-key",
            for: account
        )

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["requestedTarget"] as? String, "cloud")
        XCTAssertEqual(object["model"] as? String, "anthropic:claude-sonnet-5")
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
        XCTAssertEqual(object["idempotencyKey"] as? String, "run-key")
    }

    /// Context is a separate read because the session list deliberately omits
    /// join-table state. The native editor must preserve an empty app scope as
    /// different from a missing one, and it must never turn an attached file
    /// into a local path.
    func testContextDecodesConnectorScopeAndAttachments() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/context": json("""
            {"context":{
                "projectId":"project_1",
                "model":"anthropic:claude-sonnet-5",
                "reasoningEffort":"high",
                "permissionPolicy":"balanced",
                "connectorIds":["github","composio:gmail"],
                "attachments":[{"id":"attachment_1","displayName":"Brief.pdf"}],
                "skillSlug":"/research"
            }}
            """)
        ])
        let client = NativeWorkClient(transport: transport)

        let context = try await client.context(for: "sess_1", accountID: account)

        XCTAssertEqual(context.projectID, "project_1")
        XCTAssertEqual(context.model, "anthropic:claude-sonnet-5")
        XCTAssertEqual(context.reasoningEffort, "high")
        XCTAssertEqual(context.permissionPolicy, .balanced)
        XCTAssertEqual(context.connectorIDs, ["github", "composio:gmail"])
        XCTAssertEqual(context.attachments.map(\.attachmentID), ["attachment_1"])
        XCTAssertEqual(context.attachments.first?.displayName, "Brief.pdf")
        XCTAssertEqual(context.skillSlug, "/research")
    }

    /// Editing context is a partial PATCH. A model change and a deliberate
    /// thinking reset must not accidentally rewrite permissions, connected
    /// apps, or files, and the server's timing verdicts must reach the UI.
    func testContextPatchSendsOnlyTouchedFieldsAndPreservesTiming() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/sessions/sess_1/context": json("""
            {
                "context":{
                    "model":"openai:gpt-5",
                    "reasoningEffort":null,
                    "permissionPolicy":"balanced",
                    "connectorIds":["github"],
                    "attachments":[]
                },
                "session":\(soleSessionJSON),
                "applied":[
                    {"field":"model","change":"set","effect":"next_attempt","explanation":"The new model will be used on the next attempt."},
                    {"field":"reasoningEffort","change":"clear","effect":"next_attempt","explanation":"Thinking will return to automatic on the next attempt."}
                ]
            }
            """)
        ])
        let client = NativeWorkClient(transport: transport)

        let update = try await client.updateContext(
            sessionID: "sess_1",
            WorkSessionContextEdit(
                model: "openai:gpt-5",
                reasoningEffort: .clear
            ),
            for: account
        )

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(request.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["model"] as? String, "openai:gpt-5")
        XCTAssertTrue(object["reasoningEffort"] is NSNull)
        XCTAssertNil(object["permissionPolicy"])
        XCTAssertNil(object["connectorIds"])
        XCTAssertNil(object["attachmentIds"])
        XCTAssertEqual(update.context.model, "openai:gpt-5")
        XCTAssertNil(update.context.reasoningEffort)
        XCTAssertEqual(update.applied.map(\.field), ["model", "reasoningEffort"])
        XCTAssertEqual(update.applied.first?.effect, "next_attempt")
    }

    // MARK: - Hosts

    /// Presence and capability are different facts. A host that heartbeats but
    /// has Work switched off will take a command into its queue and never run
    /// it, which presents as a task that is starting forever.
    func testHostsDecodeWithTheirReachabilityAndSwitches() async throws {
        let transport = WorkTransport(routes: ["/api/work/hosts": json(hostListJSON)])
        let client = NativeWorkClient(transport: transport)

        let hosts = try await client.hosts(for: account)

        XCTAssertEqual(hosts.count, 3)
        XCTAssertTrue(hosts[0].canServeWork)
        XCTAssertFalse(hosts[1].canServeWork, "an offline Mac cannot serve local work")
        XCTAssertFalse(hosts[2].canServeWork, "a revoked Mac cannot serve local work")
        XCTAssertEqual(hosts[0].capabilities, ["local_files", "local_browser"])
    }

    // MARK: - Errors

    /// A 4xx will stay wrong however many times it is sent; a 5xx is worth
    /// another attempt. Getting this backwards either hammers a rejecting
    /// server or gives up on a recoverable one.
    func testRetryabilityFollowsTheStatusClass() async throws {
        for (statusCode, retryable) in [(400, false), (403, false), (404, false), (500, true), (503, true)] {
            let transport = WorkTransport(routes: [
                "/api/work/hosts": json(#"{"error":"nope"}"#, status: statusCode)
            ])
            let client = NativeWorkClient(transport: transport)
            do {
                _ = try await client.hosts(for: account)
                XCTFail("status \(statusCode) should have thrown")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error.isRetryable, retryable, "status \(statusCode)")
            }
        }
    }

    /// A revocation is not a network problem and must not be offered with a
    /// Retry button, so the named codes have to survive the trip into the enum.
    func testNamedRefusalsBecomeTheirOwnErrors() async throws {
        let cases: [(String, WorkRemoteError)] = [
            ("work_host_revoked", .hostRevoked),
            ("work_host_not_enabled", .hostNotEnabled),
            ("work_approval_expired", .approvalExpired),
            ("work_approval_digest_mismatch", .approvalDigestMismatch),
        ]
        for (code, expected) in cases {
            let transport = WorkTransport(routes: [
                "/api/work/hosts": json(
                    #"{"error":{"code":"\#(code)","message":"refused","requestId":"req_1","retryable":false}}"#,
                    status: 403
                )
            ])
            let client = NativeWorkClient(transport: transport)
            do {
                _ = try await client.hosts(for: account)
                XCTFail("\(code) should have thrown")
            } catch let error as WorkRemoteError {
                XCTAssertEqual(error, expected)
                XCTAssertFalse(error.isRetryable, code)
            }
        }
    }

    /// A capability refusal is only worth its own case when the server names
    /// the capability: "This Mac has not been granted ." is worse than the
    /// generic sentence it would have replaced.
    func testACapabilityRefusalNamesTheCapability() async throws {
        let transport = WorkTransport(routes: [
            "/api/work/hosts": json(
                #"{"error":{"code":"work_capability_not_granted","message":"refused","#
                    + #""requestId":"req_1","retryable":false,"capability":"local_files"}}"#,
                status: 403
            )
        ])
        let client = NativeWorkClient(transport: transport)

        do {
            _ = try await client.hosts(for: account)
            XCTFail("should have thrown")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .capabilityNotGranted("local_files"))
        }
    }

    // MARK: - The event stream

    /// The cursor is the whole point of the stream: a phone that drops its
    /// connection resumes from the last sequence it applied rather than
    /// refetching a transcript.
    func testTheStreamIsRequestedStrictlyAfterTheCursor() async throws {
        let transport = WorkTransport(stream: sse(#"data: {"type":"done"}"# + "\n\n"))
        let client = NativeWorkClient(transport: transport)

        let stream = try await client.streamEvents(
            sessionID: "sess_1", afterSeq: 41, for: account
        )
        for try await _ in stream {}

        let requests = await transport.streamRequests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.path, "/api/work/sessions/sess_1/events")
        XCTAssertEqual(request.queryItems, [URLQueryItem(name: "after", value: "41")])
    }

    func testFramesDecodeAndHeartbeatsAreIgnored() async throws {
        let body = """
        : heartbeat

        data: {"type":"snapshot","session":\(soleSessionJSON),\
        "run":{"id":"run_1","sessionId":"sess_1","status":"running","attempt":2,\
        "usage":{"costMicroUsd":1250},"budget":{"maxCostMicroUsd":50000},"lastSeq":12},\
        "events":[{"seq":12,"kind":"run_started","payload":{},"createdAt":"2026-08-05T10:00:00.000Z"}],\
        "approvals":[]}

        : heartbeat

        data: {"type":"events","events":[{"seq":13,"kind":"assistant_message",\
        "payload":{"text":"Sorted 14 files."},"createdAt":"2026-08-05T10:00:05.000Z"}]}

        data: {"type":"done"}


        """
        let transport = WorkTransport(stream: sse(body))
        let client = NativeWorkClient(transport: transport)

        var frames: [WorkStreamFrame] = []
        for try await frame in try await client.streamEvents(
            sessionID: "sess_1", afterSeq: 0, for: account
        ) {
            frames.append(frame)
        }

        XCTAssertEqual(frames.count, 3)
        guard case .snapshot(let snapshot) = frames[0] else {
            return XCTFail("expected a snapshot first, got \(frames[0])")
        }
        XCTAssertEqual(snapshot.session?.sessionID, "sess_1")
        XCTAssertEqual(snapshot.run?.attempt, 2)
        XCTAssertEqual(snapshot.run?.costMicroUsd, 1_250)
        XCTAssertEqual(snapshot.run?.maxCostMicroUsd, 50_000)
        XCTAssertEqual(snapshot.events.map(\.seq), [12])

        guard case .events(let update) = frames[1] else {
            return XCTFail("expected an events frame, got \(frames[1])")
        }
        XCTAssertEqual(update.events.first?.payload["text"], .string("Sorted 14 files."))

        guard case .done = frames[2] else {
            return XCTFail("expected a done frame, got \(frames[2])")
        }
    }

    /// A captive portal or an expired gateway answers 200 with HTML. Without
    /// the content-type check the parser grinds through a login page and
    /// reports "malformed event" for something that is not an event.
    func testAResponseThatIsNotAnEventStreamIsRefused() async throws {
        let transport = WorkTransport(
            stream: (status: 200, contentType: "text/html", body: Data("<html>".utf8))
        )
        let client = NativeWorkClient(transport: transport)

        do {
            _ = try await client.streamEvents(sessionID: "sess_1", afterSeq: 0, for: account)
            XCTFail("an HTML body must not be read as a stream")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    /// A frame this build cannot name is refused rather than dropped. Silently
    /// ignoring it leaves a reader watching a log that has quietly stopped
    /// telling them things.
    func testAnUnknownFrameTypeIsRefusedRatherThanIgnored() async throws {
        let transport = WorkTransport(stream: sse(#"data: {"type":"telemetry"}"# + "\n\n"))
        let client = NativeWorkClient(transport: transport)

        do {
            for try await _ in try await client.streamEvents(
                sessionID: "sess_1", afterSeq: 0, for: account
            ) {}
            XCTFail("an unknown frame type must not be ignored")
        } catch let error as WorkRemoteError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    // MARK: - The model

    /// The failure this exists to prevent. A local run's status is written by
    /// its host; a Mac that closed its lid writes nothing, so the last thing
    /// the server heard stays `running` until the reaper notices. In that
    /// window the phone would show a spinner for a task executing nowhere.
    @MainActor
    func testATaskIsNeverShownRunningOnAMacThatIsOffline() async throws {
        let model = NativeWorkModel(client: NativeWorkClient(transport: WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(offlineHostJSON),
        ])))

        await model.start(for: account)
        defer { model.stop() }

        let session = try XCTUnwrap(model.sessions.first)
        XCTAssertEqual(session.status, JunoWorkStatus.running.rawValue)
        XCTAssertEqual(model.displayStatus(of: session), .hostOffline)
        XCTAssertFalse(model.isRunning(session))
        XCTAssertTrue(
            model.sessionsNeedingAttention.contains { $0.sessionID == session.sessionID },
            "a run stranded on a Mac that went away is waiting on the user"
        )
    }

    /// The correction is narrow on purpose: it applies only when the host has
    /// actually been seen and said no. A host list that has not loaded yet is
    /// not evidence, and downgrading on absence would flash every local task to
    /// "Mac offline" on launch.
    @MainActor
    func testAnUnknownHostIsNotTreatedAsAnOfflineOne() async throws {
        let model = NativeWorkModel(client: NativeWorkClient(transport: WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(#"{"hosts":[]}"#),
        ])))

        await model.start(for: account)
        defer { model.stop() }

        let session = try XCTUnwrap(model.sessions.first)
        XCTAssertEqual(model.displayStatus(of: session), .running)
        XCTAssertTrue(model.isRunning(session))
    }

    @MainActor
    func testAReachableHostLeavesTheReportedStatusAlone() async throws {
        let model = NativeWorkModel(client: NativeWorkClient(transport: WorkTransport(routes: [
            "/api/work/sessions": json(sessionListJSON),
            "/api/work/hosts": json(hostListJSON),
        ])))

        await model.start(for: account)
        defer { model.stop() }

        let session = try XCTUnwrap(model.sessions.first)
        XCTAssertEqual(model.displayStatus(of: session), .running)
        XCTAssertEqual(model.availableHosts.map(\.hostID), ["host_1"])
    }

    /// A finished task is never second-guessed. The correction only ever
    /// applies to a run that could still be moving.
    @MainActor
    func testATerminalTaskIsNotRewrittenByAnOfflineHost() async throws {
        let model = NativeWorkModel(client: NativeWorkClient(transport: WorkTransport(routes: [
            "/api/work/sessions": json(completedSessionListJSON),
            "/api/work/hosts": json(offlineHostJSON),
        ])))

        await model.start(for: account)
        defer { model.stop() }

        let session = try XCTUnwrap(model.sessions.first)
        XCTAssertEqual(model.displayStatus(of: session), .completed)
        XCTAssertFalse(model.sessionsNeedingAttention.contains { $0.sessionID == session.sessionID })
    }

    /// A server that has never been reached leaves nothing on screen, and the
    /// phase has to say which kind of nothing it is: `offline` invites a retry,
    /// `failed` does not.
    @MainActor
    func testAnUnreachableRelayLeavesTheModelOfflineRatherThanFailed() async throws {
        let model = NativeWorkModel(client: NativeWorkClient(transport: WorkTransport()))

        await model.start(for: account)
        defer { model.stop() }

        XCTAssertEqual(model.phase, .offline)
        XCTAssertEqual(model.lastErrorDescription, NativeFailureMessage.offline)
    }

    // MARK: - Fixtures

    private func approval(
        action: String = "work.connector.send_message",
        risk: String = JunoWorkRiskLevel.irreversible.rawValue,
        expiresIn seconds: TimeInterval = 600,
        at now: Date
    ) -> WorkApprovalRequest {
        WorkApprovalRequest(
            approvalID: "appr_1", runID: "run_1", action: action,
            risk: risk, summary: "Send the draft to Dana",
            detail: [:], actionDigest: "digest-abc",
            expiresAt: now.addingTimeInterval(seconds),
            decision: JunoWorkApprovalDecision.pending.rawValue
        )
    }

    private func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    private func sse(_ body: String) -> (status: Int, contentType: String, body: Data) {
        (status: 200, contentType: "text/event-stream; charset=utf-8", body: Data(body.utf8))
    }
}

// MARK: - Fixture bodies

private let soleSessionJSON = """
{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it by kind",\
"status":"running","needsAttention":false,"requestedTarget":"local",\
"effectiveTarget":"local","hostId":"host_1","hostDisplayName":"Liam’s MacBook Pro",\
"requestedModel":"anthropic:claude-sonnet-5","reasoningEffort":"high",\
"permissionPolicy":"balanced",\
"pinned":false,"archived":false,"lastActivityAt":"2026-08-05T10:00:00.000Z",\
"currentRunId":"run_1","lastSeq":12}
"""

/// A second session that has never run, so every joined field is absent.
private let draftSessionJSON = """
{"id":"sess_2","title":"Draft","goal":"","status":"draft","needsAttention":false,\
"requestedTarget":"automatic","pinned":false,"archived":false,\
"lastActivityAt":"2026-08-05T09:00:00.000Z"}
"""

private let sessionListJSON = #"{"sessions":["# + soleSessionJSON + "," + draftSessionJSON + "]}"

private let completedSessionListJSON = """
{"sessions":[{"id":"sess_1","title":"Tidy the downloads folder","goal":"Sort it",\
"status":"completed","needsAttention":false,"requestedTarget":"local",\
"effectiveTarget":"local","hostId":"host_1","hostDisplayName":"Liam’s MacBook Pro",\
"pinned":false,"archived":false,"lastActivityAt":"2026-08-05T10:00:00.000Z",\
"currentRunId":"run_1","lastSeq":40}]}
"""

private let hostListJSON = """
{"hosts":[
{"id":"host_1","deviceId":"dev_1","displayName":"Liam’s MacBook Pro","state":"idle",\
"enabled":true,"capabilities":["local_files","local_browser"],"activeRunCount":0,\
"queuedRunCount":1,"lastSeenAt":"2026-08-05T10:00:00.000Z","revokedAt":null},
{"id":"host_2","deviceId":"dev_2","displayName":"Studio","state":"offline",\
"enabled":true,"capabilities":[],"activeRunCount":0,"queuedRunCount":0,\
"lastSeenAt":"2026-08-05T08:00:00.000Z","revokedAt":null},
{"id":"host_3","deviceId":"dev_3","displayName":"Old laptop","state":"online",\
"enabled":true,"capabilities":["local_files"],"activeRunCount":0,"queuedRunCount":0,\
"lastSeenAt":"2026-08-05T10:00:00.000Z","revokedAt":"2026-08-04T10:00:00.000Z"}
]}
"""

private let offlineHostJSON = """
{"hosts":[{"id":"host_1","deviceId":"dev_1","displayName":"Liam’s MacBook Pro",\
"state":"offline","enabled":true,"capabilities":["local_files"],"activeRunCount":1,\
"queuedRunCount":0,"lastSeenAt":"2026-08-05T09:00:00.000Z","revokedAt":null}]}
"""

// MARK: - Doubles

/// Answers by path rather than from a queue.
///
/// `refresh()` reads the session list and the host list concurrently, so a
/// queue would hand whichever request happened to arrive first the other one's
/// body — a flake that would look like a decoding bug.
private actor WorkTransport: NativeWorkTransport {
    private let routes: [String: HTTPResponse]
    private let scriptedStream: (status: Int, contentType: String, body: Data)?
    private(set) var requests: [NativeBearerRequest] = []
    private(set) var streamRequests: [NativeBearerRequest] = []

    init(
        routes: [String: HTTPResponse] = [:],
        stream: (status: Int, contentType: String, body: Data)? = nil
    ) {
        self.routes = routes
        scriptedStream = stream
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        requests.append(request)
        guard let response = routes[request.path] else {
            return HTTPResponse(
                statusCode: 500, headers: HTTPHeaders(),
                body: Data(#"{"error":"missing fixture"}"#.utf8)
            )
        }
        return response
    }

    func stream(
        _ request: NativeBearerRequest, for _: AccountID
    ) async throws -> HTTPByteStreamResponse {
        streamRequests.append(request)
        let scripted = scriptedStream
            ?? (status: 500, contentType: "application/json", body: Data())
        return HTTPByteStreamResponse(
            statusCode: scripted.status,
            headers: try HTTPHeaders(["content-type": scripted.contentType]),
            bytes: AsyncThrowingStream { continuation in
                for byte in scripted.body { continuation.yield(byte) }
                continuation.finish()
            }
        )
    }
}
