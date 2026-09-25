import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 4 Stage C's pages drawn offscreen in both appearances:
/// `$JUNO_SNAPSHOT_DIR/pages/<name>-<light|dark>.png` — Automations,
/// Permissions and the host pages, Agents — and the two windows under
/// `$JUNO_FINAL_SNAPSHOT_DIR/pages/` when that is set.
///
/// The data is the stub server below (``StageCPreviewServer``), the pages'
/// own models over it. Every name, count and date in it is preview data.
/// Menus and glass cannot be drawn offscreen: a row's More button is shown
/// at rest (hidden until hover), and the window's chrome uses the Reduce
/// Transparency recipe the foundation set uses.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Stage C page snapshots."
    ),
    .serialized
)
struct PageSnapshotTestsC {
    private func directory(final: Bool) -> URL {
        let environment = ProcessInfo.processInfo.environment
        let root = final ? (environment["JUNO_FINAL_SNAPSHOT_DIR"] ?? environment["JUNO_SNAPSHOT_DIR"]!) : environment["JUNO_SNAPSHOT_DIR"]!
        return URL(fileURLWithPath: root).appendingPathComponent("pages", isDirectory: true)
    }

    @Test(arguments: PageFixturesC.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        let fixture = try #require(await PageFixturesC.fixture(named: name, world: world))
        if let prepare = fixture.prepare {
            try await prepare()
        }
        let isWindow = name.hasPrefix("window-")
        let targets = isWindow && ProcessInfo.processInfo.environment["JUNO_FINAL_SNAPSHOT_DIR"] != nil
            ? [directory(final: false), directory(final: true)]
            : [directory(final: false)]
        for target in targets {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                let url = try await TranscriptSnapshotRenderer.render(
                    fixture.view(),
                    name: fixture.name,
                    width: fixture.width,
                    appearance: appearance,
                    into: target
                )
                #expect(FileManager.default.fileExists(atPath: url.path))
            }
        }
    }
}

enum PageFixturesC {
    static let names = [
        "automations-list",
        "automations-empty",
        "automations-error",
        "automation-detail",
        "automation-detail-paused",
        "automation-new",
        "permissions",
        "permissions-empty",
        "host-this-mac",
        "host-other-mac",
        "host-revoked",
        "agents-roster",
        "agents-first-hire",
        "agent-page",
        "agent-hire",
        "automations-list-narrow",
        "window-automations",
        "window-agents",
    ]

    private typealias F = FinalSnapshotFixtures

    /// The page column beside the sidebar.
    static let pageWidth: CGFloat = F.detailWidth

