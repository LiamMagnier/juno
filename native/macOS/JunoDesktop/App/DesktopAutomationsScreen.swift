import JunoCore
import JunoDesignSystem
import JunoWorkKit
import SwiftUI

/// **Automations** — everything that starts without the reader typing a
/// fresh prompt (the web's `/automations`, Phase 4 C1).
///
/// A wide page: the header with New automation, then the automations split
/// into Active and Paused so a paused row's next fire never reads as about to
/// happen. A row opens the automation's page, pushed on this destination's
/// stack; its More menu (and its context menu, the same definition) holds Run
/// Now, Pause or Resume, Its Task and Delete….
///
/// Ported from the Work window's two-pane `DesktopWorkAutomationsView`, over
/// the same ``NativeWorkAutomationModel``; the editor moved to pages
/// (``DesktopAutomationPage``), as the web's are (register #66).
struct DesktopAutomationsScreen: View {
    let model: NativeWorkAutomationModel
    /// The conversation a Work session writes into, when this Mac knows it:
    /// "Its Task" is offered only then.
    var conversationForSession: (String) -> String? = { _ in nil }
    var openConversation: (String) -> Void = { _ in }

    @Environment(\.desktopPush) private var push
    @Environment(\.junoToast) private var toast
    @State private var confirmation: JunoConfirmation?
    @State private var busyIDs: Set<String> = []

    private var active: [NativeWorkSchedule] { model.schedules.filter(\.enabled) }
    private var paused: [NativeWorkSchedule] { model.schedules.filter { !$0.enabled } }

    private var isLoading: Bool {
        model.schedules.isEmpty && (model.phase == .idle || model.phase == .loading)
    }

    private var didFail: Bool {
        model.schedules.isEmpty && (model.phase == .failed || model.phase == .offline)
    }

    var body: some View {
        JunoPage(measure: .wide) {
            JunoPageHeader(
                "Routines",
                lede: "Tasks that start themselves, on a schedule or when something changes."
            ) {
                // Withheld while the page is loading, failed or empty: the
                // empty state carries it then, as the web's does.
                if !model.schedules.isEmpty {
                    newAutomationButton
                }
            }
        } content: {
            content
        }
        .junoConfirmation($confirmation)
        // A background read that failed while rows are showing is a standing
        // condition: said once, taken down when a later read succeeds.
        .junoToastStatus(
            id: "automations.refresh",
            model.schedules.isEmpty ? nil : model.lastErrorDescription
        ) { _ in
            .warning("Couldn’t refresh your automations. These are the last ones Alevr read.")
        }
        .task { await model.refresh() }
        .accessibilityIdentifier("juno.desktop.automations")
    }

    private var newAutomationButton: some View {
        Button {
            push(.newAutomation)
        } label: {
            Label("New automation", icon: .plus)
        }
        .buttonStyle(.junoProminent)
        .contentShape(.rect)
        .help("Set up a new automation")
        .accessibilityIdentifier("juno.desktop.automations.new")
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            DesktopWorkSkeletonRows(count: 3)
        } else if didFail {
            JunoEmptyState(
                title: "Couldn’t load your automations",
                message: "Existing automations keep their server-side state; this page is empty because the read failed, not because they were removed.",
                icon: .error,
                actionLabel: "Try again",
                action: { Task { await model.refresh() } },
                tone: .error
            )
        } else if model.schedules.isEmpty {
            JunoEmptyState(
                title: "No automations yet",
                message: "Run a task every weekday at eight, when an invoice arrives, before a meeting, when a topic starts moving, or when a granted folder changes. Alevr can work while you are elsewhere and stops for approvals when the policy requires it.",
                icon: .automations
            ) {
                // The page's one prominent action, while the header's copy of
                // it is withheld.
                newAutomationButton
            }
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.region) {
                if !active.isEmpty {
                    section(paused.isEmpty ? nil : "Active", active)
                }
                if !paused.isEmpty {
                    section(active.isEmpty ? nil : "Paused", paused)
                }
            }
        }
    }

    private func section(_ title: String?, _ schedules: [NativeWorkSchedule]) -> some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            if let title {
                DesktopWorkSectionHeading(title)
            }
            DesktopWorkRowList(items: schedules) { schedule, _ in
                DesktopAutomationRow(
                    schedule: schedule,
                    isBusy: busyIDs.contains(schedule.id),
                    open: { push(.automation(schedule.id)) }
                ) {
                    actions(for: schedule)
                }
            }
        }
    }

    // MARK: Actions — one definition, for the More button and the context menu

    @ViewBuilder
    private func actions(for schedule: NativeWorkSchedule) -> some View {
        Button("Run Now") { runNow(schedule) }
            .disabled(busyIDs.contains(schedule.id))
        Button(schedule.enabled ? "Pause" : "Resume") { toggle(schedule) }
            .disabled(busyIDs.contains(schedule.id))
        if !schedule.isCode, let conversationID = conversationForSession(schedule.sessionID) {
            Button("Its Task") { openConversation(conversationID) }
        }
        Divider()
        Button("Delete…", role: .destructive) { confirmDelete(schedule) }
    }

    private func runNow(_ schedule: NativeWorkSchedule) {
        busyIDs.insert(schedule.id)
        Task {
            let result = await model.runNowReporting(id: schedule.id)
            busyIDs.remove(schedule.id)
            switch result {
            case .done:
                toast(.success("Started. This run is extra, and the schedule still fires when it was going to."))
                await model.refresh()
            case .refused(let sentence):
                toast(.error(sentence))
            case .failed:
                toast(.error("Couldn’t start this. Nothing was queued, so trying again is safe."))
            }
        }
    }

    private func toggle(_ schedule: NativeWorkSchedule) {
        busyIDs.insert(schedule.id)
        let pausing = schedule.enabled
        Task {
            let result = await model.setEnabledReporting(id: schedule.id, enabled: !pausing)
            busyIDs.remove(schedule.id)
            toast(DesktopAutomationToasts.toggled(result, pausing: pausing))
        }
    }

    private func confirmDelete(_ schedule: NativeWorkSchedule) {
        confirmation = DesktopAutomationToasts.deleteConfirmation(for: schedule) {
            Task {
                let result = await model.deleteReporting(id: schedule.id)
                toast(DesktopAutomationToasts.deleted(result))
            }
        }
    }
}

