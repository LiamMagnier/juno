import AppKit
import JunoCore
import JunoDesignSystem
import SwiftUI

// MARK: - The window

/// Software Update: the updater's one window (premium pass).
///
/// Opened from the application menu's Check for Updates…, from Settings ›
/// General, from the About window and from the sidebar's "Update ready" line.
/// It never opens on its own: the updater's rule is that nothing it does
/// interrupts anyone, and a window that jumps forward mid-sentence is exactly
/// that. A staged update still lands quietly at the next quit.
///
/// The view is ``DesktopUpdatePanel``, a pure function of the updater's phase,
/// so every state can be drawn offscreen without a feed, a download or a
/// staged bundle (`SoftwareUpdateSnapshotTests`).
struct DesktopSoftwareUpdateWindow: View {
    @State private var updater = DesktopUpdateModel.shared
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openURL) private var openURL

    var body: some View {
        DesktopUpdatePanel(
            phase: updater.phase,
            installed: JunoBuildInfo.current,
            notes: updater.releaseNotes,
            downloadSize: updater.downloadSize,
            actions: DesktopUpdatePanel.Actions(
                check: { updater.checkNow() },
                restart: { updater.installAndRelaunch() },
                close: { dismissWindow(id: JunoDesktopWindow.softwareUpdateID) },
                openDownloads: { openURL(DesktopUpdatePanel.downloadPage) }
            )
        )
        .containerBackground(Color.junoCanvas, for: .window)
        .accessibilityIdentifier("juno.desktop.software-update")
    }
}

// MARK: - The panel

/// Every state of the updater as one calm panel: the app icon, one sentence
/// of headline, the versions from and to, a native progress bar only while a
/// download is genuinely measured, the release notes when the feed carries
/// them, and at most one prominent button.
///
/// House rules it keeps: no status pill and no status dot (a normal state is a
/// plain secondary line); an attention state is its colour and its glyph as
/// text; motion is the ladder's, under Reduce Motion.
struct DesktopUpdatePanel: View {
    let phase: DesktopUpdateModel.Phase
    let installed: JunoBuildInfo
    var notes: String?
    var downloadSize: Int?
    let actions: Actions

    struct Actions {
        var check: () -> Void = {}
        var restart: () -> Void = {}
        var close: () -> Void = {}
        var openDownloads: () -> Void = {}
    }

    /// The download page, where a build that cannot update itself is fetched
    /// by hand, and where each release is described.
    static let downloadPage = JunoBackend.productionURL.appending(path: "download")

    static let width: CGFloat = 480
    static let iconSize: CGFloat = 64
    static let notesHeight: CGFloat = 188

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                DesktopAppIconImage(size: Self.iconSize)
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    // The window's one display moment, in the face the
                    // About window sets its name in.
                    Text(headline)
                        .junoType(.display(size: 26))
                        .foregroundStyle(Color.junoForeground)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .contentTransition(.opacity)
                    versionLine
                    detail
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if case .downloading(_, let fraction) = phase {
                progress(fraction)
                    .padding(.top, JunoSpace.roomy)
                    .padding(.leading, Self.iconSize + JunoSpace.regular)
                    .transition(.opacity)
            }

            if showsNotes, let notes {
                whatsNew(notes)
                    .padding(.top, JunoSpace.roomy)
                    .transition(.opacity)
            }

