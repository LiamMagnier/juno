import AppKit
import Foundation
import JunoAuth
import JunoChatKit
import JunoCodeKit
import JunoCodeUI
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import JunoVoiceKit
import SwiftUI
import Testing

@testable import JunoDesktop

/// The premium pass's whole-window pictures: Chat and Code side by side in
/// the one shell grammar, drawn offscreen at 2×, in both appearances — the
/// review set for `docs/design/premium-pass/mac/` and the product shots for
/// `public/brand/product/`.
///
/// Off by default: set `JUNO_PREMIUM_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_PREMIUM_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/<name>-<light|dark>.png`.
///
/// **Sample data only.** The Chat windows run on the harness's `.showcase`
/// world (a sample team's chats, a sample account named Maya Okafor) and the
/// Code window on `CodeShowcase` (a sample TypeScript storefront). Nothing
/// here reads a real account, store or network.
///
/// **What is composed rather than drawn by AppKit.** A titled window's chrome
/// — the traffic lights, the floating sidebar pane's glass and the toolbar's
/// glass capsules — is composited by the window server and cannot be drawn
/// offscreen. The frame here stands in for it: the traffic lights, the pane
/// as the recessed `--sidebar` tone it reads as, and each toolbar item in an
/// opaque capsule, laid out where macOS 26 puts them. Everything inside the
/// columns is the production view.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"] != nil,
        "Set JUNO_PREMIUM_SNAPSHOT_DIR to render the premium pass's windows."
    ),
    .serialized
)
struct PremiumSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"]!)
    }

    nonisolated static let names = ["mac-chat-empty", "mac-chat-conversation", "mac-code-session", "mac-code-empty", "mac-sign-in"]

    @Test(arguments: names)
    func drawsTheWindow(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.showcase()
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let isDark = appearance == .darkAqua
            let view: AnyView
            let size = PremiumFrame.size
            let framed = true
            switch name {
            case "mac-chat-empty":
                world.showDraft()
                view = AnyView(PremiumShots.chatEmpty(world: world))
            case "mac-chat-conversation":
                world.showConversation()
                view = AnyView(PremiumShots.chatConversation(world: world))
            case "mac-code-session":
                view = AnyView(PremiumShots.codeSession(world: world))
            case "mac-code-empty":
                view = AnyView(PremiumShots.codeEmpty(world: world))
            case "mac-sign-in":
                // A configuration with no auth runtime is the one signed-out
                // state constructible offscreen; its buttons draw disabled.
                view = AnyView(
                    JunoDesktopSignInView(
                        authModel: NativeAuthModel(configurationErrorDescription: ""),
                        localStoreRecovery: nil
                    )
                    .frame(width: PremiumFrame.size.width, height: PremiumFrame.size.height)
                    .junoAccentTint()
                )
            default:
                Issue.record("Unknown shot \(name)")
                return
            }
            let url = try await PremiumRenderer.render(
                view,
                size: size,
                framed: framed,
                isDark: isDark,
                into: directory.appendingPathComponent("\(name)-\(isDark ? "dark" : "light").png")
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }
}

// MARK: - The shots

@MainActor
enum PremiumShots {
    static let models = [ModelOption(modelID: "claude-sonnet-5", displayName: "Claude Sonnet 5")]

    static func chatEmpty(world: SnapshotPreviewWorld) -> some View {
        PremiumWindow(
            sidebar: { chatSidebar(world: world, selection: nil) },
            product: .chat,
            title: "New chat",
            subtitle: nil,
            toolbar: [.icon(.privateChat, "Incognito")]
        ) {
            DesktopConversationView(
                model: world.world.conversationModel,
                attachmentModel: world.world.attachmentModel,
                profileName: world.world.session.profile.name,
                configuration: world.configuration,
                session: world.world.session,
                draftProjectID: .constant(nil),
                draftPrompt: .constant(nil),
                composerRequest: .constant(nil),
                findCommand: .constant(nil),
                openDestination: { _ in }
            )
            .junoAccentTint()
        }
    }

