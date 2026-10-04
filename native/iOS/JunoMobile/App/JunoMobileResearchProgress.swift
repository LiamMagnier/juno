import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// A compact research workspace over the server's actual events. It stays stable
/// beside the composer, with evidence and the real search trail one disclosure away.
struct JunoMobileResearchProgress: View {
    let enabled: Bool
    var depth: NativeResearchEffort? = nil
    let activity: [NativeChatActivity]
    let degradedWarning: String?
    let onDisable: () -> Void
    var onStop: (() -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsEvidence = false

    private var progress: ServerResearchProgress { DeepResearchActivityProjection.progress(from: activity) }
    private var hasActivity: Bool { !activity.isEmpty }
    private var working: Bool { hasActivity && progress.phase != .completed && progress.phase != .stopped && onStop != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            header
            if hasActivity {
                HStack(alignment: .top, spacing: JunoSpace.snug) {
                    JunoResearchPresence(active: working, eventKey: "\(progress.phase):\(activity.count)", size: 20)
                    VStack(alignment: .leading, spacing: JunoSpace.tight) {
                        Text(!working && progress.phase != .completed ? "Last activity · \(progress.phase.displayName)" : progress.phase.displayName)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.junoForeground)
                        if let query = progress.currentQuery, progress.phase == .searching {
                            Text(query)
                                .font(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("juno.mobile.research-phase")
                evidence
            } else if let depth {
                Text(depth.summary)
                    .font(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let degradedWarning { warning(degradedWarning) }
            ForEach(Array(progress.warnings.filter { $0 != degradedWarning }.enumerated()), id: \.offset) { _, message in
                warning(message)
            }
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.junoCard, in: RoundedRectangle(cornerRadius: JunoRadius.card))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.card).strokeBorder(Color.junoHairline, lineWidth: 1))
        .padding(.horizontal, JunoSpace.regular)
        .animation(JunoMotion.reduced(JunoMotion.base, when: reduceMotion), value: showsEvidence)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("juno.mobile.research-progress")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: JunoSpace.snug) {
            Text("Deep research")
                .font(JunoSerif.font(size: 20, relativeTo: .headline))
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            if let depth, !hasActivity {
                Text(depth.label)
                    .font(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .accessibilityIdentifier("juno.mobile.research-depth")
            }
            Spacer(minLength: 0)
            if working, let onStop {
                Button("Stop", action: onStop)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.junoForeground)
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Stop research")
            } else if enabled {
                Button("Turn off", action: onDisable)
                    .font(.caption)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
            }
        }
    }

    private var evidence: some View {
        DisclosureGroup(isExpanded: $showsEvidence) {
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                ForEach(Array(progress.queriesRun.enumerated()), id: \.offset) { _, query in
                    Text(query)
                        .font(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(Array(progress.pagesRead.enumerated()), id: \.offset) { _, source in
                    Link(destination: source.url) {
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            Text(source.title.isEmpty ? source.url.host ?? "Source" : source.title)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.junoForeground)
                            Text(source.url.host ?? source.url.absoluteString)
                                .font(.caption2)
                                .foregroundStyle(Color.junoSecondaryInk)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(.rect)
                    }
                }
                if progress.queriesRun.isEmpty && progress.pagesRead.isEmpty {
                    Text("Sources appear here when the server reports reading them.")
                        .font(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Text("Read sources are not yet verified citations. Citation numbers belong to the finished report.")
                    .font(.caption2)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, JunoSpace.snug)
        } label: {
            HStack(spacing: JunoSpace.regular) {
                if !progress.queriesRun.isEmpty { figure("Searches", progress.queriesRun.count) }
                if !progress.pagesRead.isEmpty { figure("Read", progress.pagesRead.count) }
                if progress.queriesRun.isEmpty && progress.pagesRead.isEmpty {
                    Text("Evidence & activity").font(.caption)
                }
            }
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(minHeight: 44)
        }
        .padding(.top, JunoSpace.tight)
        .overlay(alignment: .top) { Rectangle().fill(Color.junoHairline).frame(height: 1) }
        .accessibilityIdentifier("juno.mobile.research-evidence")
    }

    private func figure(_ label: String, _ count: Int) -> some View {
        HStack(spacing: JunoSpace.tight) {
            Text(count.formatted()).monospacedDigit().foregroundStyle(Color.junoForeground)
            Text(label)
        }
        .font(.caption)
    }

    private func warning(_ message: String) -> some View {
        Text(message)
            .font(.caption)
            .foregroundStyle(Color.junoWarningInk)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("juno.mobile.research-degraded")
    }
}
