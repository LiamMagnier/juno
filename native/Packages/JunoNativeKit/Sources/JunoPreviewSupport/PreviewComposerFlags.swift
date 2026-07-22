#if DEBUG
import Foundation
import JunoChatKit

/// Launch-argument switches that drive the composer into one exact state for
/// visual QA, so a screenshot of "the thinking popover at Max, Dynamic Type XXL,
/// dark" is reproducible rather than something to arrive at by tapping.
///
/// DEBUG-only by construction: none of these symbols exist in a Stable build.
/// Shared by both apps so a scenario reproduces identically on iPhone and Mac.
///
/// Examples:
///
///     --juno-preview-model-selector --juno-preview-model-search kimi
///     --juno-preview-model juno:auto --juno-preview-thinking
///     --juno-preview-model anthropic:claude-haiku-4-5 --juno-preview-thinking
///     --juno-preview-thinking-level max --juno-preview-keyboard
public enum JunoComposerPreviewFlags {
    public static func value(_ name: String) -> String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: name),
            arguments.index(after: index) < arguments.endIndex
        else { return nil }
        let value = arguments[arguments.index(after: index)]
        return value.hasPrefix("--") ? nil : value
    }

    public static func isSet(_ name: String) -> Bool {
        CommandLine.arguments.contains(name)
    }

    /// Opens the model picker as soon as the chat appears.
    public static var opensModelSelector: Bool { isSet("--juno-preview-model-selector") }
    /// Opens the thinking popover as soon as the chat appears.
    public static var opensThinking: Bool { isSet("--juno-preview-thinking") }
    /// Focuses the composer, which brings the keyboard up.
    public static var focusesComposer: Bool { isSet("--juno-preview-keyboard") }
    public static var opensComposerActions: Bool { isSet("--juno-preview-composer-actions") }

    public static var modelSearch: String? { value("--juno-preview-model-search") }
    public static var modelProvider: String? { value("--juno-preview-model-provider") }
    public static var forcedModelID: String? { value("--juno-preview-model") }

    /// `off` maps to no effort; anything else must name a real effort.
    public static var forcedThinkingLevel: NativeReasoningEffort?? {
        guard let raw = value("--juno-preview-thinking-level") else { return nil }
        if raw == "off" { return .some(nil) }
        return NativeReasoningEffort(rawValue: raw).map { .some($0) }
    }
}
#endif
