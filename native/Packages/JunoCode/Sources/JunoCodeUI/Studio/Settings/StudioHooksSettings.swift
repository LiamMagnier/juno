import SwiftUI
import JunoCodeCore
import JunoCodeLocal
import JunoDesignSystem

/// A project's hooks, by the event that runs them, and the one decision that
/// lets the repository's own hooks run at all.
///
/// Hooks are commands a repository asks to run around the agent's work, so
/// the page says plainly which file each came from and what it runs, and the
/// trust switch is the reader's alone: the repository cannot flip it, and an
/// added or edited entry waits here until it is allowed. Allowing is not the
/// last word, and the switch's subtitle says so: the script an entry runs can
/// change without the entry changing, so each run still asks wherever the
/// mode asks before a command.
struct StudioHooksSettings: View {
    let hooks: HookDiscoveryResult
    let policy: HookExecutionPolicy
    /// Allows or revokes the repository's hooks as they are now.
    let setAllowed: (Bool) -> Void

    @Bindable private var defaults = CodeDefaults.shared

    private var repositoryHooks: [HookDefinition] { hooks.repositoryHooks }

    /// Repository hooks added or edited since the reader allowed them.
    private var waiting: [HookDefinition] {
        repositoryHooks.filter { !policy.admits($0) }
    }

    private var events: [HookLifecycleEvent] {
        HookLifecycleEvent.allCases.filter { !hooks.hooks(for: $0).isEmpty }
    }

    var body: some View {
        Section {
            if let disabledBy = hooks.disabledBy {
                Text(hooks.disablesReaderHooks
                    ? "Every hook is off: \(disabledBy) sets disableAllHooks."
                    : "This project's hooks are off: \(disabledBy) sets disableAllHooks.")
                    .foregroundStyle(Studio.Ink.tertiary)
            } else if hooks.hooks.isEmpty {
                Text("No hooks. Add them under \"hooks\" in .claude/settings.json or .juno/settings.json.")
                    .foregroundStyle(Studio.Ink.tertiary)
            }
            if !repositoryHooks.isEmpty {
                Toggle(isOn: Binding(get: { policy.allowUntrustedHooks }, set: { setAllowed($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Run this project's hooks")
                        Text("They are commands from the repository. Juno runs them in the sandbox, and asks before each run wherever it would ask before a command.")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.tertiary)
                    }
                }
                .accessibilityIdentifier("juno.code.settings.hooks.trust")
                if policy.allowUntrustedHooks, !waiting.isEmpty {
                    HStack {
                        Text("\(StudioFormat.plural(waiting.count, "hook")) \(waiting.count == 1 ? "is" : "are") new or edited since you allowed the others")
                            .font(Studio.Font.meta)
                            .foregroundStyle(Studio.Ink.secondary)
                        Spacer()
                        Button("Allow") { setAllowed(true) }
                            .accessibilityIdentifier("juno.code.settings.hooks.allow-changes")
                    }
                }
            }
            ForEach(Array(hooks.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                Text("\(diagnostic.path): \(diagnostic.message)")
                    .font(Studio.Font.meta)
                    .foregroundStyle(diagnostic.severity == .error ? Studio.Ink.danger : Studio.Ink.tertiary)
            }
        } header: {
            Text("Hooks")
        } footer: {
            Text("Hooks in ~/.juno/settings.json are yours: they run in every project without asking, and no project can switch them off.")
        }

        ForEach(events, id: \.self) { event in
            Section {
                ForEach(hooks.hooks(for: event)) { hook in
                    StudioHookSettingsRow(
                        hook: hook,
                        allowed: policy.admits(hook),
                        lastRun: defaults.hookLastRun[hook.id],
                        enabled: Binding(
                            get: { defaults.isHookEnabled(hook.id) },
                            set: { defaults.setHook(hook.id, enabled: $0) }
                        )
                    )
                }
            } header: {
                HStack(alignment: .firstTextBaseline) {
                    Text(Self.title(event))
                    Spacer()
                    Text(event.rawValue)
                        .font(Studio.Font.monoSmall)
                        .foregroundStyle(Studio.Ink.tertiary)
                }
            }
        }
    }

    /// When the event runs, in the reader's words.
    static func title(_ event: HookLifecycleEvent) -> String {
        switch event {
        case .preToolUse: "Before a tool runs"
        case .postToolUse: "After a tool runs"
        case .userPromptSubmit: "When you send a message"
        case .stop: "When Juno finishes"
        case .subagentStop: "When a sub-agent finishes"
        case .sessionStart: "When a session starts"
        case .sessionEnd: "When a session ends"
        case .notification: "When Juno needs you"
        }
    }
}

/// One hook: the command it runs, what it matches, where it was declared,
/// and whether it is allowed to run.
struct StudioHookSettingsRow: View {
    let hook: HookDefinition
    let allowed: Bool
    let lastRun: Date?
    @Binding var enabled: Bool

    /// What the matcher selects. Events without a matcher say nothing.
    private var scope: String? {
        switch hook.event {
        case .preToolUse, .postToolUse:
            hook.matcher.pattern ?? "Every tool"
        case .sessionStart, .sessionEnd, .notification:
            hook.matcher.pattern
        case .userPromptSubmit, .stop, .subagentStop:
            nil
        }
    }

    private var status: String {
        if !allowed { return "Not allowed yet" }
        guard let lastRun else { return "Has not run" }
        let age = StudioFormat.age(lastRun)
        if age == "now" { return "Ran just now" }
        return Date().timeIntervalSince(lastRun) < 7 * 86_400 ? "Ran \(age) ago" : "Ran \(age)"
    }

    var body: some View {
        Toggle(isOn: $enabled) {
            VStack(alignment: .leading, spacing: 2) {
                Text(hook.command)
                    .font(Studio.Font.mono)
                    .foregroundStyle(Studio.Ink.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(hook.command)
                Text(([scope, hook.path, status] as [String?]).compactMap { $0 }.joined(separator: " · "))
                    .font(Studio.Font.meta)
                    .foregroundStyle(Studio.Ink.tertiary)
                    .lineLimit(1)
            }
        }
        // The switch is the reader's per-hook preference; a hook that is not
        // allowed cannot run whatever it says, so it is shown but not offered.
        .disabled(!allowed)
        .accessibilityIdentifier("juno.code.settings.hook.\(hook.id.suffix(12))")
    }
}