    static func chatConversation(world: SnapshotPreviewWorld) -> some View {
        PremiumWindow(
            sidebar: { chatSidebar(world: world, selection: .conversation("conv-1")) },
            product: .chat,
            title: "Launch plan for Field Notes 2.0",
            subtitle: nil,
            toolbar: [.icon(.share, "Share"), .icon(.privateChat, "Incognito")]
        ) {
            VStack(spacing: 0) {
                // Laid over a flexible space rather than stacked, so a reply
                // taller than the window scrolls off the bottom as it would
                // on screen instead of pushing the chrome off the top.
                Color.clear
                    .overlay(alignment: .top) {
                        TranscriptSnapshotFixtures.column {
                            TranscriptSnapshotFixtures.row(launchQuestion)
                            TranscriptSnapshotFixtures.row(launchReply, newest: true)
                        }
                    }
                    .clipped()
                FinalSnapshotFixtures.composer(world: world)
                    .padding(.bottom, JunoSpace.cozy)
            }
            .junoAccentTint()
        }
    }

    static func codeSession(world: SnapshotPreviewWorld) -> some View {
        let controller = CodeShowcase.sessionController()
        let workbench = CodeShowcase.workbench()
        return PremiumWindow(
            sidebar: {
                codeSidebar(world: world, workbench: workbench, selection: .session(CodeShowcase.sessionID))
            },
            product: .code,
            title: "Fix the stale cart total",
            subtitle: "storefront · fix/cart-total",
            toolbar: [
                .labelled(.diff, "Changes", stat: (40, 5), isOn: true),
                .labelled(.terminal, "Terminal"),
                .icon(.more, "More"),
            ],
            inspectorWidth: 452
        ) {
            StudioSessionView(controller: controller, models: models, openReview: { _ in })
        } inspector: {
            StudioSidePanel(
                controller: controller,
                tab: .constant(.changes),
                createPullRequest: {},
                close: {},
                initiallyExpanded: Set(CodeShowcase.featuredPaths)
            )
        }
    }

    static func codeEmpty(world: SnapshotPreviewWorld) -> some View {
        let workbench = CodeShowcase.workbench()
        let project = workbench.workspaces.first
        return PremiumWindow(
            sidebar: {
                codeSidebar(world: world, workbench: workbench, selection: project.map { .repository($0.id) })
            },
            product: .code,
            title: "New session",
            subtitle: nil,
            toolbar: [.labelled(.diff, "Changes", isEnabled: false), .labelled(.terminal, "Terminal", isEnabled: false), .icon(.more, "More")]
        ) {
            StudioLanding(
                workbench: workbench,
                code: nil,
                project: project,
                isStarting: false,
                selectProject: { _ in },
                addProject: {},
                startLocal: { _ in },
                openTask: { _ in }
            )
        }
    }

    // MARK: Columns

    static func chatSidebar(world: SnapshotPreviewWorld, selection: DesktopSidebarItem?) -> some View {
        DesktopChatSidebar(
            model: world.world.conversationModel,
            projectModel: world.world.projectModel,
            configuration: world.configuration,
            session: world.world.session,
            product: .constant(.chat),
            destination: .constant(.chat),
            selection: .constant(selection),
            renamingConversationID: .constant(nil),
            openProjectID: nil,
            actions: DesktopConversationActions(
                rename: { _ in },
                commitRename: { _, _ in },
                togglePin: { _ in },
                move: { _, _ in },
                newProject: { _ in },
                openProject: { _ in },
                share: { _ in },
                canShare: { _ in true },
                archive: { _, _ in },
                delete: { _ in }
            ),
            newChat: {},
            newChatInProject: { _ in },
            openSearch: {}
        )
    }

    static func codeSidebar(
        world: SnapshotPreviewWorld,
        workbench: WorkbenchModel,
        selection: DesktopCodeSidebarItem?
    ) -> some View {
        let sender = world.world.chatTransport
        return DesktopCodeSidebar(
            workbench: workbench,
            code: NativeCodeModel(client: NativeCodeTaskClient(sender: sender, streamer: sender)),
            remote: CodeRemoteBrowserModel(client: NativeCodeRemoteClient(sender: sender)),
            selection: .constant(selection),
            remoteDeviceID: .constant(""),
            product: .constant(.code),
            isBootstrapping: false,
            configuration: world.configuration,
            session: world.world.session,
            openRepository: {},
            newSession: { _ in },
            rename: { _ in },
            openSettings: {}
        )
    }

    // MARK: Content

