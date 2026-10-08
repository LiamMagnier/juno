import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Find in this conversation (the Mac's ⌘F bar, `TranscriptFind.swift`): a
/// field under the navigation bar, the count, and up/down to step through the
/// matches. Matches are counted over what the rows draw — the reader's bubble
/// as its plain text, a reply's prose as the reading style renders it — and
/// drawn by the same prose views, on a neutral ground; the current one is the
/// darker ground and is scrolled into view.
struct JunoMobileFindBar: View {
  @Bindable var model: JunoFindModel
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: JunoSpace.snug) {
      JunoSymbol(.search)
        .foregroundStyle(Color.junoSecondaryInk)
        .accessibilityHidden(true)
      TextField("Find in conversation", text: $model.query)
        .textFieldStyle(.plain)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .submitLabel(.search)
        .focused($focused)
        .onSubmit {
          model.next()
          focused = true
        }
        .accessibilityIdentifier("juno.mobile.find-field")
      if !model.status.isEmpty {
        Text(model.status)
          .font(.footnote)
          .monospacedDigit()
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
          .fixedSize()
          .accessibilityIdentifier("juno.mobile.find-status")
      }
      Button {
        model.previous()
      } label: {
        JunoSymbol(.chevronUp)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
      .disabled(model.matches.isEmpty)
      .accessibilityLabel("Previous match")
      Button {
        model.next()
      } label: {
        JunoSymbol(.chevronDown)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
      .disabled(model.matches.isEmpty)
      .accessibilityLabel("Next match")
      Button("Done") { model.close() }
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.mobile.find-done")
    }
    .buttonStyle(.borderless)
    .padding(.leading, JunoSpace.regular)
    .padding(.trailing, JunoSpace.snug)
    .background(.bar)
    .overlay(alignment: .bottom) { Divider() }
    .onAppear { focused = true }
  }
}

/// What a message row draws, as find counts it. Kept beside the bar so the
/// two cannot drift: the row's text parts in order, each one's prose runs.
enum JunoMobileTranscriptFind {
  static func count(of query: String, in message: NativeChatMessage) -> Int {
    switch message.role {
    case .user:
      return JunoFindText.count(of: query, in: NativeMessageContent.plainText(of: message.content))
    case .assistant:
      return bases(of: query, in: rowContent(message)).total
    case .system, .tool:
      return 0
    }
  }

  /// The content an assistant row renders: its answer without the trailing
  /// Sources section the row draws as favicons instead.
  static func rowContent(_ message: NativeChatMessage) -> String {
    message.sources.isEmpty
      ? message.content
      : NativeMessageContent.strippingTrailingSourcesSection(message.content)
  }

  /// Where each part's matches start within the message, and the total.
  static func bases(of query: String, in content: String) -> (bases: [Int], total: Int) {
    var running = 0
    let bases = NativeMessageContent.parts(of: content).map { part -> Int in
      defer {
        if case .text(let text) = part {
          running += JunoFindText.count(of: query, inLesson: text)
        }
      }
      return running
    }
    return (bases, running)
  }
}

extension View {
  /// Puts the find bar under the navigation bar while find is open, keeps the
  /// count in step with the transcript, and scrolls the current match's
  /// message into view.
  func junoTranscriptFind(
    _ find: JunoFindModel,
    messages: [NativeChatMessage],
    signature: Int,
    follows: Binding<Bool>,
    scrollPosition: Binding<ScrollPosition>
  ) -> some View {
    modifier(
      JunoMobileTranscriptFindModifier(
        find: find, messages: messages, signature: signature,
        follows: follows, scrollPosition: scrollPosition
      )
    )
  }
}

private struct JunoMobileTranscriptFindModifier: ViewModifier {
  let find: JunoFindModel
  let messages: [NativeChatMessage]
  let signature: Int
  @Binding var follows: Bool
  @Binding var scrollPosition: ScrollPosition

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .safeAreaBar(edge: .top, spacing: 0) {
        if find.isOpen {
          JunoMobileFindBar(model: find)
            .transition(.opacity)
        }
      }
      .onChange(of: find.isOpen) { _, open in
        if open { attachSource() }
      }
      .onChange(of: signature) { _, _ in
        if find.isOpen { attachSource() }
      }
      #if DEBUG
        // `--juno-preview-find <query>` opens the bar on the preview
        // conversation with that query, for screenshots.
        .task {
          let arguments = CommandLine.arguments
          guard let index = arguments.firstIndex(of: "--juno-preview-find"), index + 1 < arguments.count,
            !find.isOpen
          else { return }
          find.open()
          find.query = arguments[index + 1]
        }
      #endif
      .onChange(of: find.currentMatch) { _, match in
        guard let match else { return }
        // Stepping to a match is the reader leaving the end of the thread:
        // the stream must not pull them back down under it.
        follows = false
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
          scrollPosition.scrollTo(id: match.itemID, anchor: .center)
        }
      }
  }

  private func attachSource() {
    let snapshot = messages
    find.setSource { query in
      snapshot.map { ($0.id, JunoMobileTranscriptFind.count(of: query, in: $0)) }
    }
  }
}
