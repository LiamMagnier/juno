import Foundation
import JunoCodeCore

/// One model's thinking capabilities, as the account's model manifest
/// publishes them (`src/lib/native-model-manifest.ts`: `reasoning.supported`,
/// `reasoning.canDisable`, `reasoning.onOffOnly`, `reasoning.defaultEffort`,
/// `supportedReasoningEfforts`) — which is the website's `reasoningCaps`.
///
/// Code posts provider-native bodies through a transparent proxy, so nothing
/// server-side clamps a depth or picks an off spelling for it. Two decisions on
/// the wire need these per-model answers rather than a guess from the id:
/// which Instant off-state a model accepts (`CodeThinkingWire.chatParameters`)
/// and whether a stored depth is one the model takes at all (``clamp(_:)``).
public struct CodeReasoningCaps: Equatable, Sendable {
    /// `model.reasoning`: whether the model reasons at all.
    public let supported: Bool
    /// Whether thinking can be switched off (the website's "Instant").
    public let canDisable: Bool
    /// A bare on/off switch with no depths; "on" is sent as `high`.
    public let onOffOnly: Bool
    /// The depths the model accepts, shallowest first.
    public let tiers: [ReasoningEffort]
    /// The model's own default depth, or nil when it publishes none (an
    /// Instant-capable model defaults to Instant).
    public let defaultEffort: ReasoningEffort?

    public init(
        supported: Bool,
        canDisable: Bool,
        onOffOnly: Bool = false,
        tiers: [ReasoningEffort] = [],
        defaultEffort: ReasoningEffort? = nil
    ) {
        self.supported = supported
        self.canDisable = canDisable
        self.onOffOnly = onOffOnly
        self.tiers = tiers.sorted {
            (ReasoningEffort.allCases.firstIndex(of: $0) ?? 0) < (ReasoningEffort.allCases.firstIndex(of: $1) ?? 0)
        }
        self.defaultEffort = defaultEffort.flatMap { tiers.contains($0) ? $0 : nil }
    }

    /// The depth to actually send for `requested`, or nil for none.
    ///
    /// Mirrors `clampReasoningEffort` in `src/lib/model-metrics.ts`: a value
    /// stored for a different model (GPT's `minimal` carried over to Claude
    /// Haiku 5.5, say) is reset to this model's declared default rather than
    /// sent as-is, which is a 400 on most providers.
    public func clamp(_ requested: ReasoningEffort?) -> ReasoningEffort? {
        guard supported else { return nil }
        if onOffOnly { return requested == nil ? nil : .high }
        // Always on with no exposed control: send nothing.
        if tiers.isEmpty { return nil }
        guard let requested else { return canDisable ? nil : defaultEffort }
        if tiers.contains(requested) { return requested }
        return defaultEffort
    }
}

/// The account's per-model ``CodeReasoningCaps``, keyed by canonical model id
/// (`provider:model`), filled from the signed-in manifest by whoever owns the
/// catalog (`WorkbenchModel`) and read by ``BackendCodeModelClient`` when it
/// builds a request.
///
/// Process-wide on purpose, like the generation-model catalogue: the Work host
/// and every Code session build their bodies through the same client type, and
/// threading the manifest through each of their call sites would only give each
/// one a chance to forget it. An id with no entry gets the conservative
/// behaviour documented on `CodeThinkingWire.chatParameters`.
public final class CodeReasoningCapsRegistry: @unchecked Sendable {
    public static let shared = CodeReasoningCapsRegistry()

    private let lock = NSLock()
    private var entries: [String: CodeReasoningCaps] = [:]

    public init() {}

    /// Replaces every entry with the latest manifest's.
    public func replace(_ caps: [String: CodeReasoningCaps]) {
        lock.lock()
        defer { lock.unlock() }
        entries = Dictionary(caps.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
    }

    /// The caps for a canonical id, also matched as `provider:model` from a
    /// resolved route so an alias reaches the same entry.
    public func caps(for modelID: String, providerID: String? = nil, providerModelID: String? = nil) -> CodeReasoningCaps? {
        lock.lock()
        defer { lock.unlock() }
        if let hit = entries[modelID.lowercased()] { return hit }
        if let providerID, let providerModelID {
            return entries["\(providerID):\(providerModelID)".lowercased()]
        }
        return nil
    }
}
