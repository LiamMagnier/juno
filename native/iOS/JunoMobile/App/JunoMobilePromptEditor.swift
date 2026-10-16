import JunoDesignSystem
import SwiftUI

/// When the composer offers its full-screen editor.
///
/// The composer's field grows to six lines and then scrolls inside itself,
/// which leaves a long prompt edited through a six-line slot. Once the field
/// is at that cap (or the draft plainly has that many lines, which covers a
/// paste before layout has measured it), an expand control appears.
enum JunoMobilePromptEditorOffer {
  /// The composer field's growth limit: `lineLimit(1...composerLineCap)`.
  static let composerLineCap = 6

  /// Whether the field has reached its cap.
  ///
  /// - Parameters:
  ///   - fieldHeight: the text field's measured height, without its padding.
  ///   - lineHeight: one line of the field's font at the current text size.
  static func offers(
    prompt: String,
    fieldHeight: CGFloat,
    lineHeight: CGFloat,
    lineCap: Int = composerLineCap
  ) -> Bool {
    guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    if lineCount(prompt) >= lineCap { return true }
    guard lineHeight > 0 else { return false }
    // Half a line of slack: a capped field measures lineCap × lineHeight give
    // or take rounding, and one line short of the cap must not count.
    return fieldHeight >= lineHeight * (CGFloat(lineCap) - 0.5)
  }

  /// Lines the text breaks into by itself, before any wrapping.
  static func lineCount(_ text: String) -> Int {
    text.reduce(1) { count, character in character.isNewline ? count + 1 : count }
  }
}

/// The composer's draft, full screen.
///
/// The same text — bound, not copied, so the synced draft and the composer
/// never disagree — with the composer's attachments and armed tools above it
/// and Send below. Done hands the draft back to the composer as it is; Send
/// sends it from here. A `TextEditor` rather than the composer's growing
/// field, because it stays responsive at tens of thousands of characters,
/// which is also why a very long paste opens here to be edited.
struct JunoMobilePromptEditor<Accessories: View>: View {
  @Binding var text: String
  var placeholder: Text
  var canSend: Bool
  var send: () -> Void
  var done: () -> Void
  @ViewBuilder var accessories: () -> Accessories

  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      editor
        .safeAreaInset(edge: .top, spacing: 0) {
          accessories()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .background(Color.junoCanvas)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button(action: done) {
              Text("Done")
            }
            .accessibilityHint(Text("Returns to the message composer"))
            .accessibilityIdentifier("juno.mobile.prompt-editor.done")
          }
        }
    }
    // The keyboard comes up with the editor: it was opened to type in.
    .task { focused = true }
  }

  private var editor: some View {
    ZStack(alignment: .topLeading) {
      TextEditor(text: $text)
        .junoFont(size: 17, relativeTo: .body)
        .scrollContentBackground(.hidden)
        .focused($focused)
        // A TextEditor sets its text 5pt inside its own edge; this lines the
        // text up with the composer's 16pt gutter.
        .padding(.horizontal, JunoSpace.regular - 5)
        .accessibilityLabel(Text("Message"))
        .accessibilityIdentifier("juno.mobile.prompt-editor")
      if text.isEmpty {
        placeholder
          .junoFont(size: 17, relativeTo: .body)
          .foregroundStyle(Color.secondary)
          .padding(.horizontal, JunoSpace.regular)
          .padding(.top, JunoSpace.snug)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
  }

  private var footer: some View {
    HStack(spacing: JunoSpace.snug) {
      Text("^[\(text.count) character](inflect: true)")
        .junoFont(size: 12, relativeTo: .caption)
        .monospacedDigit()
        .foregroundStyle(Color.junoMutedForeground)
        .contentTransition(.numericText())
      Spacer(minLength: 0)
      JunoMobileComposerPrimaryButton(face: .send(enabled: canSend), action: send)
        .accessibilityIdentifier("juno.mobile.prompt-editor.send")
    }
    .padding(.leading, JunoSpace.regular)
    .padding(.trailing, JunoSpace.snug)
    .padding(.vertical, JunoSpace.tight)
    .background(Color.junoCanvas)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(Color.junoHairline)
        .frame(height: 1)
    }
  }
}

/// The expand control on the composer's field, once it is at its cap.
struct JunoMobilePromptEditorButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      JunoIconView(.maximize, size: 16)
        .foregroundStyle(Color.junoMutedForeground)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text("Expand message"))
    .accessibilityHint(Text("Opens the message full screen for editing"))
    .accessibilityIdentifier("juno.mobile.prompt-editor.open")
  }
}
