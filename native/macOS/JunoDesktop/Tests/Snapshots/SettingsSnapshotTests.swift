import AppKit
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoSync
import JunoWorkKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// Phase 3 Stage C's pictures: the Settings window at 820 × 600 on each pane,
/// the Upgrade, onboarding and announcement sheets, and a transcript at the
/// largest text size — drawn offscreen in both appearances.
///
/// Off by default: set `JUNO_SNAPSHOT_DIR` (as `TEST_RUNNER_JUNO_SNAPSHOT_DIR`)
/// and run `-only-testing:JunoDesktopTests/SettingsSnapshotTests`.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"] != nil,
        "Set JUNO_SNAPSHOT_DIR to render the Settings set."
    ),
    .serialized
)
struct SettingsSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_SNAPSHOT_DIR"]!)
    }

    @Test(arguments: SettingsSnapshotFixtures.names)
    func drawsInBothAppearances(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.shared()
        // The page router's hooks, as the app installs them, so every row that
        // leads to a page draws its control (DesktopSettingsLinks).
        let links = DesktopSettingsLinks.shared
        links.openMemory = {}
        links.openConnections = {}
        links.openHost = { _ in }
        links.openPermissions = {}
        defer {
            links.openMemory = nil
            links.openConnections = nil
            links.openHost = nil
            links.openPermissions = nil
        }
        let fixture = try #require(await SettingsSnapshotFixtures.fixture(named: name, world: world))
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let url = try await TranscriptSnapshotRenderer.render(
                fixture.view(),
                name: name,
                width: fixture.width,
                appearance: appearance,
                into: directory
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
        JunoAccentSelection.shared.apply(setting: "coral")
    }
}

struct SettingsFixture {
    var width: CGFloat = 820
    let view: @MainActor () -> AnyView
}

@MainActor
enum SettingsSnapshotFixtures {
    static let windowWidth: CGFloat = 820
    static let windowHeight: CGFloat = 600

    nonisolated static let names = [
        "settings-general",
        "settings-personalization",
        "settings-memory",
        "settings-models",
        "settings-connectors",
        "settings-connectors-empty",
        "settings-devices",
        "settings-devices-this-mac-only",
        "settings-devices-host-sheet",
        "settings-voice",
        "settings-data",
        "settings-account",
        "settings-plan-free",
        "settings-plan-pro",
        "settings-save-status",
        "upgrade-sheet",
        "onboarding",
        "announcement-image",
        "announcement-plain",
        "text-size-xl",
    ]