    static let launchQuestion = TranscriptSnapshotFixtures.message(
        "q-launch",
        .user,
        "We launch Field Notes 2.0 on the 14th. Can you turn my notes into a plan for the last two weeks?"
    )

    static let launchReply = TranscriptSnapshotFixtures.message(
        "a-launch",
        .assistant,
        """
        ## Two weeks to launch

        You have three things to land before the 14th: a stable build, a clear story, and the people who will tell it. Here is the order I would take them in.

        ### Week 1: lock the product

        - **Mon–Tue.** Freeze features and cut the release candidate.
        - **Wednesday.** Send the beta group the build with a three-question survey.
        - **Friday.** Triage the feedback and fix only what blocks the launch.

        ### Week 2: tell the story

        | Day | Owner | Deliverable |
        | --- | --- | --- |
        | Mon | Maya | Press kit and product shots |
        | Wed | Sam | Launch email, scheduled |
        | Thu | Priya | New pricing page, behind a flag |
        | Fri 14th | Everyone | Ship at 9:00, announce at 9:30 |

        One risk to watch: the pricing page depends on the billing migration. If that slips past Wednesday, launch on the current plans and announce the new pricing a week later.
        """,
        model: "anthropic:claude-sonnet-4-6"
    ).with {
        $0.reasoning = "**Ordering the work**\n\nThe build has to be stable before anyone can write about it."
        $0.activity = [
            TranscriptSnapshotFixtures.activityEvent("l-model", .model, "Selected model", detail: "Anthropic · Claude Sonnet 4.6", at: 0),
            TranscriptSnapshotFixtures.activityEvent("l-write", .write, "Writing the answer", detail: "Streaming response text", at: 6.1),
            TranscriptSnapshotFixtures.activityEvent("l-done", .done, "Finished response", at: 11),
        ]
    }
}

// MARK: - The frame

/// One toolbar item as the frame draws it.
enum PremiumToolbarItem {
    case icon(JunoIcon, String)
    case labelled(JunoIcon, String, stat: (Int, Int)? = nil, isOn: Bool = false, isEnabled: Bool = true)
}

/// A macOS 26 window, composed: the floating sidebar pane with the traffic
/// lights and the product switch in its top band, the detail column's title
/// and toolbar capsule over the canvas, and an optional inspector column.
enum PremiumFrame {
    static let size = CGSize(width: 1440, height: 900)
    static let sidebarWidth: CGFloat = 304
    static let toolbarHeight: CGFloat = 52
    static let paneInset: CGFloat = 8
}

struct PremiumWindow<Sidebar: View, Detail: View, Inspector: View>: View {

    @ViewBuilder let sidebar: () -> Sidebar
    let product: DesktopProductMode
    let title: String
    let subtitle: String?
    let toolbar: [PremiumToolbarItem]
    var inspectorWidth: CGFloat = 0
    @ViewBuilder let detail: () -> Detail
    @ViewBuilder let inspector: () -> Inspector

    init(
        @ViewBuilder sidebar: @escaping () -> Sidebar,
        product: DesktopProductMode,
        title: String,
        subtitle: String?,
        toolbar: [PremiumToolbarItem],
        inspectorWidth: CGFloat = 0,
        @ViewBuilder detail: @escaping () -> Detail,
        @ViewBuilder inspector: @escaping () -> Inspector = { EmptyView() }
    ) {
        self.sidebar = sidebar
        self.product = product
        self.title = title
        self.subtitle = subtitle
        self.toolbar = toolbar
        self.inspectorWidth = inspectorWidth
        self.detail = detail
        self.inspector = inspector
    }

