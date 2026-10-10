import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing

@testable import JunoDesktop

/// The Settings window and Customize's pages in a real titled window, chrome
/// and all (``RealWindowRenderer``): the traffic lights, the unified toolbar
/// and its sidebar toggle are AppKit's own, laid out by AppKit, so these
/// tests can prove what the owner's screenshot showed is gone. Window
/// controls over the sidebar's first rows, the toggle over a row, the title
/// over the pane's opening line and a clipped header were one fault: the
/// split view laid out taller than the window, so AppKit centred it and it
/// hung off both edges.
///
/// The geometry always runs. The pictures are written only when
/// `JUNO_SETTINGS_SHOTS_DIR` is set (through xcodebuild as
/// `TEST_RUNNER_JUNO_SETTINGS_SHOTS_DIR`).
@MainActor
@Suite(.serialized)
struct SettingsChromeSnapshotTests {
    static let sizes: [CGSize] = [CGSize(width: 900, height: 640), CGSize(width: 1200, height: 800)]

    private static var shotsDirectory: URL? {
        ProcessInfo.processInfo.environment["JUNO_SETTINGS_SHOTS_DIR"].map(URL.init(fileURLWithPath:))
    }

    // MARK: Settings

    /// Every section at the narrow size, light: no row under the window
    /// controls, no content under the toolbar, and a split view that fits.
    @Test(arguments: DesktopSettingsSection.allCases)
    func settingsSectionSitsBelowTheChrome(_ section: DesktopSettingsSection) async throws {
        let window = try await Self.settingsWindow(section, size: Self.sizes[0], isDark: false)
        defer { window.close() }
        try Self.expectClearOfChrome(window, sidebarWidth: DesktopSettingsMetrics.railWidth, label: section.rawValue)
        try Self.expectLead("settings.lead", in: window, label: section.rawValue)
    }

    /// The window's floor and the sidebar's width are the web's numbers.
    @Test
    func settingsWindowMetrics() {
        #expect(DesktopSettingsMetrics.railWidth == 260)
        #expect(DesktopSettingsMetrics.windowMinimum.width >= 760)
        #expect(DesktopSettingsMetrics.windowMinimum.height >= 520)
        #expect(DesktopSettingsMetrics.windowIdeal.width >= DesktopSettingsMetrics.windowMinimum.width)
        #expect(DesktopSettingsMetrics.windowIdeal.height >= DesktopSettingsMetrics.windowMinimum.height)
    }

    nonisolated static let shotSections: [DesktopSettingsSection] = [.general, .models, .code, .account]

    @Test(
        .enabled(if: ProcessInfo.processInfo.environment["JUNO_SETTINGS_SHOTS_DIR"] != nil),
        arguments: shotSections
    )
    func drawsTheSettingsWindow(_ section: DesktopSettingsSection) async throws {
        let directory = try #require(Self.shotsDirectory)
        for size in Self.sizes {
            for isDark in [false, true] {
                let window = try await Self.settingsWindow(section, size: size, isDark: isDark)
                try Self.expectClearOfChrome(window, sidebarWidth: DesktopSettingsMetrics.railWidth, label: section.rawValue)
                let name = "settings-\(section.rawValue)-\(Int(size.width))x\(Int(size.height))-\(isDark ? "dark" : "light").png"
                try RealWindowRenderer.capture(window, into: directory.appendingPathComponent(name))
                window.close()
            }
        }
        JunoAccentSelection.shared.apply(setting: "coral")
    }

    static func settingsWindow(_ section: DesktopSettingsSection, size: CGSize, isDark: Bool) async throws -> NSWindow {
        let world = try await SnapshotPreviewWorld.shared()
        let links = DesktopSettingsLinks.shared
        links.openMemory = {}
        links.openConnections = {}
        links.openHost = { _ in }
        links.openPermissions = {}
        let context = SettingsSnapshotFixtures.makeContext(world: world)
        switch section {
        case .account:
            await context.loadSecurity()
            await context.loadPlan()
        case .billing:
            await context.loadPlan()
            await context.loadHistory()
        case .devices:
            await context.loadHosts()
        case .data:
            await context.loadSharedLinks()
        case .voice:
            await context.loadPlan()
        default:
            break
        }
        var current = section
        let selection = Binding(get: { current }, set: { current = $0 })
        let root = DesktopSettingsShell(section: selection, context: context)
            .desktopSettingsWindowFrame()
            .junoAccentTint()
            .environment(\.locale, Locale(identifier: "en_US"))
        return try await RealWindowRenderer.host(root, size: size, isDark: isDark)
    }

    // MARK: Customize

    nonisolated static let customizePages: [DesktopDestination] = [.instructions, .memory]