    static func fixture(named name: String, world: SnapshotPreviewWorld) async -> SettingsFixture? {
        switch name {
        case "settings-general":
            let context = makeContext(world: world, accent: "#2f7d8c")
            JunoAccentSelection.shared.apply(setting: "#2f7d8c")
            return window(.general, context)
        case "settings-personalization":
            return window(.personalization, makeContext(world: world))
        case "settings-memory":
            return window(.memory, makeContext(world: world), height: 940)
        case "settings-models":
            return window(.models, makeContext(world: world))
        case "settings-connectors":
            let context = makeContext(world: world)
            await context.services.connectorModel?.start(for: context.accountID)
            return window(.connectors, context)
        case "settings-connectors-empty":
            let context = makeContext(world: world, connectors: .empty)
            context.previewSettings?.blockedConnectors = []
            await context.services.connectorModel?.start(for: context.accountID)
            return window(.connectors, context)
        case "settings-devices":
            let context = makeContext(world: world)
            await context.loadHosts()
            return window(.devices, context)
        case "settings-devices-this-mac-only":
            let context = makeContext(world: world, hosts: [])
            await context.loadHosts()
            return window(.devices, context)
        case "settings-devices-host-sheet":
            let context = makeContext(world: world)
            guard let host = context.services.workHostModel else { return nil }
            return sheet(width: 600, height: 640) {
                DesktopWorkHostSheet(host: host)
            }
        case "settings-voice":
            let context = makeContext(world: world)
            await context.loadPlan()
            return window(.voice, context)
        case "settings-data":
            let context = makeContext(world: world)
            await context.loadSharedLinks()
            return window(.data, context, height: 720)
        case "settings-account":
            let context = makeContext(world: world)
            await context.loadSecurity()
            await context.loadPlan()
            return window(.account, context, height: 980)
        case "settings-plan-free":
            let context = makeContext(world: world, plan: .free)
            await context.loadPlan()
            await context.loadHistory()
            return window(.billing, context, height: 720)
        case "settings-plan-pro":
            let context = makeContext(world: world, plan: .pro)
            await context.loadPlan()
            await context.loadHistory()
            return window(.billing, context, height: 820)
        case "settings-save-status":
            let context = makeContext(world: world, saves: DesktopSaveStates(savedHold: .seconds(30), failedHold: .seconds(30)))
            context.saves.mark("theme", ok: true)
            context.saves.mark("fontSize", ok: false)
            return window(.general, context)
        case "upgrade-sheet":
            return sheet(width: 760, height: 640) {
                DesktopUpgradeSheet(
                    model: DesktopUpgradeModel(sender: nil, accountID: nil, currentPlanID: "FREE"),
                    done: {}
                )
            }
        case "onboarding":
            return sheet(width: 480, height: 440) {
                DesktopOnboardingSheet(settingsModel: nil, initialName: "Ines", finish: {})
            }
        case "announcement-image":
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("juno-announcement-fixture.png")
            try? PreviewImageFixtures.png(for: PreviewImageFixtures.generatedID)?.write(to: url)
            return sheet(width: 560, height: 520) {
                DesktopAnnouncementSheet(
                    announcement: NativeAnnouncement(
                        id: "ann_image",
                        title: "Designs you can edit by talking",
                        description: "Ask for a screen, then change it in plain words: move the button, try a darker header, make it fit a phone.",
                        imageURL: url,
                        newsLabel: "Read More",
                        newsHref: "/news/designs",
                        ctaLabel: "Try It",
                        ctaHref: "/chat/new"
                    ),
                    close: {}
                )
            }
        case "announcement-plain":
            return sheet(width: 560, height: 520) {
                DesktopAnnouncementSheet(
                    announcement: NativeAnnouncement(
                        id: "ann_plain",
                        title: "Claude Opus 4.8 is here",
                        description: "Longer context, steadier tool use and better long documents. It is in the model picker now for every paid plan.",
                        provider: "anthropic",
                        modelName: "Claude Opus 4.8",
                        ctaLabel: "Try Opus 4.8",
                        ctaHref: "/chat/new"
                    ),
                    close: {}
                )
            }
        case "text-size-xl":
            typealias T = TranscriptSnapshotFixtures
            return SettingsFixture(width: TranscriptSnapshotRenderer.columnWidth) {
                AnyView(
                    T.column {
                        T.row(T.question)
                        T.row(T.reply, newest: true)
                    }
                    .environment(\.junoTextScale, DesktopTextSize.xxl.scale)
                )
            }
        default:
            return nil
        }
    }

    // MARK: Compositions

    /// The Settings window: the source list beside the pane, at 820 wide.
    static func window(_ section: DesktopSettingsSection, _ context: DesktopSettingsContext, height: CGFloat = windowHeight) -> SettingsFixture {
        SettingsFixture {
            AnyView(
                HStack(spacing: 0) {
                    DesktopSettingsSnapshotRail(selection: section)
                        .frame(width: DesktopSettingsMetrics.railWidth)
                        .background(Color.junoSidebar)
                    DesktopSettingsScreen(section: section, context: context)
                        .junoToastHost(context.toasts)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.junoCanvas)
                }
                .frame(width: windowWidth, height: height)
                .junoAccentTint()
                .environment(\.junoSnapshotOpaqueGlass, true)
            )
        }
    }

    /// A sheet's content at its own frame, on the system's sheet ground.
    static func sheet<Content: View>(width: CGFloat, height: CGFloat, @ViewBuilder _ content: @escaping () -> Content) -> SettingsFixture {
        SettingsFixture(width: width + 48) {
            AnyView(
                content()
                    .frame(width: width, height: height)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                            .strokeBorder(Color.junoBorder, lineWidth: 1)
                    )
                    .padding(24)
                    .junoAccentTint()
            )
        }
    }

    // MARK: Context

    enum ConnectorFixture {
        case some
        case empty
    }

    enum PlanFixture {
        case free
        case pro
    }

    static func makeContext(
        world: SnapshotPreviewWorld,
        accent: String = "coral",
        plan: PlanFixture = .pro,
        connectors: ConnectorFixture = .some,
        hosts: [WorkHostSummary]? = nil,
        saves: DesktopSaveStates = DesktopSaveStates()
    ) -> DesktopSettingsContext {
        let sender = SettingsSnapshotSender(plan: plan, connectors: connectors)
        let hostList = hosts ?? sampleHosts
        var services = DesktopSettingsContext.Services()
        services.sender = sender
        services.accountData = NativeAccountDataClient(sender: sender)
        services.shareClient = NativeShareClient(sender: sender)
        services.messageActions = NativeMessageActionsClient(sender: sender)
        services.connectorModel = NativeConnectorModel(client: NativeConnectorClient(sender: sender))
        services.workHostModel = DesktopWorkHostModel(defaults: UserDefaults(suiteName: "juno.snapshots.work-host") ?? .standard)
        services.hostsLoader = { _ in hostList }
        let context = DesktopSettingsContext(
            profile: NativeAccountProfile(
                id: world.world.accountID,
                name: "Ines Albuquerque",
                email: "ines@albuquerque.studio",
                imageURL: nil
            ),
            settingsModel: world.world.memorySettingsModel,
            services: services,
            modelCatalog: world.world.conversationModel.selectableModels ?? [],
            saves: saves
        )
        context.previewSettings = settings(world: world, accent: accent)
        return context
    }

    /// The preview account's record, with the fields `GET /api/settings`
    /// supplies filled in.
    static func settings(world: SnapshotPreviewWorld, accent: String) -> NativeAccountSettings? {
        guard var settings = world.world.memorySettingsModel.settings else { return nil }
        settings.accent = accent
        settings.name = "Ines"
        settings.memoryBackgroundLearning = true
        settings.memorySensitiveTopics = ["health", "finances"]
        settings.actionApprovalPolicy = "ask_for_important_actions"
        settings.lockdownMode = false
        settings.blockedConnectors = ["notion"]
        settings.monthlySpendCapEur = nil
        settings.spendCapDisabled = false
        settings.backgroundProviderMode = .sameProvider
        return settings
    }

    static let sampleHosts: [WorkHostSummary] = {
        let now = Date()
        return [
            WorkHostSummary(
                hostID: "host-studio", deviceID: "dev-studio", displayName: "Ines’s Mac Studio",
                state: "online", enabled: true, capabilities: ["local_files", "local_browser"],
                activeRunCount: 1, queuedRunCount: 0, lastSeenAt: now, revokedAt: nil
            ),
            WorkHostSummary(
                hostID: "host-air", deviceID: "dev-air", displayName: "MacBook Air",
                state: "offline", enabled: true, capabilities: ["local_files"],
                activeRunCount: 0, queuedRunCount: 0, lastSeenAt: now.addingTimeInterval(-86_400 * 3), revokedAt: nil
            ),
            WorkHostSummary(
                hostID: "host-old", deviceID: "dev-old", displayName: "Old iMac",
                state: "offline", enabled: false, capabilities: [],
                activeRunCount: 0, queuedRunCount: 0, lastSeenAt: now.addingTimeInterval(-86_400 * 60),
                revokedAt: now.addingTimeInterval(-86_400 * 40)
            ),
        ]
    }()
}

