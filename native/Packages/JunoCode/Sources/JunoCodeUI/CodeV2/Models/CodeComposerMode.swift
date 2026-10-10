import Foundation
import JunoCodeCore
import JunoDesignSystem

/// The composer's mode: one control for how much the agent may do on its own,
/// mirroring `src/lib/code-v2/composer-mode.ts` so the Mac and the web say the
/// same five things: Ask, Accept edits, Auto, Plan, Full access.
///
/// The contract keeps two settings per turn, a runtime mode and an
/// interaction mode (plan first or not). This maps the ladder onto that pair,
/// both ways. Plan keeps the runtime mode it had, so the run that follows an
/// approved plan builds with the mode it had before. Read only is not offered
/// (Plan covers it), but a thread already on it still says so.
public enum CodeComposerMode: String, CaseIterable, Sendable, Identifiable {
    case ask
    case acceptEdits = "accept-edits"
    case auto
    case plan
    case full
    case readOnly = "read-only"

    public var id: String { rawValue }

    /// The five the menu offers, in the web's order.
    public static let ladder: [CodeComposerMode] = [.ask, .acceptEdits, .auto, .plan, .full]

    public var title: String {
        switch self {
        case .ask: "Ask"
        case .acceptEdits: "Accept edits"
        case .auto: "Auto"
        case .plan: "Plan"
        case .full: "Full access"
        case .readOnly: "Read only"
        }
    }

    /// One line, under the title in the menu. The web's words exactly.
    public var detail: String {
        switch self {
        case .ask: "Asks before every edit and command."
        case .acceptEdits: "Edits files without asking. Asks before commands."
        case .auto: "A reviewer model approves routine steps. Asks for the rest."
        case .plan: "Reads and writes a plan. Changes nothing until you approve."
        case .full: "Never asks inside the project. Still asks for sudo, other machines and anything outside the folder."
        case .readOnly: "Reads the project. Changes nothing."
        }
    }

    /// The web icon set's glyph for the rung.
    public var icon: JunoIcon {
        switch self {
        case .ask: .hand
        case .acceptEdits: .pencil
        case .auto: .shield
        case .plan: .listChecks
        case .full: .lockOpen
        case .readOnly: .eye
        }
    }

    /// The rung a thread's two settings add up to.
    public init(runtime: CodeV2.RuntimeMode, interaction: CodeV2.InteractionMode) {
        if interaction == .plan {
            self = .plan
            return
        }
        switch runtime {
        case .ask: self = .ask
        case .autoEdit: self = .acceptEdits
        case .auto: self = .auto
        case .full: self = .full
        case .readOnly: self = .readOnly
        }
    }

    /// The pair this rung sets. Plan keeps `current` unless it is read-only.
    public func applied(to current: CodeV2.RuntimeMode) -> (runtime: CodeV2.RuntimeMode, interaction: CodeV2.InteractionMode) {
        switch self {
        case .plan: (current == .readOnly ? .autoEdit : current, .plan)
        case .ask: (.ask, .default)
        case .acceptEdits: (.autoEdit, .default)
        case .auto: (.auto, .default)
        case .full: (.full, .default)
        case .readOnly: (.readOnly, .default)
        }
    }

    /// The rungs an instance can honour. `approvals` is the runtime modes it
    /// can enforce (empty means all); `planMode` whether it can plan first.
    public static func available(approvals: [CodeV2.RuntimeMode], planMode: Bool = true) -> [CodeComposerMode] {
        ladder.filter { mode in
            if mode == .plan { return planMode }
            return approvals.isEmpty || approvals.contains(mode.applied(to: .autoEdit).runtime)
        }
    }

    /// ⇧⌘A: the next rung the instance offers, wrapping.
    public func cycled(approvals: [CodeV2.RuntimeMode], planMode: Bool = true) -> CodeComposerMode {
        let list = Self.available(approvals: approvals, planMode: planMode)
        guard !list.isEmpty else { return self }
        let index = list.firstIndex(of: self) ?? -1
        return list[(index + 1) % list.count]
    }
}

/// Remembers the mode per thread, with the project's last choice as the
/// default for its next thread, the web's `alevr.code.prefs.*` and
/// `alevr.code.mode.project.*` on the Mac.
public struct CodeComposerModeMemory: Sendable {
    public struct Pair: Codable, Equatable, Sendable {
        public var runtimeMode: CodeV2.RuntimeMode
        public var interactionMode: CodeV2.InteractionMode

        public init(runtimeMode: CodeV2.RuntimeMode, interactionMode: CodeV2.InteractionMode) {
            self.runtimeMode = runtimeMode
            self.interactionMode = interactionMode
        }
    }

    private let suiteName: String?

    /// `suiteName` nil is the app's standard defaults; tests pass their own.
    public init(suiteName: String? = nil) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    static func sessionKey(_ id: String) -> String { "alevr.code.mode.session.\(id)" }
    static func projectKey(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : "alevr.code.mode.project.\(trimmed)"
    }

    /// The thread's own choice, else the project's last, else nil.
    public func pair(session: String?, project: String?) -> Pair? {
        if let session, let own = read(Self.sessionKey(session)) { return own }
        if let key = project.flatMap(Self.projectKey) { return read(key) }
        return nil
    }

    /// A choice in a thread: kept for the thread and as the project's default.
    public func remember(_ pair: Pair, session: String?, project: String?) {
        if let session { write(pair, Self.sessionKey(session)) }
        if let key = project.flatMap(Self.projectKey) { write(pair, key) }
    }

    private func read(_ key: String) -> Pair? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Pair.self, from: $0) }
    }

    private func write(_ pair: Pair, _ key: String) {
        if let data = try? JSONEncoder().encode(pair) { defaults.set(data, forKey: key) }
    }
}

public extension CodeV2ComposerModel {
    /// The ladder rung the composer's pair adds up to.
    var composerMode: CodeComposerMode {
        get { CodeComposerMode(runtime: runtimeMode, interaction: interactionMode) }
        set {
            let pair = newValue.applied(to: runtimeMode)
            runtimeMode = pair.runtime
            interactionMode = pair.interaction
        }
    }

    var modePair: CodeComposerModeMemory.Pair {
        CodeComposerModeMemory.Pair(runtimeMode: runtimeMode, interactionMode: interactionMode)
    }

    /// Puts a remembered pair on the composer.
    func adopt(_ pair: CodeComposerModeMemory.Pair) {
        runtimeMode = pair.runtimeMode
        interactionMode = pair.interactionMode
    }

    /// ⇧⌘A on the ladder.
    func cycleComposerMode(approvals: [CodeV2.RuntimeMode], planMode: Bool) {
        composerMode = composerMode.cycled(approvals: approvals, planMode: planMode)
    }
}