/// The web's sentences for the changes both automation pages make.
enum DesktopAutomationToasts {
    static func toggled(_ result: NativeWorkAutomationResult<NativeWorkSchedule>, pausing: Bool) -> JunoToast {
        switch result {
        case .done(_, let notes):
            if !notes.isEmpty { return .success(notes.joined(separator: " ")) }
            return .success(pausing ? "Paused. Nothing new will start." : "Resumed.")
        case .refused(let sentence):
            return .error(sentence)
        case .failed:
            return .error("Couldn’t change this schedule. It is exactly as it was.")
        }
    }

    static func deleted(_ result: NativeWorkAutomationResult<String?>) -> JunoToast {
        switch result {
        case .done(let note, _):
            return .success(note ?? "Deleted.")
        case .refused(let sentence):
            return .error(sentence)
        case .failed:
            return .error("Couldn’t delete this automation. It is exactly as it was.")
        }
    }

    static func deleteConfirmation(
        for schedule: NativeWorkSchedule,
        confirm: @escaping @MainActor () -> Void
    ) -> JunoConfirmation {
        JunoConfirmation(
            title: "Delete “\(schedule.name)”?",
            message: "Fires that have not started are cancelled. A run already under way carries on to the end: deleting a schedule stops it starting anything new, and cannot reach into work that has begun. The tasks it has already produced stay where they are.",
            confirmTitle: "Delete",
            confirm: confirm
        )
    }
}

/// One automation in the list: its name (and "Paused" in words when paused),
/// what starts it, and a meta line — when it fires next, when it last ran,
/// and what it will email.
struct DesktopAutomationRow<Actions: View>: View {
    let schedule: NativeWorkSchedule
    let isBusy: Bool
    let open: () -> Void
    @ViewBuilder let actions: () -> Actions

    @State private var isHovering = false

    private var triggers: String {
        schedule.triggers.map(NativeWorkScheduleCopy.describe).joined(separator: " · ")
    }

    private var meta: String {
        var parts = [NativeWorkScheduleCopy.nextFireSentence(schedule)]
        if let lastRun = schedule.lastRunAt {
            parts.append("last ran \(NativeWorkScheduleCopy.timeAgo(lastRun))")
        }
        // Nothing emails about a Code run, so its row does not claim it will.
        if !schedule.isCode, let notify = NativeWorkScheduleCopy.notifySentence(schedule.notifyPolicy) {
            parts.append(notify)
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            Button(action: open) {
                HStack(alignment: .center, spacing: JunoSpace.cozy) {
                    VStack(alignment: .leading, spacing: JunoSpace.hairline) {
                        HStack(spacing: JunoSpace.snug) {
                            Text(schedule.name)
                                .junoType(JunoType.ui.weight(.medium))
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                            if !schedule.enabled {
                                DesktopWorkTag("Paused")
                            }
                            if let repository = schedule.codeRepository {
                                DesktopWorkTag(repository)
                            }
                        }
                        if !triggers.isEmpty {
                            Text(triggers)
                                .junoType(.ui)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(1)
                        }
                        Text(meta)
                            .junoType(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, JunoSpace.micro)
                    }
                    .opacity(schedule.enabled ? 1 : 0.75)
                    Spacer(minLength: JunoSpace.snug)
                    if isBusy {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Working")
                    }
                    JunoIconView(.chevronRight, size: 14)
                        .foregroundStyle(Color.junoMutedForeground)
                        .accessibilityHidden(true)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: "\(schedule.name). \(schedule.enabled ? "" : "Paused. ")\(triggers). \(meta)"))
            .accessibilityHint("Opens the automation")

            DesktopWorkMoreButton(label: "More for \(schedule.name)", isVisible: isHovering || isBusy) {
                actions()
            }
        }
        .padding(.leading, JunoSpace.comfy)
        .padding(.trailing, JunoSpace.snug)
        .padding(.vertical, JunoSpace.cozy)
        .modifier(DesktopWorkRowSurface(isHovering: isHovering))
        .onHover { isHovering = $0 }
        .contextMenu { actions() }
        .accessibilityIdentifier("juno.desktop.automation.\(schedule.id)")
    }
}
