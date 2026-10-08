import AppKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// About Juno (premium pass): replaces the system's standard About panel.
///
/// A painted plate as a quiet header (dawn in light, dusk in dark, the same
/// pair the sign-in window wears), the app icon set on its lower edge, the
/// name in the display face, this build in the secondary mono, one plain line
/// from the updater, and the links. The window is a fixed size with a hidden
/// title bar, so the plate runs under the traffic lights the way Arc's and
/// Things' About windows do.
///
/// Signature detail: the icon settles onto the plate as the window opens, a
/// short rise on the emphasized spring (a fade alone under Reduce Motion).
struct DesktopAboutWindow: View {
    @State private var updater = DesktopUpdateModel.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        DesktopAboutPanel(
            build: JunoBuildInfo.current,
            updatePhase: updater.phase,
            openUpdates: {
                if case .ready = updater.phase {} else { updater.checkNow() }
                openWindow(id: JunoDesktopWindow.softwareUpdateID)
            }
        )
        .containerBackground(Color.junoCanvas, for: .window)
        .accessibilityIdentifier("juno.desktop.about")
    }
}

/// The About window's content, a pure function of the build and the
/// updater's phase so it can be drawn offscreen.
struct DesktopAboutPanel: View {
    let build: JunoBuildInfo
    let updatePhase: DesktopUpdateModel.Phase
    var openUpdates: () -> Void = {}
    /// Snapshots draw the settled state; the window plays the settle.
    var animatesEntrance = true

    static let width: CGFloat = 380
    static let plateHeight: CGFloat = 148
    static let iconSize: CGFloat = 96

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @State private var settled = false
    @State private var showingAcknowledgements = false

    var body: some View {
        VStack(spacing: 0) {
            DesktopAboutPlate()
                .frame(width: Self.width, height: Self.plateHeight)

            DesktopAppIconImage(size: Self.iconSize)
                .shadow(color: Color.junoCardShadow, radius: JunoElevation.liftBlur, y: JunoElevation.liftOffsetY)
                .padding(.top, -Self.iconSize / 2)
                .offset(y: isSettled ? 0 : 8)
                .opacity(isSettled ? 1 : 0)

            VStack(spacing: JunoSpace.tight) {
                // The outlined Alevr wordmark, not the name set in type.
                JunoWordmark(height: 30)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Chat and code, in one calm place.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.top, JunoSpace.regular)

            VStack(spacing: JunoSpace.micro) {
                Text(versionText)
                    .junoType(.monoSmall)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .textSelection(.enabled)
                    .accessibilityLabel(versionText.replacingOccurrences(of: "·", with: ","))
                updateLine
            }
            .padding(.top, JunoSpace.roomy)

            links
                .padding(.top, JunoSpace.section)

            Text(Self.copyright)
                .junoType(.caption)
                .foregroundStyle(Color.junoTertiaryInk)
                .padding(.top, JunoSpace.cozy)
                .padding(.bottom, JunoSpace.section)
        }
        .frame(width: Self.width)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            guard animatesEntrance, !settled else { return }
            withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) { settled = true }
        }
    }

    private var isSettled: Bool { !animatesEntrance || settled }

    /// "Version 1.7.0 (88)", with the channel when it is not stable.
    private var versionText: String {
        let channel = build.channel.lowercased()
        let base = "Version \(build.displayVersion)"
        guard channel != "stable", channel != "unknown", !channel.isEmpty else { return base }
        return "\(base) · \(channel)"
    }

    static var copyright: String {
        (Bundle.main.object(forInfoDictionaryKey: "NSHumanReadableCopyright") as? String)
            .flatMap { $0.hasPrefix("$(") ? nil : $0 }
            ?? "Copyright © 2026 Liam Magnier."
    }

    // MARK: The updater's line

    /// One plain line: a normal state in the secondary ink, a ready update as
    /// a link into Software Update, and a failure in its colour. No pill.
    @ViewBuilder
    private var updateLine: some View {
        switch updatePhase {
        case .ready(let version):
            linkButton("Alevr \(version) is ready. Restart to update", ink: .junoAccentInk, action: openUpdates)
        case .downloading(let version, _):
            linkButton("Downloading Alevr \(version)", ink: .junoSecondaryInk, action: openUpdates)
        case .checking:
            JunoShimmerText("Checking for updates", font: JunoType.label.font())
        case .current:
            linkButton("Up to date", ink: .junoSecondaryInk, action: openUpdates)
        case .failed:
            linkButton("The last update check failed", ink: .junoDestructiveInk, action: openUpdates)
        case .idle, .unsupported:
            linkButton("Check for Updates", ink: .junoSecondaryInk, action: openUpdates)
        }
    }

    // MARK: Links

    private var links: some View {
        HStack(spacing: JunoSpace.regular) {
            linkButton("Website", ink: .junoSecondaryInk) { openURL(JunoBackend.productionURL) }
            linkButton("Privacy", ink: .junoSecondaryInk) {
                openURL(JunoBackend.productionURL.appending(path: "legal/confidentialite"))
            }
            linkButton("Terms", ink: .junoSecondaryInk) {
                openURL(JunoBackend.productionURL.appending(path: "legal/cgu"))
            }
            linkButton("Acknowledgements", ink: .junoSecondaryInk) { showingAcknowledgements = true }
                .popover(isPresented: $showingAcknowledgements, arrowEdge: .bottom) {
                    DesktopAcknowledgements()
                }
        }
    }

    private func linkButton(_ title: String, ink: Color, action: @escaping () -> Void) -> some View {
        DesktopAboutLink(title: title, ink: ink, action: action)
    }
}

/// A quiet text link: its ink at rest, the foreground under the pointer.
private struct DesktopAboutLink: View {
    let title: String
    let ink: Color
    let action: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Text(title)
                .junoType(JunoType.label.weight(.regular))
                .foregroundStyle(hovering ? Color.junoForeground : ink)
                .underline(hovering, color: Color.junoBorder)
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: hovering)
    }
}

/// The painted plate, fading into the canvas at its foot so the icon sits on
/// paper rather than on a picture's edge. Falls back to the brand's recessed
/// tone when the bundle carries no plate.
struct DesktopAboutPlate: View {
    @Environment(\.colorScheme) private var colorScheme

    private var plate: NSImage? {
        NSImage(named: colorScheme == .dark ? "SignInPlateDusk" : "SignInPlateDawn")
    }

    var body: some View {
        ZStack {
            Color.junoSidebar
            if let plate {
                Image(nsImage: plate)
                    .resizable()
                    .scaledToFill()
            }
        }
        .mask(
            LinearGradient(
                stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55), .init(color: .clear, location: 1)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .clipped()
        .accessibilityHidden(true)
    }
}

/// What ships inside the app that someone else made, and under which licence.
struct DesktopAcknowledgements: View {
    static let entries: [(name: String, detail: String)] = [
        ("Newsreader", "Production Type. SIL Open Font License 1.1"),
        ("Mermaid", "Knut Sveidqvist and contributors. MIT License"),
        ("React and React DOM", "Meta Platforms. MIT License"),
        ("Babel", "Sebastian McKenzie and contributors. MIT License"),
        ("Tailwind CSS", "Tailwind Labs. MIT License"),
        ("Phosphor Icons", "Phosphor Icons. MIT License"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            Text("Acknowledgements")
                .junoType(JunoType.ui.weight(.semibold))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            ForEach(Self.entries, id: \.name) { entry in
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.name)
                        .junoType(JunoType.label.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                    Text(entry.detail)
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(JunoSpace.regular)
        .frame(width: 300, alignment: .leading)
    }
}
