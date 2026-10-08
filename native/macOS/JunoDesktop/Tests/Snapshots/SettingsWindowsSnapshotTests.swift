import AppKit
import Foundation
import JunoCore
import JunoDesignSystem
import JunoPreviewSupport
import SwiftUI
import Testing

@testable import JunoDesktop

/// The premium pass's utility windows: Settings (the grouped rail and the
/// reworked panes), About Juno, and every state of Software Update, drawn
/// offscreen at 2× in both appearances for `docs/design/premium-pass/mac/settings/`.
///
/// Off by default: set `JUNO_PREMIUM_SNAPSHOT_DIR` (through xcodebuild, as
/// `TEST_RUNNER_JUNO_PREMIUM_SNAPSHOT_DIR`) and the suite writes
/// `<dir>/settings/<name>-<light|dark>.png`.
///
/// **Sample data only**: the Settings account is the harness's sample
/// (Ines Albuquerque); the updater's states are values, so nothing polls a
/// feed, downloads or stages a bundle.
///
/// **What is composed.** A titled window's chrome is drawn by the window
/// server and cannot be captured offscreen; the frame here stands in for it
/// (traffic lights, the title, the recessed sidebar pane). Everything inside
/// is the production view.
@MainActor
@Suite(
    .enabled(
        if: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"] != nil,
        "Set JUNO_PREMIUM_SNAPSHOT_DIR to render the premium pass's utility windows."
    ),
    .serialized
)
struct SettingsWindowsSnapshotTests {
    private var directory: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["JUNO_PREMIUM_SNAPSHOT_DIR"]!)
            .appendingPathComponent("settings")
    }

    nonisolated static let names = [
        "about",
        "about-update-ready",
        "update-idle",
        "update-checking",
        "update-current",
        "update-downloading",
        "update-ready",
        "update-ready-notes",
        "update-failed",
        "update-unsupported",
        "settings-general",
        "settings-account",
        "settings-plan-pro",
        "settings-plan-free",
    ]

    static let installed = JunoBuildInfo(version: "1.7.0", build: "88", gitSHA: "dbc035b3", contractVersion: "1", channel: "stable")
    static let checkedAt = Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 9, day: 26, hour: 15, minute: 17))!

    static let notes = """
    **Settings, About and updates, rebuilt.** Each is calmer and easier to read.

    - Software Update shows what is new, the versions from and to, and a real progress bar.
    - Plan & usage measures the month with the system's own meters.
    - The Settings sidebar groups its sections, each with its own tile.

    Fixed: the model picker no longer forgets a favorite after a restart.
    """

    @Test(arguments: names)
    func drawsTheWindow(_ name: String) async throws {
        for isDark in [false, true] {
            let (view, size) = try await Self.shot(name)
            let url = try await PremiumRenderer.render(
                view.environment(\.locale, Locale(identifier: "en_US")),
                size: size,
                framed: true,
                isDark: isDark,
                into: directory.appendingPathComponent("\(name)-\(isDark ? "dark" : "light").png")
            )
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
        JunoAccentSelection.shared.apply(setting: "coral")
    }

    static func shot(_ name: String) async throws -> (AnyView, CGSize) {
        switch name {
        case "about":
            return about(.current(checkedAt: checkedAt))
        case "about-update-ready":
            return about(.ready(version: "1.8.0"))
        case "update-idle":
            return update(.idle)
        case "update-checking":
            return update(.checking)
        case "update-current":
            return update(.current(checkedAt: checkedAt))
        case "update-downloading":
            return update(.downloading(version: "1.8.0", fraction: 0.43), size: 118_400_000)
        case "update-ready":
            return update(.ready(version: "1.8.0"))
        case "update-ready-notes":
            return update(.ready(version: "1.8.0"), notes: notes)
        case "update-failed":
            return update(.failed("The update download didn’t match its published checksum."))
        case "update-unsupported":
            return update(.unsupported("Alevr can't update itself where it is installed. Download the new version instead."))
        default:
            return try await settings(name)
        }
    }

    // MARK: About

    static func about(_ phase: DesktopUpdateModel.Phase) -> (AnyView, CGSize) {
        let panel = DesktopAboutPanel(build: installed, updatePhase: phase, animatesEntrance: false)
            .junoAccentTint()
        let size = measured(panel, width: DesktopAboutPanel.width)
        return (
            AnyView(
                panel
                    .background(Color.junoCanvas)
                    .overlay(alignment: .topLeading) { TrafficLights().padding(14) }
            ),
            size
        )
    }

    // MARK: Software Update

    static func update(_ phase: DesktopUpdateModel.Phase, notes: String? = nil, size bytes: Int? = nil) -> (AnyView, CGSize) {
        let panel = DesktopUpdatePanel(
            phase: phase,
            installed: installed,
            notes: notes,
            downloadSize: bytes,
            actions: .init()
        )
        .junoAccentTint()
        let content = measured(panel, width: DesktopUpdatePanel.width)
        let size = CGSize(width: content.width, height: content.height + TitleBar.height)
        return (
            AnyView(
                VStack(spacing: 0) {
                    TitleBar(title: "Software Update")
                    panel
                }
                .background(Color.junoCanvas)
            ),
            size
        )
    }

    // MARK: Settings

    static func settings(_ name: String) async throws -> (AnyView, CGSize) {
        let world = try await SnapshotPreviewWorld.shared()
        let links = DesktopSettingsLinks.shared
        links.openMemory = {}
        links.openConnections = {}
        links.openHost = { _ in }
        links.openPermissions = {}
        let section: DesktopSettingsSection
        let context: DesktopSettingsContext
        let height: CGFloat
        switch name {
        case "settings-general":
            context = SettingsSnapshotFixtures.makeContext(world: world)
            section = .general
            height = 640
        case "settings-account":
            context = SettingsSnapshotFixtures.makeContext(world: world)
            await context.loadSecurity()
            await context.loadPlan()
            section = .account
            height = 1100
        case "settings-plan-pro":
            context = SettingsSnapshotFixtures.makeContext(world: world, plan: .pro)
            await context.loadPlan()
            await context.loadHistory()
            section = .billing
            height = 860
        case "settings-plan-free":
            context = SettingsSnapshotFixtures.makeContext(world: world, plan: .free)
            await context.loadPlan()
            await context.loadHistory()
            section = .billing
            height = 760
        default:
            Issue.record("Unknown shot \(name)")
            throw CancellationError()
        }
        let width: CGFloat = 860
        return (
            AnyView(
                HStack(spacing: 0) {
                    DesktopSettingsSnapshotRail(selection: section)
                        .overlay(alignment: .topLeading) { TrafficLights().padding(14) }
                        .frame(width: DesktopSettingsMetrics.railWidth)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.junoSidebar)
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .strokeBorder(Color.junoBorder.opacity(0.7), lineWidth: 0.5)
                            )
                    )
                    .padding(8)
                    VStack(spacing: 0) {
                        HStack {
                            Text(section.label)
                                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                                .foregroundStyle(Color.junoForeground)
                                .padding(.leading, 12)
                            Spacer(minLength: 0)
                        }
                        .frame(height: 52)
                        DesktopSettingsScreen(section: section, context: context)
                            .junoToastHost(context.toasts)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .frame(width: width, height: height)
                .background(Color.junoCanvas)
                .junoAccentTint()
                .environment(\.junoSnapshotOpaqueGlass, true)
            ),
            CGSize(width: width, height: height)
        )
    }

    // MARK: Furniture

    /// A fixed-width view's own height, as the window would size to it.
    static func measured<V: View>(_ view: V, width: CGFloat) -> CGSize {
        let host = NSHostingView(rootView: view.frame(width: width))
        let fitting = host.fittingSize
        return CGSize(width: width, height: ceil(fitting.height))
    }
}

/// The three window controls, as the window server draws them.
private struct TrafficLights: View {
    var body: some View {
        HStack(spacing: 8) {
            ForEach([Color(red: 1, green: 0.373, blue: 0.341), Color(red: 0.996, green: 0.737, blue: 0.180), Color(red: 0.157, green: 0.784, blue: 0.251)], id: \.self) { color in
                Circle()
                    .fill(color)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5))
                    .frame(width: 12, height: 12)
            }
        }
    }
}

/// A standard title bar: the lights and the centred title.
private struct TitleBar: View {
    static let height: CGFloat = 32
    let title: String

    var body: some View {
        ZStack {
            Text(title)
                .junoFont(size: 13, relativeTo: .callout, weight: .semibold)
                .foregroundStyle(Color.junoForeground)
            HStack {
                TrafficLights()
                Spacer(minLength: 0)
            }
            .padding(.leading, 14)
        }
        .frame(height: Self.height)
    }
}
