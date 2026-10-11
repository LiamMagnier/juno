import Foundation

/// Which lab makes a Code model, and its one-word name: shared by the Mac's
/// Code picker (`CodeV2ModelCatalogue`) and the phone's remote picker, so a
/// model is filed under the same lab on both.
public enum CodeV2Labs {
    /// The rail's one word per lab: the first half of the web's
    /// `PROVIDERS[lab].label` ("Anthropic · Claude" → "Anthropic").
    public static let names: [String: String] = [
        "anthropic": "Anthropic", "openai": "OpenAI", "zhipu": "Zhipu", "moonshot": "Moonshot",
        "google": "Google", "meta": "Meta", "deepseek": "DeepSeek", "mistral": "Mistral",
        "xai": "SpaceXAI", "seedance": "ByteDance", "minimax": "MiniMax", "mimo": "MiMo",
        "qwen": "Alibaba", "longcat": "Meituan", "openrouter": "OpenRouter",
    ]

    public static func name(_ id: String) -> String {
        names[id.lowercased()] ?? (id.prefix(1).uppercased() + id.dropFirst())
    }

    /// The lab a model belongs to: its id's routing prefix ("anthropic:claude-opus-5-5"),
    /// else the lab of the key it runs on, else "other".
    public static func labID(model: String, instance: CodeV2.ProviderInstance) -> String {
        if let colon = model.firstIndex(of: ":") { return model[..<colon].lowercased() }
        if instance.kind == .byok, let lab = byokLab(instance) { return lab.rawValue }
        return "other"
    }

    public static func byokLab(_ instance: CodeV2.ProviderInstance) -> CodeV2.ByokProvider? {
        instance.id.split(separator: ":").last.flatMap { CodeV2.ByokProvider(rawValue: String($0)) }
    }
}
