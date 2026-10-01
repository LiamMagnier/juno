import Foundation
import JunoCodeCore
import JunoCodeLocal

/// "Start a Juno Code task" from Shortcuts or the Mac's automation
/// (CODE_AGENT_SPEC §5.18 a, D-025): a project, a prompt, an optional goal and
/// a mode. It opens an ordinary session and sends the prompt; every approval
/// still goes to the reader, in the app. The headless `juno-code exec` waits.
///
/// An automation runs with no one watching, so the mode it asks for is capped
/// by the reader's remote ceiling — the same limit a task started from the
/// phone gets (Settings › Permissions › Remote). Asking for more never gets
/// more.
public struct CodeTaskIntentRequest: Equatable, Sendable {
    public enum Mode: String, CaseIterable, Sendable {
        case plan
        case askBeforeEdits
        case autoEdit
        case fullAccess

        var studioMode: StudioMode {
            switch self {
            case .plan: .plan
            case .askBeforeEdits: .askBeforeEdits
            case .autoEdit: .autoEdit
            case .fullAccess: .fullAccess
            }
        }
    }

    public let projectName: String?
    public let prompt: String
    public let goal: String?
    public let mode: Mode

    public init(projectName: String?, prompt: String, goal: String? = nil, mode: Mode = .askBeforeEdits) {
        self.projectName = projectName?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedGoal = goal?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.goal = trimmedGoal?.isEmpty == false ? trimmedGoal : nil
        self.mode = mode
    }

    /// The mode the session starts in: what was asked, no higher than
    /// `ceiling`. Plan stays plan.
    public func effectiveMode(ceiling: PermissionMode) -> StudioMode {
        let asked = mode.studioMode
        guard asked.behavior == .code else { return asked }
        return StudioMode(behavior: .code, permission: asked.permission.capped(at: ceiling))
    }

    /// The project the request names: an exact display name, ignoring case,
    /// then a unique prefix. Nil with no name and more than one project.
    public func project(in records: [WorkspaceRecord]) -> WorkspaceRecord? {
        guard let name = projectName?.lowercased(), !name.isEmpty else {
            return records.count == 1 ? records.first : nil
        }
        if let exact = records.first(where: { $0.descriptor.displayName.lowercased() == name }) {
            return exact
        }
        let prefixed = records.filter { $0.descriptor.displayName.lowercased().hasPrefix(name) }
        return prefixed.count == 1 ? prefixed.first : nil
    }

    /// Why the request cannot start, in words, or nil.
    public func problem(in records: [WorkspaceRecord]) -> String? {
        guard !prompt.isEmpty || goal != nil else { return "Say what Juno should do." }
        guard project(in: records) != nil else {
            if records.isEmpty { return "Add a project to Juno Code first." }
            if let projectName, !projectName.isEmpty { return "No project is called \(projectName)." }
            return "Name the project: Juno Code has more than one."
        }
        return nil
    }
}

public enum CodeTaskIntentError: LocalizedError, Equatable {
    case cannotStart(String)

    public var errorDescription: String? {
        switch self {
        case let .cannotStart(reason): reason
        }
    }
}

public extension WorkbenchModel {
    /// Starts a task an App Intent asked for: a new session in the named
    /// project, in a mode capped by the remote ceiling, with the prompt sent
    /// and, when given, a goal set first. Returns the session.
    func startIntentTask(_ request: CodeTaskIntentRequest) async throws -> CodeSessionID {
        if let problem = request.problem(in: workspaces) {
            throw CodeTaskIntentError.cannotStart(problem)
        }
        guard let record = request.project(in: workspaces) else {
            throw CodeTaskIntentError.cannotStart("Name the project.")
        }
        let root = record.descriptor.localPathHint.isEmpty
            ? nil
            : URL(fileURLWithPath: record.descriptor.localPathHint, isDirectory: true)
        let ceiling = CodeSettingsStore().resolved(projectRoot: root).remoteCeiling
        let mode = request.effectiveMode(ceiling: ceiling)
        var configuration = CodeDefaults.shared.configuration(behavior: mode.behavior, availableModels: availableModels)
        configuration.permissionMode = mode.behavior == .code ? mode.permission : .askBeforeChanges
        guard let session = await createSession(workspaceID: record.id, configuration: configuration) else {
            throw CodeTaskIntentError.cannotStart("Juno Code could not open \(record.descriptor.displayName).")
        }
        let first = request.prompt.isEmpty ? (request.goal ?? "") : request.prompt
        let title = first.split(separator: "\n").first.map(String.init) ?? first
        await renameSession(id: session.id, title: title.count > 60 ? String(title.prefix(60)) + "…" : title)
        guard let controller = await controller(for: session.id) else { return session.id }
        if let goal = request.goal {
            // The goal is set as `/goal` sets it; its first turn carries the
            // objective, and the prompt follows as the next message.
            await controller.commands.perform(.goal(.set(goal)), host: controller)
            if !request.prompt.isEmpty {
                // Queued behind the goal's first turn, never steered into it.
                _ = try? await controller.deliverRemotePrompt(request.prompt, as: .queue)
            }
        } else {
            _ = await controller.commandSend(request.prompt, behavior: nil)
        }
        return session.id
    }
}
