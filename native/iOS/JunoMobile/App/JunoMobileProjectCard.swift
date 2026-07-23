import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// A project as a card, following the website's Projects page rather than the
/// flat folder-row list this replaces.
///
/// The depth is deliberately restrained. A card sits one step off the canvas on
/// an opaque surface — not Liquid Glass. Glass belongs to floating chrome that
/// passes *over* content; a scrolling wall of it would put a blur behind every
/// title and cost legibility for nothing. The instruction preview is the one
/// thing a project card can say that a row cannot, so it earns its two lines.
struct JunoMobileProjectCard: View {
    let project: NativeProject
    let conversations: Int
    let files: Int

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
                Text(project.name)
                    .font(JunoSerif.cardTitle)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 0)

                if project.starred {
                    Image(systemName: "star.fill")
                        .font(.caption)
                        .foregroundStyle(Color.junoAccent)
                        .accessibilityLabel("Favorite")
                }
                if project.isPending {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Waiting to sync")
                }
            }

            if let preview = instructionPreview {
                Text(preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }

            Text(
                "^[\(conversations) chat](inflect: true) · ^[\(files) file](inflect: true) · \(project.updatedAt.formatted(.relative(presentation: .named)))"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(JunoSpace.regular)
        .background(
            RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                .fill(Color.junoRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous)
                .strokeBorder(Color.junoSeparator, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: JunoCornerRadius.card, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    /// The first non-empty line of the instructions, collapsed to one sentence's
    /// worth. Showing the whole prompt is what made the Project *detail* screen
    /// unreadable; a card gets a hint, not the document.
    private var instructionPreview: String? {
        let raw = project.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let firstLine = raw.split(separator: "\n").first.map(String.init) ?? raw
        return firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
