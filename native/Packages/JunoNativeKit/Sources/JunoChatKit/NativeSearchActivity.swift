import Foundation
import JunoDesignSystem

/// A run's search activity as AIcss's Web Search block sees it.
///
/// The website derives the same two things from the same two events in
/// `thought-process-panel.tsx` (`buildRun` / `toSearchSites`), so the three
/// clients cannot disagree about what a run searched for or what it read.
public enum NativeSearchActivity {
    /// Only deep research's per-query sends are real searches. "Preparing web
    /// search" is an INTENT, not work — counting it would inflate the noun, and
    /// it carries no query to show.
    private static let searchingTitle = "Searching the web"

    /// The last query the run actually searched for, verbatim, or nil when it
    /// never ran one.
    ///
    /// Nil is the honest answer on the provider-tool search paths, where sources
    /// arrive from grounding metadata and the query the model typed is never sent
    /// to us. The block omits its label row rather than inventing one.
    public static func query(in activity: [NativeChatActivity]) -> String? {
        let detail = activity
            .last { $0.kind == .search && $0.title == searchingTitle }?
            .detail?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (detail?.isEmpty ?? true) ? nil : detail
    }

    /// The sources the run has read, in the order it read them.
    ///
    /// EVERY ROW IS `done`, and that is a statement about the data rather than a
    /// shortcut. A `visit` event is emitted at the moment a source has been
    /// collected or read — there is no event for "about to fetch this URL",
    /// because until the search returns the URL is not yet known. A pending or
    /// fetching row here would be a state this client cannot observe, drawn in the
    /// shape that says it did. The in-flight state lives on the label, which
    /// shimmers until the search settles.
    public static func sites(in activity: [NativeChatActivity]) -> [JunoAIcssSearchSite] {
        var seen = Set<String>()
        var sites: [JunoAIcssSearchSite] = []
        for item in activity {
            guard let raw = item.url, let url = URL(string: raw), !seen.contains(raw) else { continue }
            seen.insert(raw)
            let label = JunoAIcssSearchSite.label(for: url)
            // The producer already truncated `detail` to 96 and already fell back
            // to the host when the page had no title, so there is nothing left to
            // decide here.
            let title = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
            sites.append(
                JunoAIcssSearchSite(
                    title: (title?.isEmpty ?? true) ? label : title!,
                    label: label,
                    url: url,
                    state: .done
                )
            )
        }
        return sites
    }

    /// Whether the research phase this block describes is over.
    ///
    /// The corpus event is the producer's own statement that reading has finished,
    /// and the first `write` means the answer has started — either ends the search.
    /// The label stops shimmering there rather than when the whole run lands, so
    /// it describes the phase it names.
    public static func settled(in activity: [NativeChatActivity]) -> Bool {
        activity.contains { $0.kind == .context && $0.title == "Research corpus ready" }
            || activity.contains { $0.kind == .write }
    }
}
