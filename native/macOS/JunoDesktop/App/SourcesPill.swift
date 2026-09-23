import Foundation
import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The answer's bibliography, as the web writes it: a pill that reports how many
/// sources backed the reply and expands into the cited list.
///
/// The flat "Sources" heading with every link permanently open that this replaces
/// was the loudest thing under a long answer, and it grew without limit — a deep
/// research reply cites dozens. The web collapses it deliberately: the inline
/// citations are what a reader follows mid-sentence, and this is the bibliography
/// they open afterwards. Both the pill and the expanded list are raised surfaces,
/// so they read as objects sitting on the canvas rather than as more text printed
/// onto it.
struct DesktopMessageSources: View {
    let sources: [NativeChatSource]
    @State private var expanded: Bool

    /// `startsExpanded` opens the list at once — for the snapshot harness,
    /// which cannot click the pill.
    init(sources: [NativeChatSource], startsExpanded: Bool = false) {
        self.sources = sources
        _expanded = State(initialValue: startsExpanded)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 120), spacing: JunoSpace.tight)],
                alignment: .leading,
                spacing: JunoSpace.tight
            ) {
                ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                    Link(destination: source.url) {
                        HStack(spacing: JunoSpace.hairline) {
                            Text(host(of: source.url))
                                .junoCaption()
                                .lineLimit(1)
                            Text((index + 1).formatted())
                                .junoCodeSmall()
                                .monospacedDigit()
                        }
                        .padding(.horizontal, JunoSpace.snug)
                        .padding(.vertical, JunoSpace.hairline)
                        .background(Capsule().fill(Color.junoMuted))
                        .overlay(Capsule().strokeBorder(Color.junoHairline, lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                    .help(source.url.absoluteString)
                }
            }
            .padding(.top, JunoSpace.snug)
        } label: {
            Label("Sources (\(sources.count))", icon: .web)
                .junoRowLabel()
        }
        .padding(JunoSpace.cozy)
        .junoCard(cornerRadius: JunoRadius.card)
        .frame(maxWidth: 576, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// The web's `hostOf`: the bare host, without the `www.` that carries no
    /// information and pushes the part a reader recognises off the line.
    private func host(of url: URL) -> String {
        guard let host = url.host() else { return url.absoluteString }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