    @MainActor
    static func fixture(named name: String, world: SnapshotPreviewWorld) async -> FinalFixture? {
        let account = world.world.accountID
        switch name {
        case "automations-list", "automations-list-narrow":
            let model = automationModel(.normal)
            return FinalFixture(
                name: name,
                width: name.hasSuffix("narrow") ? 560 : pageWidth,
                view: { AnyView(stack { DesktopAutomationsScreen(model: model) }.frame(height: name.hasSuffix("narrow") ? 900 : 760)) },
                prepare: { await model.start(for: account) }
            )
        case "automations-empty":
            let model = automationModel(.empty)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: { AnyView(stack { DesktopAutomationsScreen(model: model) }.frame(height: 560)) },
                prepare: { await model.start(for: account) }
            )
        case "automations-error":
            let model = automationModel(.failing)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: { AnyView(stack { DesktopAutomationsScreen(model: model) }.frame(height: 560)) },
                prepare: { await model.start(for: account) }
            )
        case "automation-detail", "automation-detail-paused":
            let model = automationModel(.normal)
            let hosts = hostsModel(.normal)
            let id = name == "automation-detail" ? "auto-sweep" : "auto-watch"
            let context = DesktopAutomationContext(
                model: model,
                hostsModel: hosts,
                modelOptions: [],
                conversationForSession: { _ in "conv-1" }
            )
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: { AnyView(stack { DesktopAutomationPage(scheduleID: id, context: context) }.frame(height: name == "automation-detail" ? 3_700 : 3_900)) },
                prepare: {
                    await model.start(for: account)
                    await hosts.start(for: account)
                    await model.loadHistory(for: id)
                }
            )
        case "automation-new":
            let model = automationModel(.normal)
            let hosts = hostsModel(.normal)
            let context = DesktopAutomationContext(model: model, hostsModel: hosts)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: { AnyView(stack { DesktopNewAutomationPage(context: context) }.frame(height: 2_900)) },
                prepare: {
                    await model.start(for: account)
                    await hosts.start(for: account)
                }
            )
        case "permissions", "permissions-empty":
            let model = hostsModel(name == "permissions" ? .normal : .empty)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(
                        stack { DesktopPermissionsScreen(model: model, accountID: account, thisMac: "host-studio") }
                            .frame(height: name == "permissions" ? 1_120 : 1_000)
                    )
                },
                prepare: { await model.start(for: account) }
            )
        case "host-this-mac", "host-other-mac", "host-revoked":
            let model = hostsModel(.normal)
            let id = switch name {
            case "host-this-mac": "host-studio"
            case "host-other-mac": "host-air"
            default: "host-old"
            }
            let local = name == "host-this-mac" ? DesktopWorkHostModel() : nil
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(
                        stack {
                            DesktopHostPage(hostID: id, model: model, accountID: account, thisMac: "host-studio", localHost: local)
                        }
                        .frame(height: name == "host-this-mac" ? 3_300 : 1_850)
                    )
                },
                prepare: {
                    await model.start(for: account)
                    await model.loadHost(id: id)
                }
            )
        case "agents-roster", "agents-first-hire":
            let model = agentsModel(name == "agents-roster" ? .normal : .empty)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(
                        stack { DesktopAgentsRoster(model: model, apps: [], openConversation: { _ in }) }
                            .frame(height: name == "agents-roster" ? 400 : 700)
                    )
                },
                prepare: { await model.start(for: account) }
            )
        case "agent-page":
            let model = agentsModel(.normal)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(
                        stack {
                            NativeAgentRoutePage(model: model, agentID: "agent-wren", openConversation: { _ in })
                        }
                        .frame(height: 620)
                    )
                },
                prepare: {
                    await model.start(for: account)
                    await model.loadDetail(id: "agent-wren")
                }
            )
        case "agent-hire":
            let model = agentsModel(.normal)
            return FinalFixture(
                name: name,
                width: pageWidth,
                view: {
                    AnyView(
                        stack {
                            NativeAgentHirePage(model: model, templateID: nil, onCancel: {}, onHired: { _ in })
                        }
                        .frame(height: 2_000)
                    )
                },
                prepare: { await model.start(for: account) }
            )
        case "window-automations":
            let model = automationModel(.normal)
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(FoundationFixtures.page(world: world, selection: .destination(.automations)) {
                        stack { DesktopAutomationsScreen(model: model) }
                    })
                },
                prepare: {
                    world.showDraft()
                    await model.start(for: account)
                }
            )
        case "window-agents":
            let model = agentsModel(.normal)
            return FinalFixture(
                name: name,
                width: F.windowWidth,
                view: {
                    AnyView(FoundationFixtures.page(world: world, selection: .destination(.agents)) {
                        stack { DesktopAgentsRoster(model: model, apps: [], openConversation: { _ in }) }
                    })
                },
                prepare: {
                    world.showDraft()
                    await model.start(for: account)
                }
            )
        default:
            return nil
        }
    }

    /// A page as its destination's stack holds it: the stack's push and
    /// replace, the window's toast host, the accent tint of the column.
    @MainActor
    static func stack<Page: View>(@ViewBuilder _ page: () -> Page) -> some View {
        let root = page()
        return DesktopPageStack(destination: .automations, router: DesktopPageRouter()) {
            root
        } page: { _ in
            EmptyView()
        }
        .junoToastHost(JunoToastCenter())
        .junoAccentTint()
    }

    // MARK: Models over the stub

    @MainActor
    static func automationModel(_ scenario: StageCPreviewServer.Scenario) -> NativeWorkAutomationModel {
        NativeWorkAutomationModel(client: NativeWorkAutomationClient(sender: StageCPreviewServer(scenario)))
    }

    @MainActor
    static func hostsModel(_ scenario: StageCPreviewServer.Scenario) -> NativeWorkHostsModel {
        NativeWorkHostsModel(client: NativeWorkClient(transport: StageCPreviewServer(scenario)))
    }

    @MainActor
    static func agentsModel(_ scenario: StageCPreviewServer.Scenario) -> NativeAgentsModel {
        NativeAgentsModel(client: NativeAgentsClient(sender: StageCPreviewServer(scenario)))
    }
}

// MARK: - The stub server

