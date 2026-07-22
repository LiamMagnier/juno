import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The contextual inspector for the selected conversation.
///
/// Only sections with real content are rendered — a pane full of "None" rows
/// teaches the reader to stop opening it. Everything shown here comes from the
/// synchronized local record; nothing is fabricated to fill space.
struct JunoMacChatInspector: View {
    let conversation: NativeConversation
    let messages: [NativeChatMessage]
    let modelDisplayName: String
    let projectName: String?
    let artifacts: [NativeArtifact]
    let openArtifact: (String) -> Void

    /// Citations across the whole thread, de-duplicated by URL and kept in
    /// first-appearance order so the numbering matches the transcript.
    private var sources: [NativeChatSource] {
        var seen = Set<URL>()
        var ordered: [NativeChatSource] = []
        for source in messages.flatMap(\.sources) where seen.insert(source.url).inserted {
            ordered.append(source)
        }
        return ordered
    }

    private var exchangeCount: Int {
        messages.filter { $0.role == .user }.count
    }

    var body: some View {
        Form {
            Section("inspector.about") {
                LabeledContent("inspector.model", value: modelDisplayName)
                LabeledContent("inspector.exchanges", value: exchangeCount.formatted())
                LabeledContent("inspector.created") {
                    Text(conversation.createdAt, format: .dateTime.day().month().year())
                }
                LabeledContent("inspector.updated") {
                    Text(conversation.lastMessageAt, style: .relative)
                }
                if conversation.pinned {
                    Label("chat.pinned", systemImage: "pin.fill")
                        .foregroundStyle(Color.junoAccent)
                }
                if conversation.isArchived {
                    Label("chat.archived", systemImage: "archivebox")
                        .foregroundStyle(.secondary)
                }
            }

            if let projectName {
                Section("inspector.project") {
                    Label(projectName, systemImage: "folder")
                }
            }

            if !artifacts.isEmpty {
                Section("inspector.artifacts") {
                    ForEach(artifacts) { artifact in
                        Button {
                            openArtifact(artifact.id)
                        } label: {
                            HStack(spacing: JunoSpacing.compact) {
                                Image(systemName: symbol(for: artifact.kind))
                                    .foregroundStyle(Color.junoAccent)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(artifact.title).lineLimit(1)
                                    Text("inspector.artifact.version \(artifact.currentVersion)")
                                        .junoMetadata()
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !sources.isEmpty {
                Section("chat.sources") {
                    ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                        Link(destination: source.url) {
                            HStack(alignment: .firstTextBaseline, spacing: JunoSpacing.compact) {
                                Text("\(index + 1)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(minWidth: 14, alignment: .trailing)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(source.title).lineLimit(2)
                                    // The host, not the full URL: the full URL
                                    // wraps to three lines and tells the reader
                                    // less about whether to trust the source.
                                    if let host = source.url.host() {
                                        Text(host).junoMetadata()
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("juno.mac.chat-inspector")
    }

    private func symbol(for kind: NativeArtifactKind) -> String {
        switch kind {
        case .code: "chevron.left.forwardslash.chevron.right"
        case .html: "safari"
        case .svg: "square.on.circle"
        case .markdown: "doc.richtext"
        case .mermaid: "point.topleft.down.to.point.bottomright.curvepath"
        case .react: "atom"
        }
    }
}
