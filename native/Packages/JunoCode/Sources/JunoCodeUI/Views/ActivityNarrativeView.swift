import SwiftUI
import JunoCodeCore
import JunoDesignSystem

/// Compact, human-readable work narrative representing grouped agent actions
/// (file reads, searches, command executions, patches).
public struct ActivityNarrativeView: View {
    public let group: ActivityNarrativeGroup
    @State private var isExpanded: Bool = false

    public init(group: ActivityNarrativeGroup) {
        self.group = group
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header button
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    // Activity icon
                    activityIcon
                        .frame(width: 20, height: 20)

                    // Title & Summary
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(group.title)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.primary)

                            if group.status == .running {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                        }

                        Text(group.detailSummary)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.secondary)
                    }

                    Spacer()

                    // Expand / Collapse chevron
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.secondary)
                        .padding(.trailing, 4)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(group.title), \(group.detailSummary)")
            .accessibilityHint(isExpanded ? "Double click to collapse details" : "Double click to expand details")

            // Expanded micro-audit log
            if isExpanded {
                Divider()
                    .opacity(0.5)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(group.toolCallRecords) { record in
                        HStack(alignment: .top, spacing: 8) {
                            toolStatusIcon(for: record.status)
                                .font(.system(size: 10))
                                .padding(.top, 2)

                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(record.toolName)
                                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(Color.primary)

                                    if let duration = record.durationSeconds {
                                        Text(String(format: "%.1fs", duration))
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(Color.secondary)
                                    }
                                }

                                if let summary = record.summary {
                                    Text(summary)
                                        .font(.system(size: 11))
                                        .foregroundStyle(Color.secondary)
                                        .lineLimit(2)
                                }

                                if !record.outputLines.isEmpty {
                                    VStack(alignment: .leading, spacing: 1) {
                                        ForEach(record.outputLines.prefix(5), id: \.self) { line in
                                            Text(line)
                                                .font(.system(size: 10, design: .monospaced))
                                                .foregroundStyle(Color.secondary)
                                                .lineLimit(1)
                                        }
                                        if record.outputLines.count > 5 {
                                            Text("+ \(record.outputLines.count - 5) more lines")
                                                .font(.system(size: 9))
                                                .foregroundStyle(Color.secondary.opacity(0.8))
                                        }
                                    }
                                    .padding(4)
                                    .background(Color.primary.opacity(0.04))
                                    .cornerRadius(4)
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .padding(10)
                .background(Color.primary.opacity(0.02))
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.6))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .cornerRadius(8)
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var activityIcon: some View {
        switch group.status {
        case .running:
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 12))
                .foregroundStyle(Color.accentColor)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(Color.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(Color.red)
        case .interrupted:
            Image(systemName: "stop.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(Color.orange)
        }
    }

    @ViewBuilder
    private func toolStatusIcon(for status: ActivityNarrativeGroup.ToolCallRecord.ToolStatus) -> some View {
        switch status {
        case .proposed:
            Image(systemName: "circle.dotted")
                .foregroundStyle(Color.secondary)
        case .running:
            ProgressView()
                .controlSize(.mini)
        case .succeeded:
            Image(systemName: "checkmark")
                .foregroundStyle(Color.green)
        case .failed:
            Image(systemName: "xmark")
                .foregroundStyle(Color.red)
        case .denied:
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(Color.orange)
        case .cancelled:
            Image(systemName: "slash.circle")
                .foregroundStyle(Color.secondary)
        }
    }
}