    var body: some View {
        let size = PremiumFrame.size
        HStack(spacing: 0) {
            pane
                .frame(width: PremiumFrame.sidebarWidth)
            VStack(spacing: 0) {
                titleBar
                    .frame(height: PremiumFrame.toolbarHeight)
                HStack(spacing: 0) {
                    detail()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipped()
                    if inspectorWidth > 0 {
                        Rectangle().fill(Color.junoBorder).frame(width: 1)
                        inspector()
                            .frame(width: inspectorWidth)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: size.width, height: size.height)
        .background(Color.junoCanvas)
        .environment(\.junoSnapshotOpaqueGlass, true)
        .environment(\.locale, Locale(identifier: "en_US"))
    }

    /// The floating sidebar pane: inset from the window's edges, rounded, in
    /// the recessed column tone the system glass reads as over warm paper.
    private var pane: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach([Color(red: 1, green: 0.373, blue: 0.341), Color(red: 0.996, green: 0.737, blue: 0.180), Color(red: 0.157, green: 0.784, blue: 0.251)], id: \.self) { color in
                    Circle()
                        .fill(color)
                        .overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5))
                        .frame(width: 12, height: 12)
                }
                JunoIconView(.panelLeft, size: 15)
                    .foregroundStyle(Color.junoSidebarInk)
                    .padding(.leading, 14)
                Spacer(minLength: 0)
                PremiumProductSwitchStandIn(product: product)
            }
            .padding(.leading, 14)
            .padding(.trailing, 10)
            .frame(height: PremiumFrame.toolbarHeight - PremiumFrame.paneInset)
            sidebar()
                .scrollContentBackground(.hidden)
        }
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.junoSidebar)
                .shadow(color: Color.black.opacity(0.06), radius: 6, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(PremiumFrame.paneInset)
    }

    private var titleBar: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                    .foregroundStyle(Color.junoForeground)
                if let subtitle {
                    Text(subtitle)
                        .junoFont(size: 11, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
            .padding(.leading, 12)
            Spacer(minLength: 0)
            HStack(spacing: 2) {
                ForEach(Array(toolbar.enumerated()), id: \.offset) { _, item in
                    toolbarItem(item)
                }
            }
            .padding(.horizontal, 6)
            .frame(height: 34)
            .background(Capsule().fill(Color.junoCard.opacity(0.92)))
            .overlay(Capsule().strokeBorder(Color.junoBorder.opacity(0.8), lineWidth: 0.5))
            .shadow(color: Color.junoForeground.opacity(0.06), radius: 4, y: 1)
            .padding(.trailing, 10)
        }
    }

    @ViewBuilder
    private func toolbarItem(_ item: PremiumToolbarItem) -> some View {
        switch item {
        case .icon(let icon, _):
            JunoIconView(icon, size: 16)
                .foregroundStyle(Color.junoForeground)
                .frame(width: 30, height: 28)
        case .labelled(let icon, let label, let stat, let isOn, let isEnabled):
            HStack(spacing: 6) {
                JunoSymbol(icon, weight: isOn ? .fill : .regular)
                Text(label)
                    .junoFont(size: 13, relativeTo: .callout, weight: .medium)
                if let stat {
                    StudioDiffStat(added: stat.0, removed: stat.1)
                }
            }
            .foregroundStyle(Color.junoForeground)
            .opacity(isEnabled ? 1 : 0.4)
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(
                Capsule().fill(isOn ? Color.junoSelectedFill : Color.clear)
            )
        }
    }
}

/// The native toolbar picker as the window server draws it: an AppKit
/// segmented control in the toolbar's glass capsule, which `cacheDisplay`
/// cannot reproduce offscreen (it paints the chosen segment's words white on
/// a white key). Drawn here for the pictures only; the app uses the system
/// control (``DesktopProductSwitch``).
struct PremiumProductSwitchStandIn: View {
    let product: DesktopProductMode

    var body: some View {
        HStack(spacing: 2) {
            ForEach(DesktopProductMode.switchable) { mode in
                let selected = mode == product
                HStack(spacing: 5) {
                    JunoSymbol(mode.icon, weight: selected ? .fill : .regular)
                    Text(mode.label)
                        .junoFont(size: 12, relativeTo: .callout, weight: .medium)
                }
                .foregroundStyle(selected ? Color.junoForeground : Color.junoSecondaryInk)
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background {
                    if selected {
                        Capsule().fill(Color.junoCard).junoRaisedShadow()
                    }
                }
            }
        }
        .padding(3)
        .background(Capsule().fill(Color.junoForeground.opacity(0.06)))
        .overlay(Capsule().strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5))
    }
}

// MARK: - Rendering

