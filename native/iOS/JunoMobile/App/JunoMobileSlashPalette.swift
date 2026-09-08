import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// One row of the "/" palette.
///
/// The same list the web's composer opens on a leading slash, minus the rows
/// whose action has no phone equivalent yet. Each row either flips a tool
/// (research, web, canvas) or opens a surface (voice, library, connected
/// apps); either way the token is consumed, so a chosen command never lands
/// in the sent prompt as literal text.
struct JunoMobileSlashCommand: Identifiable, Equatable {
  let key: String
  let icon: JunoIcon
  let hint: LocalizedStringKey

  var id: String { key }
  var label: String { "/" + key }
}

/// The palette above the text field while the draft is a bare "/token".
///
/// Anchored at the start of the draft, as on the web: any character the token
/// cannot contain closes it, so typing a space is how you get a literal "/".
/// Rows are plain, opaque and 44pt tall; the capsule around the composer is
/// the one piece of glass on this surface and the list sits inside it.
struct JunoMobileSlashPalette: View {
  let commands: [JunoMobileSlashCommand]
  let query: String
  let pick: (JunoMobileSlashCommand) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Prefix match only, exactly as the web filters.
  private var rows: [JunoMobileSlashCommand] {
    query.isEmpty ? commands : commands.filter { $0.key.hasPrefix(query) }
  }

  var body: some View {
    if !rows.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        Text("Commands")
          .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
          .textCase(.uppercase)
          .tracking(0.4)
          .foregroundStyle(Color.junoMutedForeground)
          .padding(.horizontal, JunoSpace.snug)
          .padding(.bottom, JunoSpace.hairline)
        ForEach(rows) { command in
          Button {
            pick(command)
          } label: {
            HStack(spacing: JunoSpace.snug) {
              JunoIconView(command.icon, size: 15)
                .foregroundStyle(Color.junoMutedForeground)
              Text(command.label)
                .junoFont(size: 15, relativeTo: .body, weight: .medium)
                .foregroundStyle(Color.junoForeground)
              Text(command.hint)
                .junoFont(size: 13, relativeTo: .footnote)
                .foregroundStyle(Color.junoMutedForeground)
                .lineLimit(1)
              Spacer(minLength: 0)
            }
            .padding(.horizontal, JunoSpace.snug)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(Text(command.label))
          .accessibilityHint(command.hint)
          .accessibilityIdentifier("juno.mobile.slash.\(command.key)")
        }
      }
      .padding(.bottom, JunoSpace.hairline)
      .overlay(alignment: .bottom) {
        Rectangle().fill(Color.junoHairline).frame(height: 1)
      }
      .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: rows)
      .accessibilityIdentifier("juno.mobile.slash-palette")
    }
  }
}

extension JunoMobileSlashPalette {
  /// The token after a leading slash, or nil when the draft is not a bare
  /// "/token" (a space, a newline or any other text closes the palette).
  static func query(in draft: String) -> String? {
    guard draft.hasPrefix("/") else { return nil }
    let token = draft.dropFirst()
    guard token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
    return token.lowercased()
  }
}