/// Canned answers for the routes Stage C's pages read, by path. Preview data
/// throughout: the names, counts and times are invented for the pictures.
actor StageCPreviewServer: NativeWorkTransport {
    enum Scenario: Sendable {
        case normal
        case empty
        case failing
    }

    private let scenario: Scenario

    init(_ scenario: Scenario) {
        self.scenario = scenario
    }

    func send(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPResponse {
        if scenario == .failing {
            return Self.json(#"{"error":"Service unavailable"}"#, status: 503)
        }
        let path = request.path
        switch path {
        case "/api/work/schedules":
            return Self.json(scenario == .empty ? #"{"schedules":[]}"# : "{\"schedules\":[\(Self.schedules.joined(separator: ","))]}")
        case "/api/work/hosts":
            return Self.json(scenario == .empty ? #"{"hosts":[]}"# : "{\"hosts\":[\(Self.studio),\(Self.air),\(Self.old)]}")
        case "/api/work/hosts/host-studio":
            return Self.json("{\"host\":\(Self.studio),\"grants\":[\(Self.grants)],\"pendingCommands\":1,\"routableCapabilities\":[\"local_files\",\"local_browser\",\"local_computer_use\"]}")
        case "/api/work/hosts/host-air":
            return Self.json("{\"host\":\(Self.air),\"grants\":[],\"pendingCommands\":0,\"routableCapabilities\":[]}")
        case "/api/work/hosts/host-old":
            return Self.json("{\"host\":\(Self.old),\"grants\":[],\"pendingCommands\":0,\"routableCapabilities\":[\"local_files\"]}")
        case "/api/agents":
            return Self.json(scenario == .empty ? #"{"agents":[]}"# : "{\"agents\":[\(Self.agents.joined(separator: ","))]}")
        case "/api/agents/agent-wren":
            return Self.json("{\"agent\":\(Self.agents[0]),\"goals\":[\(Self.goal)],\"ideas\":[],\"notes\":[],\"routines\":[],\"tasks\":[]}")
        case "/api/agents/agent-wren/activity":
            return Self.json(#"{"activity":[]}"#)
        default:
            if path.hasPrefix("/api/work/schedules/"), path.hasSuffix("/runs") {
                return Self.json(path.contains("auto-sweep") ? Self.history : #"{"runs":[],"codeRuns":[]}"#)
            }
            if path.hasPrefix("/api/work/schedules/") {
                return Self.json(#"{"error":"Not found"}"#, status: 404)
            }
            return Self.json(#"{"kind":"skipped","reason":"not_due"}"#)
        }
    }

    func stream(_ request: NativeBearerRequest, for _: AccountID) async throws -> HTTPByteStreamResponse {
        HTTPByteStreamResponse(
            statusCode: 500,
            headers: try HTTPHeaders(["content-type": "application/json"]),
            bytes: AsyncThrowingStream { $0.finish() }
        )
    }

    private static func json(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(statusCode: status, headers: HTTPHeaders(), body: Data(body.utf8))
    }

    // MARK: Dates, relative to now so the sentences read as they would

    private static func iso(_ offset: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(offset))
    }

    private static let hour: TimeInterval = 3_600
    private static let day: TimeInterval = 86_400

    // MARK: Automations

    private static func schedule(
        id: String, name: String, enabled: Bool, instructions: String, target: String, hostID: String?,
        notify: String, nextRun: TimeInterval?, lastRun: TimeInterval?, triggers: String,
        runKind: String = "work", codeConfig: String = "null"
    ) -> String {
        """
        {"id":"\(id)","sessionId":"session-\(id)","name":"\(name)","enabled":\(enabled),
         "instructions":"\(instructions)","instructionsVersion":1,"target":"\(target)",
         "hostId":\(hostID.map { "\"\($0)\"" } ?? "null"),"timezone":"Europe/Paris",
         "runConfig":{},"runConfigVersion":1,"runKind":"\(runKind)","codeConfig":\(codeConfig),
         "hasFireToken":false,"fireTokenIssuedAt":null,
         "budget":{"maxCostMicroUsd":2000000,"maxTokens":0,"maxRuntimeMs":1800000},
         "unattendedPolicy":"pause_for_approval","hostOfflinePolicy":"wait","maxConcurrentRuns":1,
         "notifyPolicy":"\(notify)","missedRunPolicy":"run_once","retryPolicy":{},
         "lastRunAt":\(lastRun.map { "\"\(iso($0))\"" } ?? "null"),
         "nextRunAt":\(nextRun.map { "\"\(iso($0))\"" } ?? "null"),
         "legacyScheduledTaskId":null,"createdAt":"\(iso(-30 * day))","updatedAt":"\(iso(-2 * day))",
         "triggers":[\(triggers)]}
        """
    }

    private static func trigger(_ id: String, _ kind: String, _ config: String, enabled: Bool = true) -> String {
        #"{"id":"\#(id)","kind":"\#(kind)","config":\#(config),"configVersion":1,"enabled":\#(enabled),"lastFiredAt":null,"dedupeWindowSec":0}"#
    }

    private static let schedules = [
        schedule(
            id: "auto-sweep", name: "Monday inbox sweep", enabled: true,
            instructions: "Sort the week's unread mail into what needs me, what can wait and what is noise. Draft replies for anything under five minutes and leave them unsent.",
            target: "local", hostID: "host-studio", notify: "on_attention",
            nextRun: 2 * day + 3 * hour, lastRun: -5 * day,
            triggers: [
                trigger("t-1", "weekly", #"{"weekday":1,"hour":8,"minute":30}"#),
                trigger("t-2", "email_filter", #"{"from":["@stripe.com"],"excludeFrom":[],"subjectContains":[],"excludeSubjectContains":[],"labels":[],"requireAttachment":false}"#),
            ].joined(separator: ",")
        ),
        schedule(
            id: "auto-invoices", name: "File incoming invoices", enabled: true,
            instructions: "Save each invoice to the Invoices folder and add a row to the ledger.",
            target: "automatic", hostID: nil, notify: "none", nextRun: nil, lastRun: -3 * hour,
            triggers: trigger("t-3", "email_filter", #"{"from":["invoices@"],"excludeFrom":[],"subjectContains":["Invoice"],"excludeSubjectContains":[],"labels":[],"requireAttachment":false}"#)
        ),
        schedule(
            id: "auto-deps", name: "Nightly dependency bump", enabled: true,
            instructions: "Bump patch versions, run the tests and open a pull request if they pass.",
            target: "cloud", hostID: nil, notify: "on_attention", nextRun: 16 * hour, lastRun: -8 * hour,
            triggers: trigger("t-4", "cron", #"{"expression":"0 2 * * 1-5"}"#),
            runKind: "code", codeConfig: #"{"repo":{"owner":"juno","name":"app"}}"#
        ),
        schedule(
            id: "auto-watch", name: "Competitor pricing watch", enabled: false,
            instructions: "Check the three competitors' pricing pages and tell me what changed since last week.",
            target: "cloud", hostID: nil, notify: "on_finish", nextRun: 1 * day + 5 * hour, lastRun: -9 * day,
            triggers: [
                trigger("t-5", "daily", #"{"hour":7,"minute":0}"#),
                trigger("t-6", "api", #"{"acceptsText":false}"#),
            ].joined(separator: ",")
        ),
    ]

    private static var history: String {
        """
        {"runs":[
          {"id":"run-3","sessionId":"session-auto-sweep","scheduleId":"auto-sweep","origin":"schedule","status":"completed","requestedTarget":"local","effectiveTarget":"local","hostId":"host-studio","attempt":3,"createdAt":"\(iso(-5 * day))","startedAt":null,"finishedAt":null},
          {"id":"run-2","sessionId":"session-auto-sweep","scheduleId":"auto-sweep","origin":"schedule","status":"cancelled","requestedTarget":"local","effectiveTarget":null,"hostId":null,"attempt":2,"terminalDetail":"The Mac was away, so this fire was skipped.","createdAt":"\(iso(-12 * day))","startedAt":null,"finishedAt":null},
          {"id":"run-1","sessionId":"session-auto-sweep","scheduleId":"auto-sweep","origin":"manual","status":"waiting_approval","requestedTarget":"local","effectiveTarget":"local","hostId":"host-studio","attempt":1,"createdAt":"\(iso(-40 * hour))","startedAt":null,"finishedAt":null}
        ],"codeRuns":[]}
        """
    }

    // MARK: Hosts

    private static var studio: String {
        """
        {"id":"host-studio","deviceId":"device-studio","displayName":"Studio Mac","platform":"macos","appVersion":"1.7.0",
         "enabled":true,"allowsFileWork":true,"allowsBrowser":true,"allowsComputerUse":false,"allowsShell":false,"allowsBackground":true,
         "capabilities":{"toggles":{"enabled":true,"allowsFileWork":true,"allowsBrowser":true,"allowsComputerUse":true,"allowsShell":false,"allowsBackground":true},
                         "capabilities":["local_files","local_browser","local_computer_use"],"approvalPolicy":"permissive"},
         "allowedApps":["com.apple.Safari","com.apple.Numbers"],"blockedApps":["com.agilebits.onepassword7"],"allowedDomains":["stripe.com","github.com"],
         "approvalPolicy":"balanced","state":"online","lastSeenAt":"\(iso(-40))","activeRunCount":1,"queuedRunCount":0,"revokedAt":null}
        """
    }

    private static var air: String {
        """
        {"id":"host-air","deviceId":"device-air","displayName":"MacBook Air","platform":"macos","appVersion":"1.6.2",
         "enabled":true,"allowsFileWork":false,"allowsBrowser":false,"allowsComputerUse":false,"allowsShell":false,"allowsBackground":false,
         "capabilities":{"toggles":{"enabled":true,"allowsFileWork":true},"capabilities":[],"approvalPolicy":"conservative"},
         "allowedApps":[],"blockedApps":[],"allowedDomains":[],
         "approvalPolicy":"conservative","state":"stale","lastSeenAt":"\(iso(-70))","activeRunCount":0,"queuedRunCount":2,"revokedAt":null}
        """
    }

    private static var old: String {
        """
        {"id":"host-old","deviceId":"device-old","displayName":"Old iMac","platform":"macos","appVersion":"1.4.0",
         "enabled":true,"allowsFileWork":true,"allowsBrowser":false,"allowsComputerUse":false,"allowsShell":false,"allowsBackground":false,
         "capabilities":["local_files"],"allowedApps":[],"blockedApps":[],"allowedDomains":[],
         "approvalPolicy":"balanced","state":"offline","lastSeenAt":"\(iso(-3 * day))","activeRunCount":0,"queuedRunCount":0,"revokedAt":"\(iso(-3 * day))"}
        """
    }

    private static var grants: String {
        """
        {"id":"g-1","kind":"local_folder","displayName":"Invoices","accessMode":"read_write_no_delete","hostId":"host-studio","revokedAt":null,"lastUsedAt":"\(iso(-3 * hour))"},
        {"id":"g-2","kind":"local_folder","displayName":"Contracts","accessMode":"read","hostId":"host-studio","revokedAt":null,"lastUsedAt":null}
        """
    }

    // MARK: Agents

    private static func agent(
        id: String, name: String, role: String, state: String, sentence: String, needsYou: Int,
        shape: String, tone: String, eyes: String, mark: String
    ) -> String {
        """
        {"id":"\(id)","name":"\(name)","role":"\(role)",
         "avatar":{"shape":"\(shape)","tone":"\(tone)","eyes":"\(eyes)","mark":"\(mark)"},
         "style":"warm","instructions":"","approvalMode":"balanced","connectorIds":[],"status":"active",
         "proactive":true,"sortOrder":0,"createdAt":"\(iso(-20 * day))","updatedAt":"\(iso(-1 * hour))",
         "state":"\(state)","stateSentence":"\(sentence)","needsYou":\(needsYou),"newIdeas":0}
        """
    }

    private static var agents: [String] {
        let shapes = JunoAgentShape.allCases.map(\.rawValue)
        let tones = JunoAgentTone.allCases.map(\.rawValue)
        let eyes = JunoAgentEyes.allCases.map(\.rawValue)
        let marks = JunoAgentMark.allCases.map(\.rawValue)
        return [
            agent(
                id: "agent-wren", name: "Wren", role: "Inbox and calendar", state: "waiting",
                sentence: "Wants your OK to send two replies.", needsYou: 1,
                shape: shapes[0], tone: tones[min(2, tones.count - 1)], eyes: eyes[0], mark: marks[0]
            ),
            agent(
                id: "agent-quill", name: "Quill", role: "Writer", state: "working",
                sentence: "Drafting the October newsletter.", needsYou: 0,
                shape: shapes[min(1, shapes.count - 1)], tone: tones[min(4, tones.count - 1)],
                eyes: eyes[min(1, eyes.count - 1)], mark: marks[min(1, marks.count - 1)]
            ),
            agent(
                id: "agent-atlas", name: "Atlas", role: "Research", state: "idle",
                sentence: "Ready for the next question.", needsYou: 0,
                shape: shapes[min(2, shapes.count - 1)], tone: tones[min(6, tones.count - 1)],
                eyes: eyes[min(2, eyes.count - 1)], mark: marks[0]
            ),
        ]
    }

    private static var goal: String {
        #"{"id":"goal-1","agentId":"agent-wren","title":"Inbox under fifty by Friday","detail":"","status":"active","cadence":"weekly"}"#
    }
}
