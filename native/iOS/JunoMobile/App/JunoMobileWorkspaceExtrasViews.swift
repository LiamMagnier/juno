import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Scheduled tasks, on the website's own `/api/tasks`.
///
/// A task is a schedule, so the row leads with when it next runs — that is the
/// question you open this screen to answer. A run that failed is surfaced on the
/// row rather than hidden a level down: a schedule quietly failing every night
/// is the failure mode that matters, and it is invisible if you only show the
/// next run time.
struct JunoMobileTasksView: View {
    @Bindable var model: NativeWorkspaceExtrasModel

    var body: some View {
        Group {
            switch model.tasksPhase {
            case .idle, .loading where model.tasks.isEmpty:
                ProgressView("tasks.loading")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .offline where model.tasks.isEmpty:
                JunoMobileRemoteUnavailable(
                    title: "tasks.offline.title", message: "tasks.offline.description",
                    symbol: "wifi.slash", retry: { Task { await model.loadTasks() } }
                )
            case .failed where model.tasks.isEmpty:
                JunoMobileRemoteUnavailable(
                    title: "tasks.failed.title",
                    message: model.lastErrorDescription.map { LocalizedStringKey($0) }
                        ?? "tasks.failed.description",
                    symbol: "exclamationmark.triangle", retry: nil
                )
            default:
                if model.tasks.isEmpty {
                    ContentUnavailableView {
                        Label("tasks.empty.title", systemImage: "calendar.badge.clock")
                    } description: {
                        Text("tasks.empty.description")
                    }
                } else {
                    list
                }
            }
        }
        .navigationTitle("navigation.tasks")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadTasks() }
        .refreshable { await model.loadTasks() }
        .accessibilityIdentifier("juno.mobile.tasks")
    }

    private var list: some View {
        List(model.tasks) { task in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: JunoSpace.snug) {
                    Text(task.name)
                        .font(.system(size: 16, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Toggle(
                        "",
                        isOn: Binding(
                            get: { task.enabled },
                            set: { on in Task { await model.setTaskEnabled(on, id: task.id) } }
                        )
                    )
                    .labelsHidden()
                    .disabled(model.isMutating)
                    .accessibilityLabel(
                        task.enabled ? "tasks.pause" : "tasks.resume"
                    )
                }

                Text(schedule(task))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let run = task.latestRun, run.failed {
                    Label(
                        run.error ?? String(localized: "tasks.run.failed"),
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(Color.junoDanger)
                    .lineLimit(2)
                }
            }
            .padding(.vertical, 2)
            .opacity(task.enabled ? 1 : 0.55)
        }
    }

    /// "Every weekday at 09:00 · next Tuesday" — cadence, time, then when it
    /// actually fires next, formatted in the *task's* timezone rather than the
    /// phone's, because that is the schedule the server will honour.
    private func schedule(_ task: NativeScheduledTask) -> String {
        var formatter = DateComponents()
        formatter.hour = task.hour
        formatter.minute = task.minute
        let time = String(format: "%02d:%02d", task.hour, task.minute)
        let cadence: String
        switch task.cadence {
        case .daily: cadence = String(localized: "tasks.cadence.daily")
        case .weekdays: cadence = String(localized: "tasks.cadence.weekdays")
        case .weekly: cadence = String(localized: "tasks.cadence.weekly")
        case .monthly: cadence = String(localized: "tasks.cadence.monthly")
        }
        let next = task.nextRunAt.formatted(.relative(presentation: .named))
        return "\(cadence) \(time) · \(task.modelName) · \(next)"
    }
}

/// Connections, on the website's own `/api/connectors`.
///
/// Linking is deliberately absent: it is an OAuth consent flow that belongs in a
/// browser, and offering a Connect button that cannot finish would be exactly
/// the fake control the brief forbids. Disconnecting *is* here, because it is a
/// single authenticated call the phone can genuinely complete.
struct JunoMobileConnectionsView: View {
    @Bindable var model: NativeWorkspaceExtrasModel
    @State private var disconnectTarget: NativeConnector?

    var body: some View {
        Group {
            switch model.connectorsPhase {
            case .idle, .loading where model.connectors.isEmpty:
                ProgressView("connections.loading")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .offline where model.connectors.isEmpty:
                JunoMobileRemoteUnavailable(
                    title: "connections.offline.title",
                    message: "connections.offline.description",
                    symbol: "wifi.slash", retry: { Task { await model.loadConnectors() } }
                )
            case .failed where model.connectors.isEmpty:
                JunoMobileRemoteUnavailable(
                    title: "connections.failed.title",
                    message: model.lastErrorDescription.map { LocalizedStringKey($0) }
                        ?? "connections.failed.description",
                    symbol: "exclamationmark.triangle", retry: nil
                )
            default:
                list
            }
        }
        .navigationTitle("navigation.connections")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadConnectors() }
        .refreshable { await model.loadConnectors() }
        .confirmationDialog(
            "connections.disconnect.confirm",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("connections.disconnect", role: .destructive) {
                if let target = disconnectTarget {
                    Task { await model.disconnect(id: target.id) }
                }
                disconnectTarget = nil
            }
            Button("common.cancel", role: .cancel) { disconnectTarget = nil }
        }
        .accessibilityIdentifier("juno.mobile.connections")
    }

    private var list: some View {
        List {
            Section {
                ForEach(model.connectors.filter(\.connected)) { connector in
                    row(connector)
                }
                if model.connectors.allSatisfy({ !$0.connected }) {
                    Text("connections.none.connected")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("connections.connected.title")
            }

            Section {
                ForEach(model.connectors.filter { !$0.connected }) { connector in
                    row(connector)
                }
            } header: {
                Text("connections.available.title")
            } footer: {
                // Says where linking happens rather than offering a button that
                // cannot finish a consent screen.
                Text("connections.link.footer")
            }
        }
    }

    private func row(_ connector: NativeConnector) -> some View {
        HStack(spacing: JunoSpace.cozy) {
            JunoIconView(.connections, size: 18)
                .foregroundStyle(connector.connected ? Color.junoAccent : .secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(connector.label)
                    .font(.system(size: 16, weight: .medium))
                    .lineLimit(1)
                Text(subtitle(connector))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            if connector.connected {
                Button("connections.disconnect") { disconnectTarget = connector }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(model.isMutating)
            }
        }
        .padding(.vertical, 2)
    }

    /// Unconfigured and not-connected are different things and say so: one you
    /// can fix by linking, the other nobody on this deployment can.
    private func subtitle(_ connector: NativeConnector) -> String {
        if connector.connected {
            return connector.accountLabel ?? String(localized: "connections.status.connected")
        }
        if !connector.configured {
            return String(localized: "connections.status.unavailable")
        }
        return connector.capability
    }
}

/// The shared offline / refused screen for the remote-backed destinations, so
/// Tasks, Connections and Code cannot drift into three different answers for
/// "Juno is unreachable".
struct JunoMobileRemoteUnavailable: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let symbol: String
    let retry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            if let retry {
                Button("code.retry", action: retry)
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}
