import JunoCore
import JunoDesignSystem
import SwiftUI

/// The words Juno Work uses for the things its executors report.
///
/// **Why this file exists.** Everything a run emits — the tool it called, the
/// reason it stopped, the kind of document it wrote, where it ran — arrives as a
/// wire token: `apply_changes`, `budget_exceeded`, `spreadsheet`, `local`. The
/// thread used to render those by replacing underscores with spaces, so the
/// largest line in the window, the live action banner, said things like "apply
/// changes" and "files write", and a finished run read "Finished — succeeded".
/// Every other string in this product is hand-written English; these were the
/// ones nobody had written, and they were the most visible.
///
/// **The rule.** No wire token reaches a person. A token this build does not
/// know is *sentence-cased* rather than printed raw — "did something with
/// `foo_bar`" is still wrong, but "Foo bar" is a phrase and not a symbol, and a
/// build one release behind an executor degrades to slightly vague English
/// instead of to a debug log.
///
/// The copy is deliberately verb-first and in the past or present continuous,
/// because every one of these strings is read as *what Juno is doing* or *what
/// Juno did* — never as the name of an API.
enum DesktopWorkVocabulary {
    // MARK: - Tools

    /// What a tool call is doing, as a phrase that completes "Juno is …".
    ///
    /// The names are the `WorkTool.name` values in `JunoWorkRuntime` — the same
    /// strings the relay stores as an approval's `action` — so this table and
    /// the executors cannot drift without a test noticing.
    static func toolPresent(_ name: String?) -> String {
        guard let name = normalised(name) else { return "Working" }
        switch name {
        case "list_folder": return "Looking through a folder"
        case "read_file": return "Reading a file"
        case "search_files": return "Searching your files"
        case "file_details": return "Checking a file"
        case "apply_changes": return "Making changes to your files"
        case "permanently_delete": return "Deleting files for good"
        case "browser_control": return "Using your browser"
        case "app_control": return "Using an app on your Mac"
        case "screen_control": return "Working on your screen"
        case "web_search", "web_research": return "Searching the web"
        case "fetch_page", "read_page": return "Reading a web page"
        default: return sentenceCased(name)
        }
    }

    /// The same tool as a completed act, for the timeline's past tense.
    static func toolPast(_ name: String?) -> String {
        guard let name = normalised(name) else { return "Did something" }
        switch name {
        case "list_folder": return "Looked through a folder"
        case "read_file": return "Read a file"
        case "search_files": return "Searched your files"
        case "file_details": return "Checked a file"
        case "apply_changes": return "Changed your files"
        case "permanently_delete": return "Deleted files for good"
        case "browser_control": return "Used your browser"
        case "app_control": return "Used an app on your Mac"
        case "screen_control": return "Worked on your screen"
        case "web_search", "web_research": return "Searched the web"
        case "fetch_page", "read_page": return "Read a web page"
        default: return sentenceCased(name)
        }
    }

    /// The name of the thing an approval would authorise, for the card's eyebrow.
    static func action(_ name: String?) -> String {
        guard let name = normalised(name) else { return "An action" }
        switch name {
        case "apply_changes": return "Change files"
        case "permanently_delete": return "Delete permanently"
        case "browser_control": return "Use your browser"
        case "app_control": return "Use an app"
        case "screen_control": return "Control your screen"
        default: return sentenceCased(name)
        }
    }

    // MARK: - Outcomes

    /// Why a run ended, as a sentence fragment that follows the status.
    ///
    /// Returns nil where the reason adds nothing the status has not already
    /// said. "Finished — completed" is the status twice; the row is better with
    /// one word than with two that agree.
    static func terminalReason(_ reason: String?) -> String? {
        guard let reason = normalised(reason) else { return nil }
        switch JunoWorkTerminalReason(rawValue: reason) {
        case .completed: return nil
        case .failed: return "it could not finish"
        case .cancelled: return "you stopped it"
        case .budgetExceeded: return "it reached its spending limit"
        case .timedOut: return "it ran out of time"
        case .hostOffline: return "the Mac it needed went away"
        case .interrupted: return "the executor stopped reporting"
        case .superseded: return "a newer attempt replaced it"
        case nil: return sentenceCased(reason).lowercased()
        }
    }

    // MARK: - Documents

    /// What a produced document is, in the words somebody would use for the file.
    static func artifactKind(_ kind: JunoWorkArtifactKind) -> String {
        switch kind {
        case .document: return "Document"
        case .spreadsheet: return "Spreadsheet"
        case .presentation: return "Presentation"
        case .pdf: return "PDF"
        case .report: return "Report"
        case .image: return "Image"
        case .site: return "Site"
        case .archive: return "Archive"
        case .bundle: return "File"
        }
    }

