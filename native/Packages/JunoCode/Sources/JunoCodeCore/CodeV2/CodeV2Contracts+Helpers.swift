import Foundation

// MARK: - Small helpers every lane reads

public extension CodeV2 {
    /// The kind an instance id names (`alevr`, `byok:<lab>`, `claude-agent:<n>`,
    /// `codex:<n>`, `acp:<n>`), or nil. Mirrors `instanceKindOf` in contracts.ts.
    static func instanceKind(of instanceId: String) -> ProviderKind? {
        if instanceId == "alevr" { return .alevr }
        guard let colon = instanceId.firstIndex(of: ":"),
              colon != instanceId.startIndex,
              instanceId.index(after: colon) != instanceId.endIndex
        else { return nil }
        let kind = String(instanceId[..<colon])
        let rest = String(instanceId[instanceId.index(after: colon)...])
        if kind == "byok" { return ByokProvider(rawValue: rest) == nil ? nil : .byok }
        switch kind {
        case "claude-agent": return .claudeAgent
        case "codex": return .codex
        case "acp": return .acp
        default: return nil
        }
    }

    /// The vendor runtime runs on this Mac (SPEC §2): the env server owns it.
    static func runsOnEnvServer(_ kind: ProviderKind) -> Bool {
        kind == .claudeAgent || kind == .codex || kind == .acp
    }
}
