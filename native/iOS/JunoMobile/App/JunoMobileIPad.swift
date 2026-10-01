import JunoDesignSystem
import SwiftUI
import UIKit

// The iPad's own pieces (docs/design/premium-pass/ios/ipad/).
//
// On a regular-width window the shell is one `NavigationSplitView`: the Mac's
// sidebar grammar on the left (monochrome 16pt glyphs, plain section headers,
// the account in the footer) and the destination on the right, held to a
// reading measure. On a compact window (iPhone, Slide Over, a narrow Stage
// Manager window) it is the phone's tab bar. Everything here is the regular
// half; the compact half lives where it always has.

// MARK: - Reading measure

/// Widths the iPad keeps content to, so a 13-inch landscape window reads like
/// a page rather than a banner.
enum JunoMobileMeasure {
  /// The transcript's column, the web's `max-w-3xl` plus its gutters.
  static let reading: CGFloat = 768
  /// The new-chat home: greeting, composer and starting points as one block.
  static let home: CGFloat = 720
}

// MARK: - Keyboard

/// What the shell can be asked to do from the keyboard. Published by the
/// root as a scene value and read by ``JunoMobileCommands``, so the menu bar
/// and the hold-Command overlay drive the same functions the sidebar does.
struct JunoMobileShellActions {
  var newChat: () -> Void
  var newIncognitoChat: (() -> Void)?
  var search: () -> Void
  var settings: () -> Void
  var show: (JunoMobileSection) -> Void
}

extension FocusedValues {
  @Entry var junoShellActions: JunoMobileShellActions?
}

/// The iPad's menu bar and keyboard shortcuts.
///
/// Every button is inside a `Section`: menu-bar rows are drawn by the system at
/// its own metrics, which is what the targets gate's system-drawn rule means.
struct JunoMobileCommands: Commands {
  @FocusedValue(\.junoShellActions) private var actions

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Section {
        Button("New Chat") { actions?.newChat() }
          .keyboardShortcut("n", modifiers: .command)
          .disabled(actions == nil)
        Button("New Incognito Chat") { actions?.newIncognitoChat?() }
          .keyboardShortcut("n", modifiers: [.command, .shift])
          .disabled(actions?.newIncognitoChat == nil)
      }
    }
    CommandGroup(replacing: .appSettings) {
      Section {
        Button("Settings…") { actions?.settings() }
          .keyboardShortcut(",", modifiers: .command)
          .disabled(actions == nil)
      }
    }
    CommandMenu("Go") {
      Section {
        Button("Search") { actions?.search() }
          .keyboardShortcut("k", modifiers: .command)
          .disabled(actions == nil)
      }
      Section {
        Button("Chat") { actions?.show(.chat) }
          .keyboardShortcut("1", modifiers: .command)
        Button("Crew") { actions?.show(.agents) }
          .keyboardShortcut("2", modifiers: .command)
        Button("Code") { actions?.show(.code) }
          .keyboardShortcut("3", modifiers: .command)
      }
      .disabled(actions == nil)
      Section {
        Button("Projects") { actions?.show(.projects) }
        Button("Library") { actions?.show(.library) }
        Button("Artifacts") { actions?.show(.artifacts) }
        Button("Crew") { actions?.show(.agents) }
      }
      .disabled(actions == nil)
    }
  }
}

// MARK: - Sidebar rows

/// What a product row says about itself, as plain text beside its name.
///
/// Attention is colour plus a symbol; work in progress is a shimmer on the
/// words. Never a pill, never a dot.
struct JunoMobileSidebarStatus: Equatable {
  var running: Int = 0
  var needsYou: Int = 0

  var isEmpty: Bool { running == 0 && needsYou == 0 }
}

/// A sidebar row's face: 16pt monochrome glyph, label, optional trailing
/// status, and the selected wash. The Mac's row, at a touch height.
struct JunoMobileIPadSidebarRowLabel: View {
  let icon: JunoIcon
  let title: LocalizedStringKey
  var selected: Bool = false
  var status: JunoMobileSidebarStatus?

  var body: some View {
    HStack(spacing: 10) {
      JunoIconView(icon, size: 16)
        .frame(width: 20)
        // The only accent in the sidebar: the selected row's glyph.
        .foregroundStyle(selected ? Color.junoAccent : Color.junoSidebarForeground)
      Text(title)
        .junoFont(size: 15, relativeTo: .body, weight: selected ? .medium : .regular)
        .foregroundStyle(Color.junoForeground)
        .lineLimit(1)
      Spacer(minLength: 4)
      if let status, !status.isEmpty {
        JunoMobileSidebarStatusText(status: status)
      }
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 44)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(selected ? Color.junoSelectedFill : .clear)
    )
    .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 8, style: .continuous))
    .hoverEffect(.highlight)
  }
}

/// A product row's trailing words. Attention wins: a run waiting on you is
/// the thing to say, and how many others are running can wait.
struct JunoMobileSidebarStatusText: View {
  let status: JunoMobileSidebarStatus

  var body: some View {
    if status.needsYou > 0 {
      HStack(spacing: 3) {
        Image(systemName: "exclamationmark.circle")
          .imageScale(.small)
        Text(verbatim: "\(status.needsYou)")
          .monospacedDigit()
      }
      .font(.footnote.weight(.medium))
      .foregroundStyle(Color.junoCaution)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(status.needsYou) waiting on you")
    } else if status.running > 0 {
      JunoShimmerText("\(status.running) running", font: .footnote)
        .accessibilityLabel("\(status.running) running")
    }
  }
}

/// One sidebar destination or action.
struct JunoMobileIPadSidebarRow: View {
  let icon: JunoIcon
  let title: LocalizedStringKey
  var selected: Bool = false
  var status: JunoMobileSidebarStatus?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      JunoMobileIPadSidebarRowLabel(icon: icon, title: title, selected: selected, status: status)
    }
    .buttonStyle(JunoSidebarPressStyle())
    .frame(minWidth: 44, minHeight: 44)
    .contentShape(.rect(cornerRadius: 8))
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

// MARK: - Composer placement

/// Where the draft's composer goes: docked to the bottom edge on a phone,
/// in the centred home block on an iPad (the block places it itself).
struct JunoMobileDockedComposer<Bar: View>: ViewModifier {
  let docked: Bool
  @ViewBuilder let bar: () -> Bar

  func body(content: Content) -> some View {
    if docked {
      content.junoComposerBar(bar)
    } else {
      content
    }
  }
}
