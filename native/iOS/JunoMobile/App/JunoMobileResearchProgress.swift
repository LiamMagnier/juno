import JunoChatKit
import SwiftUI

/// Deep research state above the composer: that the mode is on, what the server
/// is currently doing, and whether the research quietly degraded.
///
/// The live steps are the point. Research runs PLAN → SEARCH → READ for tens of
/// seconds before a single token of the report is streamed, so without them the
/// screen is an empty bubble and a spinner for the entire prep phase — which
/// reads as a hung app rather than as work in progress.
struct JunoMobileResearchProgress: View {
    let enabled: Bool
    let activity: [NativeChatActivity]
    let degradedWarning: String?
    let onDisable: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if enabled { header }
            if let step = latestStep { stepRow(step) }
            if let degradedWarning { warningRow(degradedWarning) }
        }
        .padding(.horizontal, 14)
        .accessibilityIdentifier("juno.mobile.research-progress")
    }

    /// The most recent step only. The full log belongs in the transcript once
    /// the turn is finished; a growing list above the composer would push the
    /// text field around while someone is typing into it.
    private var latestStep: NativeChatActivity? {
        activity.last { $0.kind != .warning }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "binoculars")
                .font(.caption)
            Text("research.enabled")
                .font(.caption.weight(.medium))
            Spacer()
            Button("research.turn-off", action: onDisable)
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
        }
        .accessibilityElement(children: .combine)
    }

    private func stepRow(_ step: NativeChatActivity) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon(for: step.kind))
                .font(.caption2)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(step.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let detail = step.detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer()
        }
        // Announced as one changing status rather than as newly appearing text,
        // so VoiceOver reports progress instead of re-reading the layout.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// Shown separately from the steps because it changes what the answer *is*.
    /// A reader who asked for research and silently received plain chat has
    /// been misled about the basis of the reply.
    private func warningRow(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.caption2)
            Text(message)
                .font(.caption2)
                .lineLimit(2)
            Spacer()
        }
        .foregroundStyle(.orange)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("juno.mobile.research-degraded")
    }

    private func icon(for kind: NativeChatActivity.Kind) -> String {
        switch kind {
        case .search: "magnifyingglass"
        case .visit: "doc.text"
        case .write: "square.and.pencil"
        case .reasoning: "brain"
        case .model, .context: "cpu"
        case .usage: "gauge"
        case .done: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .tool: "wrench.and.screwdriver"
        case .unknown: "circle.dotted"
        }
    }
}
