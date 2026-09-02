import JunoDesignSystem
import SwiftUI
import UIKit

/// What a long press on a message offers.
///
/// The row used to offer Copy and nothing else. Everything the web puts under
/// an answer — and the two things a phone needs that the web does not, *Select
/// text* and *Quote* — lives here now. Actions arrive as optional closures so a
/// row only shows what it can actually do: a spoken line has no Regenerate, an
/// answer has no Edit.
struct JunoMobileMessageMenuActions {
  var copy: () -> Void
  var selectText: () -> Void
  var share: (() -> Void)?
  var quote: (() -> Void)?
  var readAloud: (() -> Void)?
  var isReadingAloud = false
  var regenerate: (() -> Void)?
  var edit: (() -> Void)?
  var branch: (() -> Void)?
}

extension View {
  /// The message context menu. A modifier so the user bubble and the answer
  /// share one menu without sharing a view.
  func junoMessageContextMenu(_ actions: JunoMobileMessageMenuActions) -> some View {
    contextMenu {
      Button(action: actions.copy) {
        Label { Text("Copy") } icon: { JunoIconView(.copy, size: 15) }
      }
      Button(action: actions.selectText) {
        Label("Select text", systemImage: "selection.pin.in.out")
      }
      if let quote = actions.quote {
        Button(action: quote) {
          Label("Quote in reply", systemImage: "text.quote")
        }
      }
      if let share = actions.share {
        Button(action: share) {
          Label { Text("Share…") } icon: { JunoIconView(.share, size: 15) }
        }
      }
      if let readAloud = actions.readAloud {
        Button(action: readAloud) {
          Label {
            Text(actions.isReadingAloud ? "Stop reading" : "Read aloud")
          } icon: {
            JunoIconView(actions.isReadingAloud ? .stop : .volume, size: 15)
          }
        }
      }
      if actions.regenerate != nil || actions.edit != nil || actions.branch != nil {
        Divider()
      }
      if let regenerate = actions.regenerate {
        Button(action: regenerate) {
          Label { Text("Regenerate") } icon: { JunoIconView(.refresh, size: 15) }
        }
      }
      if let edit = actions.edit {
        Button(action: edit) {
          Label { Text("Edit") } icon: { JunoIconView(.pencil, size: 15) }
        }
      }
      if let branch = actions.branch {
        Button(action: branch) {
          Label { Text("Branch from here") } icon: { JunoIconView(.branch, size: 15) }
        }
      }
    }
  }
}

/// A sheet holding one message's text, selectable and nothing else.
///
/// `textSelection(.enabled)` on a transcript row selects a whole paragraph at
/// once and fights the scroll view; a `UITextView` selects by word and drag,
/// which is what "select text" means on a phone. The sheet is that text view
/// and a Done button.
struct JunoMobileSelectTextSheet: View {
  let title: String
  let text: String

  @Environment(\.dismiss) private var dismiss
  @State private var copyHaptic = JunoMobileHapticTrigger()

  var body: some View {
    NavigationStack {
      JunoMobileSelectableText(text: text)
        .padding(.horizontal, JunoSpace.regular)
        .junoScreenCanvas()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              UIPasteboard.general.string = text
              copyHaptic.fire()
            } label: {
              JunoIconView(.copy, size: 15)
            }
            .accessibilityLabel("Copy all")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
          }
        }
    }
    .junoSheetSurface(.page)
    .junoHaptic(JunoMobileHaptic.copy, trigger: copyHaptic)
    .accessibilityIdentifier("juno.mobile.select-text")
  }
}

private struct JunoMobileSelectableText: UIViewRepresentable {
  let text: String

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = true
    view.backgroundColor = .clear
    view.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 24, right: 0)
    view.font = UIFont.preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.textColor = UIColor(Color.junoForeground)
    view.text = text
    view.dataDetectorTypes = [.link]
    view.linkTextAttributes = [.foregroundColor: UIColor(Color.junoAccent)]
    view.accessibilityIdentifier = "juno.mobile.select-text-view"
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    if view.text != text { view.text = text }
  }
}

/// A rich-text share of one message: the plain text as both string and file,
/// so Messages gets a paragraph and Files gets a document.
struct JunoMobileMessageShareSheet: View {
  let text: String
  let title: String

  var body: some View {
    JunoMobileShareSheet(items: [text])
  }
}