/// The Settings source list as a plain column: the platform's list needs the
/// split view's window to draw its selection, which an offscreen window lacks.
/// Drawn in the rail's groups with each section's tile, as the live rail is.
struct DesktopSettingsSnapshotRail: View {
    let selection: DesktopSettingsSection

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.search, size: 13)
                Text("Search settings")
                Spacer(minLength: 0)
            }
            .junoType(.ui)
            .foregroundStyle(Color.junoTertiaryInk)
            .padding(.horizontal, JunoSpace.snug)
            .frame(height: 28)
            .background(Color.junoInput, in: RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
            .padding(.bottom, JunoSpace.snug)
            ForEach(Array(DesktopSettingsSection.railGroups.enumerated()), id: \.offset) { index, group in
                if index > 0 {
                    Spacer().frame(height: JunoSpace.tight)
                }
                ForEach(group) { section in
                    let selected = section == selection
                    HStack(spacing: JunoSpace.snug) {
                        DesktopSettingsSectionTile(icon: section.icon, selected: selected)
                        Text(section.label)
                            .junoType(.ui)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(selected ? Color.junoForeground : Color.junoSidebarForeground)
                    .padding(.horizontal, JunoSpace.tight)
                    .frame(height: 30)
                    .background(
                        selected ? Color.junoSelectedFill : Color.clear,
                        in: RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    )
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, JunoSpace.cozy)
        .padding(.top, JunoSpace.region + JunoSpace.snug)
    }
}

/// The routes Settings reads, with plausible, unround answers.
private struct SettingsSnapshotSender: NativeAuthenticatedRequestSending {
    let plan: SettingsSnapshotFixtures.PlanFixture
    let connectors: SettingsSnapshotFixtures.ConnectorFixture

    func send(_ request: NativeBearerRequest, for accountID: AccountID) async throws -> HTTPResponse {
        let headers = try HTTPHeaders(["content-type": "application/json"])
        let body: String? = switch request.path {
        case "/api/profile/usage": plan == .free ? Self.freeUsage : Self.proUsage
        case "/api/profile/usage/breakdown": plan == .free ? Self.freeBreakdown : Self.breakdown
        case "/api/share": Self.shares
        case "/api/account/mfa": #"{"enabled":true,"pending":false,"enabledAt":null,"recoveryCodesRemaining":8,"hasPassword":true}"#
        case "/api/connectors": connectors == .empty ? #"{"connectors":[],"composioConfigured":true}"# : Self.connectorList
        default: nil
        }
        guard let body else {
            return HTTPResponse(statusCode: 404, headers: headers, body: Data(#"{"error":"Not found"}"#.utf8))
        }
        return HTTPResponse(statusCode: 200, headers: headers, body: Data(body.utf8))
    }

    private static let now = Date().timeIntervalSince1970 * 1000

    private static var proUsage: String {
        """
        {"quota":{"plan":"PRO","used":214,"limit":null,"remaining":null},
         "spend":{"spentMicroUsd":8374000,"budgetMicroUsd":21739000,"remainingMicroUsd":13365000,"eurPerUsd":0.92,
          "reservedMicroUsd":118000,"capSource":"plan","capDisabled":false,
          "windows":{"session":{"spentMicroUsd":612000,"budgetMicroUsd":1800000,"pct":0.34,"resetsAtMs":\(now + 8_040_000)},
                     "weekly":{"spentMicroUsd":3100000,"budgetMicroUsd":5400000,"pct":0.93,"resetsAtMs":\(now + 259_200_000)}},
          "billing":{"renewsAtMs":\(now + 1_123_200_000),"cancelAtPeriodEnd":false}}}
        """
    }

    private static var freeUsage: String {
        """
        {"quota":{"plan":"FREE","used":6,"limit":15,"remaining":9},
         "spend":{"spentMicroUsd":41000,"budgetMicroUsd":0,"remainingMicroUsd":0,"eurPerUsd":0.92,
          "reservedMicroUsd":0,"capSource":"plan","capDisabled":false,
          "windows":{"session":{"spentMicroUsd":0,"budgetMicroUsd":0,"pct":0,"resetsAtMs":null},
                     "weekly":{"spentMicroUsd":0,"budgetMicroUsd":0,"pct":0,"resetsAtMs":null}},
          "billing":{"renewsAtMs":null,"cancelAtPeriodEnd":false}}}
        """
    }

    private static var breakdown: String {
        history([3, 0, 7, 12, 5, 0, 0, 9, 14, 6, 4, 18, 11, 2, 0, 8, 13, 21, 9, 7, 0, 3, 15, 10, 6, 12, 19, 8, 4, 11])
    }

    /// A Free account: a handful of replies inside its fifteen a month.
    private static var freeBreakdown: String {
        history([0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1])
    }

    private static func history(_ counts: [Int]) -> String {
        let day = 86_400_000.0
        let start = (now / day).rounded(.down) * day - 29 * day
        let daily = counts.enumerated().compactMap { index, count -> String? in
            guard count > 0 else { return nil }
            return #"{"dayMs":\#(start + Double(index) * day),"requests":\#(count),"totalTokens":\#(count * 3117),"costMicroUsd":\#(count * 41_300)}"#
        }
        let total = counts.reduce(0, +)
        return """
        {"range":{"startMs":\(start),"endMs":\(start + 29 * day),"days":30},
         "totals":{"requests":\(total),"promptTokens":\(total * 2400),"completionTokens":\(total * 717),"totalTokens":\(total * 3117),"costMicroUsd":\(total * 41_300)},
         "surfaces":[],"models":[],"daily":[\(daily.joined(separator: ","))],
         "activeDays":24,"currentStreakDays":9,"longestStreakDays":9,"pace":{"lastHour":1,"last24h":11}}
        """
    }

    private static var shares: String {
        let iso = ISO8601DateFormatter()
        let a = iso.string(from: Date().addingTimeInterval(-86_400 * 3))
        let b = iso.string(from: Date().addingTimeInterval(-86_400 * 17))
        return """
        {"shares":[
          {"id":"sh_1","kind":"CHAT","token":"t1","url":"https://juno.example/s/t1","title":"Quarterly forecast walkthrough","snapshotAt":"\(a)","views":14,"createdAt":"\(a)"},
          {"id":"sh_2","kind":"ARTIFACT","token":"t2","url":"https://juno.example/s/t2","title":"Pricing card","snapshotAt":"\(b)","views":1,"createdAt":"\(b)"}
        ]}
        """
    }

    private static let connectorList = """
    {"connectors":[
      {"id":"github","kind":"oauth_app","label":"GitHub","configured":true,"connected":true,"accountLabel":"ines-albuquerque"},
      {"id":"google-calendar","kind":"oauth_app","label":"Google Calendar","configured":true,"connected":true,"accountLabel":"ines@albuquerque.studio"},
      {"id":"notion","kind":"oauth_app","label":"Notion","configured":true,"connected":true,"accountLabel":"Albuquerque Studio"},
      {"id":"slack","kind":"oauth_app","label":"Slack","configured":true,"connected":false,"accountLabel":null}
    ],"composioConfigured":true}
    """
}
