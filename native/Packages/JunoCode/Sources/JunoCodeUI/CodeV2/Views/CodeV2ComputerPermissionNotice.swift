import AppKit
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem
import SwiftUI

/// What a connected agent's refused computer-use call needs from the reader,
/// above the composer of its thread: the exact grant, the exact Settings
/// page, the fix for a switch that shows on but is stale, and a button that
/// opens the page.
///
/// macOS tells no one when a grant changes, so the notice re-reads both
/// grants every second while it is up (preflight only, never a prompt) and
/// turns into "ready" the moment Accessibility is given. No relaunch: AX trust
/// is read live. Screen Recording may still want one, and says so.
///
/// "Copy computer-use diagnostics" sits in the notice's context menu.
struct CodeV2ComputerPermissionNotice: View {
    let initial: ComputerUsePermissionStatus
    var probe: ComputerUsePermissionProbe = .system
    var pollInterval: Duration = .seconds(1)
    let dismiss: () -> Void

    @State private var status: ComputerUsePermissionStatus?

    private var current: ComputerUsePermissionStatus { status ?? initial }
    private var content: CodeV2ComputerPermissionNoticeContent { .init(status: current) }

    var body: some View {
        CodeV2TakeoverPanel(title: content.title, needsYou: false) {
            if let steps = content.steps {
                Text(steps)
                    .studioType(.small)
                    .foregroundStyle(Studio.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("alevr.code.computer-permission.steps")
            }
        } actions: {
            Spacer(minLength: 0)
            if let permission = content.openPermission {
                Button("Not now", action: dismiss)
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                    .accessibilityIdentifier("alevr.code.computer-permission.dismiss")
                Button("Open Settings") { NSWorkspace.shared.open(permission.privacySettingsURL) }
                    .buttonStyle(CodeV2InkButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .help("Opens \(permission.settingsPath())")
                    .contentShape(.rect)
                    .accessibilityLabel("Open \(permission.settingsPageName()) in System Settings")
                    .accessibilityIdentifier("alevr.code.computer-permission.open-settings")
            } else {
                Button("Done", action: dismiss)
                    .buttonStyle(CodeV2InkButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .contentShape(.rect)
                    .accessibilityIdentifier("alevr.code.computer-permission.done")
            }
        }
        .contextMenu {
            Button("Copy computer-use diagnostics") { CodeV2ComputerPermissionNotice.copyDiagnostics() }
        }
        .task {
            while !Task.isCancelled {
                status = probe.read()
                try? await Task.sleep(for: pollInterval)
            }
        }
    }

    /// Puts ``ComputerUseDiagnostics/report`` on the clipboard.
    @MainActor
    static func copyDiagnostics() {
        let report = ComputerUseDiagnostics.collect().report
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(report, forType: .string)
    }
}

/// The notice's words, from the grants alone, so every state is testable.
struct CodeV2ComputerPermissionNoticeContent: Equatable {
    let title: String
    let steps: String?
    /// The page the one button opens; nil once nothing is missing.
    let openPermission: ComputerUsePermission?

    init(status: ComputerUsePermissionStatus, macOSMajor: Int = ComputerUsePermission.currentMacOSMajor) {
        let missing = status.missing
        guard let first = missing.first else {
            title = "Computer use is ready. Ask the agent to try again."
            steps = nil
            openPermission = nil
            return
        }
        let names = missing.map(\.title)
        title = "Alevr needs \(names.count == 2 ? "\(names[0]) and \(names[1])" : names[0]) to use apps"
        var lines = ["Open Settings goes to \(first.settingsPath(macOSMajor: macOSMajor)). Turn Alevr on there."]
        if missing.count == 2 {
            lines.append("Then do the same in \(missing[1].settingsPath(macOSMajor: macOSMajor)).")
        }
        if missing.contains(.accessibility) {
            lines.append(ComputerUsePermissionStatus.staleGrantSteps)
        }
        lines.append(
            missing.contains(.screenRecording)
                ? "macOS may ask you to quit and reopen Alevr after allowing Screen Recording."
                : "This notice updates by itself once macOS allows it. Alevr does not need to reopen."
        )
        steps = lines.joined(separator: " ")
        openPermission = first
    }
}