    /// The symbol for a produced document.
    ///
    /// A real glyph rather than the bare file extension the section used to set
    /// in a 34pt-wide monospaced slot: an extension is a filename detail, and a
    /// list of them reads as a directory listing rather than as work product.
    static func artifactSymbol(_ kind: JunoWorkArtifactKind) -> String {
        switch kind {
        case .document: return "doc.richtext"
        case .spreadsheet: return "tablecells"
        case .presentation: return "rectangle.on.rectangle"
        case .pdf: return "doc.text"
        case .report: return "chart.bar.doc.horizontal"
        case .image: return "photo"
        case .site: return "globe"
        case .archive: return "archivebox"
        case .bundle: return "shippingbox"
        }
    }

    // MARK: - Where it runs

    /// Where a run happens, named from the effective target.
    static func target(_ raw: String?, hostName: String?) -> String {
        guard let raw, let target = JunoWorkTarget(rawValue: raw) else {
            return "Juno hasn’t chosen where this runs yet"
        }
        switch target {
        case .cloud: return "Runs in the cloud"
        case .local: return "Runs on \(hostName ?? "a Mac of yours")"
        case .automatic: return "Where this runs hasn’t been decided"
        }
    }

    // MARK: - Risk

    /// What an approval's risk level means, in the second person.
    static func risk(_ raw: String) -> String {
        switch JunoWorkRiskLevel(rawValue: raw) {
        case .safe: return "Safe to allow"
        case .edit: return "Changes your files"
        case .command: return "Runs a command"
        case .sensitive: return "Touches private data"
        case .irreversible: return "Can’t be undone"
        case nil: return "Needs your decision"
        }
    }

    /// The colour an approval's risk level is drawn in.
    ///
    /// Two levels only, matching `JunoWorkRiskLevel.requiresApproval`: the ones
    /// that cannot be taken back are danger, everything else is caution. A
    /// five-colour risk scale asks the reader to learn a legend at the exact
    /// moment they are being asked to decide something.
    static func riskTint(_ raw: String) -> Color {
        switch JunoWorkRiskLevel(rawValue: raw) {
        case .irreversible: return Color.junoDanger
        default: return Color.junoCaution
        }
    }

    // MARK: - Helpers

    private static func normalised(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// `apply_changes` → `Apply changes`.
    ///
    /// The fallback for a token this build has no phrase for. It is not good
    /// English, and it is not meant to be — it is the floor that stops a symbol
    /// reaching the screen when an executor ships a tool before the Mac app
    /// learns its name.
    static func sentenceCased(_ token: String) -> String {
        let words = token
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map(String.init)
        guard let first = words.first else { return token }
        return ([first.capitalizedFirst] + words.dropFirst()).joined(separator: " ")
    }
}

private extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return String(first).uppercased() + dropFirst()
    }
}

// MARK: - Status pill

/// A task's status, as a tinted capsule.
///
/// **What this replaces.** The status was `Label(...).junoCodeSmall()` — a
/// monospaced caption in the status colour, beside a serif page title. The
/// design system reserves monospace for "terminal output, gutters, hashes"
/// (`JunoStatus.swift`), so the one thing in the header a reader looks for first
/// was set in the one face reserved for machine output.
///
/// A capsule rather than coloured text because the status is a *label*, not
/// prose: it wants an edge so the eye can find it without reading it, and a
/// tinted fill carries the state at a glance in a way coloured text on a warm
/// canvas does not. The fill is the tint at low opacity rather than a second
/// palette entry, so a status added to the contract needs no new colour.
struct DesktopWorkStatusPill: View {
    let status: JunoWorkStatus
    /// The compact form: no fill, for use inside a source-list row where a
    /// capsule per row would be a column of lozenges.
    var quiet = false

    var body: some View {
        let style = DesktopWorkStatusStyle.of(status)
        return Label {
            Text(style.label)
        } icon: {
            Image(systemName: style.symbol)
                .imageScale(.small)
        }
        .font(.system(.caption, design: .default, weight: .medium))
        .foregroundStyle(quiet ? Color.secondary : style.tint)
        .padding(.horizontal, quiet ? 0 : JunoSpace.snug)
        .padding(.vertical, quiet ? 0 : 3)
        .background {
            if !quiet {
                Capsule(style: .continuous)
                    .fill(style.tint.opacity(0.12))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(style.label)
    }
}