    /// Customize › Instructions in the main window: its page sits below the
    /// toolbar and the tabs, and its rows are actually drawn (the page was
    /// blank, its form scrolled up under the bar).
    @Test
    func instructionsSitBelowTheBar() async throws {
        let window = try await Self.mainWindow(.instructions, size: Self.sizes[1], isDark: false)
        defer { window.close() }
        try Self.expectClearOfChrome(window, sidebarWidth: DesktopSidebarMetrics.idealWidth, label: "instructions")
        let lead = try Self.expectLead("page.lead", in: window, label: "instructions")
        let tabs = try #require(DesktopLayoutProbe.frames["customize.tabs"], "the Customize tabs were not drawn")
        #expect(tabs.minY >= ChromeGeometry(window).titlebarHeight - 1, "the tabs sit under the toolbar: \(tabs)")
        #expect(lead.minY >= tabs.maxY, "the page's title sits under the tabs: \(lead) vs \(tabs)")
    }

    @Test(
        .enabled(if: ProcessInfo.processInfo.environment["JUNO_SETTINGS_SHOTS_DIR"] != nil),
        arguments: customizePages
    )
    func drawsCustomizePage(_ destination: DesktopDestination) async throws {
        let directory = try #require(Self.shotsDirectory)
        for size in Self.sizes {
            for isDark in [false, true] {
                let window = try await Self.mainWindow(destination, size: size, isDark: isDark)
                let name = "customize-\(destination.rawValue)-\(Int(size.width))x\(Int(size.height))-\(isDark ? "dark" : "light").png"
                try RealWindowRenderer.capture(window, into: directory.appendingPathComponent(name))
                window.close()
            }
        }
    }

    static func mainWindow(_ destination: DesktopDestination, size: CGSize, isDark: Bool) async throws -> NSWindow {
        let world = try await SnapshotPreviewWorld.shared()
        let conversationModel = try #require(world.configuration.conversationModel)
        // The snapshot world has no memory service; the Stage B fixtures'
        // page model (loaded from the preview sender) stands in for it.
        let pages = try await StageBPageWorld.shared(world)
        let projectModel = world.world.projectModel
        let memoryContext = DesktopMemoryContext(page: pages.memoryPage()) {
            projectModel.projects.map { DesktopMemoryProject(id: $0.id, name: $0.name) }
        }
        let root = DesktopChatWorkspace(
            model: conversationModel,
            configuration: world.configuration,
            session: world.world.session,
            product: .constant(.chat),
            initialDestination: destination,
            consumeInitialDestination: nil,
            unscopedChatRequestID: nil,
            consumeUnscopedChatRequest: {}
        )
        .environment(\.desktopMemoryContext, memoryContext)
        .junoAccentTint()
        .environment(\.locale, Locale(identifier: "en_US"))
        return try await RealWindowRenderer.host(root, size: size, isDark: isDark, settle: .milliseconds(2500))
    }

    // MARK: The assertions

    /// The pane's opening (a Settings hero, a page's title) is drawn inside
    /// the window, below the titlebar and toolbar band, clear of the window
    /// controls.
    @discardableResult
    static func expectLead(_ key: String, in window: NSWindow, label: String) throws -> CGRect {
        let geometry = ChromeGeometry(window)
        let lead = try #require(DesktopLayoutProbe.frames[key], "\(label): the pane's opening was not drawn")
        #expect(lead.minY >= geometry.titlebarHeight - 1, "\(label): the opening sits under the toolbar: \(lead) \(geometry.description)")
        #expect(lead.maxY <= geometry.windowHeight, "\(label): the opening is below the window: \(lead)")
        #expect(!lead.intersects(geometry.windowControls), "\(label): the opening is under the traffic lights: \(lead)")
        #expect(lead.height > 0 && lead.width > 0, "\(label): the opening has no size: \(lead)")
        return lead
    }

    /// Nothing the reader needs sits under the window's chrome: no row
    /// touches the traffic lights, the first row on each side starts below
    /// the titlebar and toolbar band, and the split view fits the window.
    static func expectClearOfChrome(_ window: NSWindow, sidebarWidth: CGFloat, label: String) throws {
        let geometry = ChromeGeometry(window)
        let detail = "\(label): \(geometry.description)"
        #expect(!geometry.windowControls.isNull, "no window controls: \(detail)")
        #expect(geometry.titlebarHeight > 0, "no titlebar band: \(detail)")
        for row in geometry.rows {
            #expect(!row.frame.intersects(geometry.windowControls), "a row sits under the traffic lights: \(row.frame) \(detail)")
        }
        let sidebarTop = try #require(geometry.firstRowTop(leftOf: sidebarWidth - 1), "the sidebar drew no rows: \(detail)")
        #expect(sidebarTop >= geometry.titlebarHeight - 1, "the sidebar starts under the toolbar: \(detail)")
        if let detailTop = geometry.firstRowTop(rightOf: sidebarWidth) {
            #expect(detailTop >= geometry.titlebarHeight - 1, "the pane starts under the toolbar: \(detail)")
        }
        for split in geometry.splitViews {
            #expect(split.minY >= -0.5 && split.maxY <= geometry.windowHeight + 0.5, "the split view overflows the window: \(split) \(detail)")
        }
    }
}
