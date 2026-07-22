import Foundation

/// Turns a raw model identifier such as `anthropic:claude-sonnet-4-6` into a
/// human label like `Claude Sonnet 4.6`.
///
/// The catalog carries a real `displayName` and is always preferred. This is the
/// fallback for the cases where it is genuinely unavailable — before the catalog
/// has loaded, offline, or when a conversation records a model that has since
/// been retired from the catalog. Those cases are common enough that showing the
/// raw identifier would leak `anthropic:claude-sonnet-4-6` into the interface,
/// which is exactly what the product must never do.
///
/// Lives in the shared package so macOS and iOS cannot drift apart on it.
public func junoDisplayModelName(_ raw: String) -> String {
    // `provider:slug` — the provider prefix is routing detail, not a name.
    let slug = raw.split(separator: ":").last.map(String.init) ?? raw
    let tokens = slug.split(separator: "-").map(String.init)
    guard !tokens.isEmpty else { return raw }

    let acronyms: Set<String> = ["gpt", "llm", "ai", "xai"]
    var parts: [String] = []
    for token in tokens {
        if token.allSatisfy(\.isNumber) {
            // Version segments arrive hyphen-separated (`4-6`); rejoin them
            // with a decimal point so "4.6" reads as one version, not two.
            if let last = parts.last, last.allSatisfy({ $0.isNumber || $0 == "." }) {
                parts[parts.count - 1] = last + "." + token
            } else {
                parts.append(token)
            }
        } else if acronyms.contains(token.lowercased()) {
            parts.append(token.uppercased())
        } else {
            parts.append(token.prefix(1).uppercased() + token.dropFirst())
        }
    }
    return parts.joined(separator: " ")
}