@MainActor
enum PremiumRenderer {
    /// Draws `view` at `size` points, 2× pixels. A framed window gets rounded
    /// corners, a hairline and a soft shadow on a transparent margin, so the
    /// PNG drops onto any page; an unframed one is drawn as is.
    static func render<V: View>(
        _ view: V,
        size: CGSize,
        framed: Bool,
        isDark: Bool,
        into url: URL
    ) async throws -> URL {
        let margin: CGFloat = framed ? 48 : 0
        let canvas = CGSize(width: size.width + margin * 2, height: size.height + margin * 2)
        let root = Group {
            if framed {
                view
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(isDark ? Color.white.opacity(0.14) : Color.black.opacity(0.12), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(isDark ? 0.45 : 0.18), radius: 28, y: 14)
                    .frame(width: canvas.width, height: canvas.height)
            } else {
                view.frame(width: size.width, height: size.height)
            }
        }
        .environment(\.colorScheme, isDark ? .dark : .light)
        .environment(\.controlActiveState, .key)
        .transaction { $0.disablesAnimations = true }

        let host = NSHostingView(rootView: root)
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        let window = NSWindow(
            contentRect: CGRect(x: -20_000, y: -20_000, width: canvas.width, height: canvas.height),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = CGRect(origin: .zero, size: canvas)
        host.layoutSubtreeIfNeeded()

        let start = Date()
        while true {
            try await Task.sleep(for: .milliseconds(50))
            host.layoutSubtreeIfNeeded()
            let elapsed = Date().timeIntervalSince(start)
            if elapsed >= 2.0 || (elapsed >= 0.8 && SnapshotProbe.pending == 0) { break }
        }

        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(canvas.width * 2),
            pixelsHigh: Int(canvas.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw TranscriptSnapshotRenderer.Failure.bitmap(url.lastPathComponent) }
        rep.size = canvas
        if let layer = host.layer { TranscriptSnapshotRenderer.circularCapsules(in: layer) }
        host.cacheDisplay(in: host.bounds, to: rep)
        window.close()
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw TranscriptSnapshotRenderer.Failure.encode(url.lastPathComponent)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        return url
    }
}

// MARK: - Voice

/// The voice pass's pictures: the Chat composer during a call, in each phase a
/// call spends its time in, and the two empty states with nothing under their
/// composers. Written to `docs/design/premium-pass/mac/voice/` by pointing
/// `JUNO_PREMIUM_SNAPSHOT_DIR` there.
///
/// **No relay.** Each call is the controller's DEBUG preview session: live,
/// with a transcript and a synthetic level, and nothing dialled.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"] != nil,
        "Set JUNO_PREMIUM_SNAPSHOT_DIR to render the voice pass."
    ),
    .serialized
)
struct PremiumVoiceSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"]!)
    }

    nonisolated static let names = [
        "voice-listening", "voice-speaking", "voice-thinking", "voice-muted", "voice-typing",
        "voice-window-speaking", "voice-chat-empty", "voice-code-empty",
    ]

    @Test(arguments: names)
    func drawsTheCall(_ name: String) async throws {
        let world = try await SnapshotPreviewWorld.showcase()
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let isDark = appearance == .darkAqua
            var size = CGSize(width: 880, height: 220)
            var framed = false
            let view: AnyView
            switch name {
            case "voice-listening":
                view = AnyView(VoiceShots.composer(world: world, call: VoiceShots.call(.listening)))
            case "voice-speaking":
                view = AnyView(VoiceShots.composer(world: world, call: VoiceShots.call(.speaking)))
            case "voice-thinking":
                view = AnyView(VoiceShots.composer(world: world, call: VoiceShots.call(.thinking)))
            case "voice-muted":
                view = AnyView(VoiceShots.composer(world: world, call: VoiceShots.call(.muted)))
            case "voice-typing":
                view = AnyView(
                    VoiceShots.composer(
                        world: world,
                        call: VoiceShots.call(.listening),
                        draft: "And the photo I just added, what do you make of it?"
                    )
                )
            case "voice-window-speaking":
                world.showConversation()
                size = PremiumFrame.size
                framed = true
                view = AnyView(VoiceShots.window(world: world, call: VoiceShots.call(.speaking)))
            case "voice-chat-empty":
                world.showDraft()
                size = PremiumFrame.size
                framed = true
                view = AnyView(PremiumShots.chatEmpty(world: world))
            case "voice-code-empty":
                size = PremiumFrame.size
                framed = true
                view = AnyView(PremiumShots.codeEmpty(world: world))
            default:
                Issue.record("Unknown shot \(name)")
                return
            }
            let url = try await PremiumRenderer.render(
                view,
                size: size,
                framed: framed,
                isDark: isDark,
                into: directory.appendingPathComponent("\(name)-\(isDark ? "dark" : "light").png")
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// The words each phase says, from the controller's own state.
    @Test
    func eachPreviewCallReadsAsItsPhase() {
        #expect(DesktopVoiceCallText.phase(VoiceShots.call(.listening).controller) == .listening)
        #expect(DesktopVoiceCallText.phase(VoiceShots.call(.speaking).controller) == .speaking)
        #expect(DesktopVoiceCallText.phase(VoiceShots.call(.thinking).controller) == .thinking)
        #expect(DesktopVoiceCallText.phase(VoiceShots.call(.muted).controller) == .muted)
    }
}

@MainActor
enum VoiceShots {
    enum State {
        case listening, speaking, thinking, muted
    }

    private struct NoRelay: JunoVoiceRelayAuthorizing {
        func relayToken() async throws -> JunoVoiceRelayToken {
            throw CancellationError()
        }
    }

    /// A live-looking call in `state`, with no relay behind it.
    static func call(_ state: State) -> DesktopVoiceColumn {
        let controller = JunoRealtimeVoiceController(authorization: NoRelay(), provider: .qwen)
        let question = "We launch on the 14th. What should I cut if the billing migration slips?"
        let answer = "Launch on the current plans and move the pricing page a week later. Nothing else depends on it."
        switch state {
        case .listening:
            controller.beginPreviewSession(lines: [(.user, question), (.assistant, answer)], assistantSpeaking: false)
        case .speaking:
            controller.beginPreviewSession(lines: [(.user, question), (.assistant, answer)], assistantSpeaking: true)
        case .thinking:
            controller.beginPreviewSession(lines: [(.user, question)], assistantSpeaking: false)
        case .muted:
            controller.beginPreviewSession(lines: [(.user, question), (.assistant, answer)], assistantSpeaking: false)
            controller.setMuted(true)
        }
        return DesktopVoiceColumn(
            sessionID: UUID(),
            controller: controller,
            saveTranscript: { _, _ in "conv-1" },
            close: {}
        )
    }

    /// The Chat composer, docked, inside `call`.
    static func composer(world: SnapshotPreviewWorld, call: DesktopVoiceColumn, draft: String? = nil) -> some View {
        ChatComposerDock(
            lift: ChatComposerLift.resting,
            gutter: JunoSpace.roomy
        ) {
            EmptyView()
        } composer: {
            ChatComposer(
                model: world.world.conversationModel,
                attachmentModel: world.world.attachmentModel,
                libraryModel: world.world.libraryModel,
                projectModel: world.world.projectModel,
                workspaceModel: nil,
                documentIndex: nil,
                connectorModel: world.world.connectorModel,
                memorySettings: world.world.memorySettingsModel,
                draftProjectID: .constant(nil),
                draftPrompt: .constant(draft),
                openVoiceMode: { _ in }
            )
        } footer: {
            EmptyView()
        }
        .junoVoiceCall(call)
        .padding(.top, JunoSpace.region)
        .frame(width: 880, height: 220, alignment: .top)
        .background(Color.junoCanvas)
        .environment(\.junoSnapshotOpaqueGlass, true)
        .environment(\.locale, Locale(identifier: "en_US"))
        .junoAccentTint()
    }

    /// A conversation window with a call running in its composer.
    static func window(world: SnapshotPreviewWorld, call: DesktopVoiceColumn) -> some View {
        PremiumWindow(
            sidebar: { PremiumShots.chatSidebar(world: world, selection: .conversation("conv-1")) },
            product: .chat,
            title: "Launch plan for Field Notes 2.0",
            subtitle: nil,
            toolbar: [.icon(.share, "Share"), .icon(.privateChat, "Incognito")]
        ) {
            VStack(spacing: 0) {
                Color.clear
                    .overlay(alignment: .top) {
                        TranscriptSnapshotFixtures.column {
                            TranscriptSnapshotFixtures.row(PremiumShots.launchQuestion)
                            TranscriptSnapshotFixtures.row(PremiumShots.launchReply, newest: true)
                        }
                    }
                    .clipped()
                FinalSnapshotFixtures.composer(world: world)
                    .junoVoiceCall(call)
                    .padding(.bottom, JunoSpace.cozy)
            }
            .junoAccentTint()
        }
    }
}