            footer
                .padding(.top, JunoSpace.section)
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.top, JunoSpace.roomy)
        .padding(.bottom, JunoSpace.roomy)
        .frame(width: Self.width)
        .fixedSize(horizontal: false, vertical: true)
        .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: stateKey)
    }

    // MARK: Words

    /// One key per state, so a percentage ticking over is not a state change.
    private var stateKey: String {
        switch phase {
        case .idle: "idle"
        case .checking: "checking"
        case .current: "current"
        case .downloading: "downloading"
        case .ready: "ready"
        case .failed: "failed"
        case .unsupported: "unsupported"
        }
    }

    private var offeredVersion: String? {
        switch phase {
        case .downloading(let version, _), .ready(let version): version
        default: nil
        }
    }

    private var headline: String {
        switch phase {
        case .idle: "Software Update"
        case .checking: "Checking for updates"
        case .current: "Alevr is up to date"
        case .downloading(let version, _): "Downloading Alevr \(version)"
        case .ready(let version): "Alevr \(version) is ready"
        case .failed: "The update didn’t finish"
        case .unsupported: "Alevr can’t update itself here"
        }
    }

    /// "1.7.0 → 1.8.0" while a newer build is on its way, else this build.
    private var versionLine: some View {
        HStack(spacing: JunoSpace.tight) {
            if let offered = offeredVersion {
                Text(installed.version)
                JunoIconView(.chevronRight, size: 11)
                    .accessibilityHidden(true)
                Text(offered)
                    .foregroundStyle(Color.junoForeground)
            } else {
                Text("Version \(installed.displayVersion)")
            }
        }
        .junoType(.monoSmall)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            offeredVersion.map { "From version \(installed.version) to \($0)" }
                ?? "Version \(installed.displayVersion)"
        )
    }

    @ViewBuilder
    private var detail: some View {
        switch phase {
        case .idle:
            sentence("Alevr checks for a newer version every ten minutes while it is open.")
        case .checking:
            JunoShimmerText("Asking the update server", font: JunoType.ui.font())
                .padding(.top, JunoSpace.micro)
                .accessibilityLabel("Checking for updates")
        case .current(let checkedAt):
            sentence("This is the newest version. Checked \(checkedAt.formatted(date: .omitted, time: .shortened)).")
        case .downloading:
            sentence("Keep working. Alevr asks before it restarts.")
        case .ready:
            sentence("Downloaded and verified. Restarting takes a few seconds, and it installs on its own the next time you quit.")
        case .failed(let message):
            attention(message)
        case .unsupported(let reason):
            sentence(reason)
        }
    }

    private func sentence(_ text: String) -> some View {
        Text(text)
            .junoType(.ui)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, JunoSpace.micro)
    }

    /// An attention state: its colour and its glyph, as text. No container.
    private func attention(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: JunoSpace.tight) {
            JunoIconView(.warning, size: 13)
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .junoType(.ui)
        .foregroundStyle(Color.junoDestructiveInk)
        .padding(.top, JunoSpace.micro)
    }

    // MARK: Progress

    /// The system's bar, only while the download is measured. A server that
    /// sends no length gets the shimmer line instead: a bar that cannot move
    /// is a bar that looks stuck.
    @ViewBuilder
    private func progress(_ fraction: Double?) -> some View {
        if let fraction {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                ProgressView(value: min(1, max(0, fraction)))
                    .progressViewStyle(.linear)
                    .tint(Color.junoAccent)
                    .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion, tier: .tint), value: fraction)
                    .accessibilityLabel("Download progress")
                    .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
                HStack {
                    Text(Self.amount(fraction: fraction, size: downloadSize))
                        .contentTransition(.numericText())
                    Spacer(minLength: 0)
                    Text("\(Int((fraction * 100).rounded()))%")
                        .contentTransition(.numericText())
                }
                .junoType(.monoSmall)
                .monospacedDigit()
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityHidden(true)
            }
        } else {
            JunoShimmerText("Starting the download", font: JunoType.label.font())
        }
    }

    /// "48 MB of 112 MB" when the feed published a size, else "Downloading".
    static func amount(fraction: Double, size: Int?) -> String {
        guard let size, size > 0 else { return "Downloading" }
        let style = ByteCountFormatStyle(style: .file, allowedUnits: [.mb, .gb], spellsOutZero: false)
        let done = Int64((Double(size) * min(1, max(0, fraction))).rounded())
        return "\(done.formatted(style)) of \(Int64(size).formatted(style))"
    }

    // MARK: What's new

    private var showsNotes: Bool {
        switch phase {
        case .downloading, .ready: true
        default: false
        }
    }

    private func whatsNew(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            Text("What’s new")
                .junoType(JunoType.label.weight(.semibold))
                .foregroundStyle(Color.junoSecondaryInk)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                JunoMarkdownText(notes)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(JunoSpace.regular)
                    .textSelection(.enabled)
            }
            .frame(height: Self.notesHeight)
            .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(Color.junoBorder, lineWidth: 1)
            )
        }
    }

    // MARK: Buttons

    /// Release notes on the leading edge when the feed has none to show;
    /// the secondary action, then the one prominent action, trailing.
    private var footer: some View {
        HStack(spacing: JunoSpace.snug) {
            if showsNotes, notes == nil {
                Button(action: actions.openDownloads) {
                    HStack(spacing: JunoSpace.micro) {
                        Text("Release Notes")
                        JunoIconView(.external, size: 11)
                    }
                    .foregroundStyle(Color.junoAccentInk)
                    .frame(minWidth: 28, minHeight: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help("Opens the download page, where each release is described")
                .accessibilityIdentifier("juno.desktop.software-update.notes")
            }
            Spacer(minLength: 0)
            buttons
        }
        .junoType(.ui)
        .controlSize(.large)
    }

    @ViewBuilder
    private var buttons: some View {
        switch phase {
        case .idle:
            secondary("Done", closes: true, action: actions.close)
            primary("Check Now", action: actions.check)
        case .checking:
            secondary("Done", closes: true, action: actions.close)
        case .current:
            secondary("Check Again", action: actions.check)
            primary("Done", action: actions.close)
        case .downloading:
            secondary("Hide", closes: true, action: actions.close)
        case .ready:
            secondary("Later", closes: true, action: actions.close)
            primary("Restart to Update", action: actions.restart)
                .accessibilityIdentifier("juno.desktop.software-update.restart")
        case .failed:
            secondary("Download Page", action: actions.openDownloads)
            primary("Try Again", action: actions.check)
        case .unsupported:
            secondary("Done", closes: true, action: actions.close)
            primary("Download Page", action: actions.openDownloads)
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.junoProminent)
            .keyboardShortcut(.defaultAction)
            .frame(minWidth: 28, minHeight: 28)
            .contentShape(.rect)
    }

    /// The neutral outline button; `closes` makes it the window's Escape.
    @ViewBuilder
    private func secondary(_ title: String, closes: Bool = false, action: @escaping () -> Void) -> some View {
        let button = DesktopOutlineButton(title: title, action: action)
            .frame(minWidth: 28, minHeight: 28)
            .contentShape(.rect)
        if closes {
            button.keyboardShortcut(.cancelAction)
        } else {
            button
        }
    }
}

// MARK: - The app icon

/// The app's own icon as the Dock draws it, at a stated size. Read from
/// `NSApp` so a dev, next or stable build each shows the icon it ships.
struct DesktopAppIconImage: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: NSApp.applicationIconImage ?? NSImage())
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
