import JunoCodeCore
import JunoCodeRemote
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

// The iPhone remote for Mac Alevr Code over the v2 device link
// (docs/code-v2/REMOTE-CONTROL.md): the Macs this iPhone is paired with, each
// Mac's sessions with their state in words, and the way back to pairing when
// a Mac refuses this iPhone.
//
// Type on these screens: regular and medium only. Coral marks two states and
// nothing else: a session that is working, and one that needs you.

/// One remote model per app run, so leaving Code and coming back keeps the
/// open thread, its cursor and the Mac's catalogue.
@MainActor
enum JunoMobileLinkModels {
  private static var shared: CodeLinkRemoteModel?

  static func model(for sender: (any NativeAuthenticatedRequestSending)?) -> CodeLinkRemoteModel? {
    if let shared { return shared }
    guard let sender else { return nil }
    let model = CodeLinkRemoteModel(sender: sender)
    shared = model
    return model
  }

  #if DEBUG
  /// Snapshot tests and previews hand in a filled model.
  static func install(_ model: CodeLinkRemoteModel?) { shared = model }
  #endif
}

/// Opens the pairing sheet (the scanner): the one way to add a Mac.
@MainActor
func junoMobileRequestPairing() {
  JunoMobileLaunchRequests.shared.request(.pairRemote(token: nil))
}

// MARK: - Sessions

/// A paired Mac's sessions: what needs you first, then what is working, then
/// the rest, newest first.
struct JunoMobileLinkSessionsView: View {
  @Bindable var model: CodeLinkRemoteModel
  let mac: CodeLinkMac
  var newSession: () -> Void

  @Environment(\.junoThreadSync) private var threadSync

  /// The Mac's live state, or the backend's needs-you (set from the link's
  /// events, so an approval waiting on a session this iPhone has not opened shows).
  private func status(_ session: CodeV2.SessionSummary) -> CodeLinkSessionStatus {
    let live = model.remote.status(of: session.id)
    if live == .needsYou || live == .working { return live }
    if threadSync?.states[ThreadSyncKey.code(deviceID: mac.id, sessionID: session.id)]?.needsYou == true { return .needsYou }
    return live
  }

  var body: some View {
    Group {
      if let error = model.linkError, error.isNotPaired || error == .unpairedMac {
        ScrollView {
          JunoMobileLinkNotPaired(macName: mac.name, unknownMac: error == .unpairedMac)
            .padding(.horizontal, JunoSpace.regular)
            .padding(.top, JunoSpace.section)
        }
      } else {
        list
      }
    }
    .accessibilityIdentifier("juno.mobile.link-sessions")
  }

  private var needsYou: [CodeV2.SessionSummary] {
    model.orderedSessions.filter { status($0) == .needsYou }
  }
  private var working: [CodeV2.SessionSummary] {
    model.orderedSessions.filter { status($0) == .working }
  }
  private var rest: [CodeV2.SessionSummary] {
    model.orderedSessions.filter { !status($0).isLive }
  }

  private var list: some View {
    List {
      if case .offline(let message) = mac.reachability {
        JunoMobileLinkNotice(icon: .wifiOff, text: message)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
      }
      if model.orderedSessions.isEmpty {
        JunoMobileLinkEmpty(
          macName: mac.name,
          loading: model.isLoadingSessions,
          canStart: mac.reachability == .online,
          newSession: newSession
        )
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
      section("Needs you", needsYou)
      section("Working", working)
      section(needsYou.isEmpty && working.isEmpty ? nil : "Earlier", rest)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .refreshable {
      await model.loadSessions()
    }
  }

  @ViewBuilder
  private func section(_ title: String?, _ sessions: [CodeV2.SessionSummary]) -> some View {
    if !sessions.isEmpty {
      Section {
        ForEach(sessions) { session in
          Button {
            Task { await model.open(session.id) }
          } label: {
            JunoMobileLinkSessionRow(session: session, status: status(session))
          }
          .buttonStyle(.plain)
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets(top: 0, leading: JunoSpace.regular, bottom: 0, trailing: JunoSpace.regular))
          .accessibilityIdentifier("juno.mobile.link-session-\(session.id)")
        }
      } header: {
        if let title {
          Text(title)
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.junoSecondaryInk)
            .textCase(nil)
        }
      }
    }
  }
}

/// Glyph, title, and one quiet line: the state in words, the folder, when.
struct JunoMobileLinkSessionRow: View {
  let session: CodeV2.SessionSummary
  let status: CodeLinkSessionStatus

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.cozy) {
      glyph
        .frame(width: 22)
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(session.title ?? "Untitled session")
          .font(.body)
          .foregroundStyle(.primary)
          .lineLimit(2)
        HStack(spacing: JunoSpace.hairline) {
          Text(status.words)
            .foregroundStyle(status.isLive ? Color.junoAccent : Color.junoSecondaryInk)
          Text("in").foregroundStyle(Color.junoTertiaryInk)
          Text(CodeLinkFolderBrowser.name(of: session.cwd))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .lineLimit(1)
      }
      Spacer(minLength: JunoSpace.snug)
      if let date = CodeV2Dates.parse(session.updatedAt) {
        Text(date, format: .relative(presentation: .numeric, unitsStyle: .narrow))
          .font(.subheadline)
          .monospacedDigit()
          .foregroundStyle(Color.junoTertiaryInk)
      }
    }
    .padding(.vertical, JunoSpace.cozy)
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(session.title ?? "Untitled session"), \(status.words)")
  }

  @ViewBuilder
  private var glyph: some View {
    switch status {
    case .needsYou:
      JunoIconView(.hand, size: 16).foregroundStyle(Color.junoAccent)
    case .working:
      ProgressView().controlSize(.small).tint(Color.junoAccent)
    case .limited:
      JunoIconView(.hourglass, size: 16).foregroundStyle(Color.junoSecondaryInk)
    case .failed:
      JunoIconView(.triangleAlert, size: 16).foregroundStyle(Color.junoSecondaryInk)
    case .idle:
      JunoIconView(.code, size: 16).foregroundStyle(Color.junoTertiaryInk)
    }
  }
}

/// A quiet one-line notice above the list (offline, a refused action).
struct JunoMobileLinkNotice: View {
  let icon: JunoIcon
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
      JunoIconView(icon, size: 14).foregroundStyle(Color.junoSecondaryInk)
      Text(text)
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, JunoSpace.snug)
  }
}

struct JunoMobileLinkEmpty: View {
  let macName: String
  var loading = false
  var canStart = true
  let newSession: () -> Void

  var body: some View {
    VStack(spacing: JunoSpace.cozy) {
      JunoIconView(.device, size: 30)
        .foregroundStyle(Color.junoTertiaryInk)
      Text(loading ? "Asking \(macName) for its sessions" : "Nothing running on \(macName)")
        .font(.title3)
        .multilineTextAlignment(.center)
      Text("Start a session in any folder \(macName) shares with Remote. It runs on the Mac, with your subscriptions and your tools.")
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
      if canStart, !loading {
        Button(action: newSession) {
          Text("New session").font(.body.weight(.medium)).padding(.horizontal, JunoSpace.cozy)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
        .frame(minHeight: 44)
        .padding(.top, JunoSpace.snug)
        .accessibilityIdentifier("juno.mobile.link-new-empty")
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, JunoSpace.section * 2)
  }
}

/// The Mac refused this iPhone: say so, and offer the one thing that fixes it.
struct JunoMobileLinkNotPaired: View {
  let macName: String
  var unknownMac = false

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
      JunoIconView(.link, size: 26)
        .foregroundStyle(Color.junoSecondaryInk)
      Text(unknownMac ? "\(macName) is no longer on your account" : "Pair this iPhone with \(macName)")
        .font(.title3)
      Text(unknownMac
        ? "Open Alevr on the Mac and sign in again, then pair it from Settings, Connections."
        : "On \(macName), open Alevr, then Settings, Connections, Control this Mac remotely. Scan the code it shows with this iPhone.")
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .fixedSize(horizontal: false, vertical: true)
      if !unknownMac {
        Button {
          junoMobileRequestPairing()
        } label: {
          HStack(spacing: JunoSpace.snug) {
            JunoIconView(.scan, size: 16)
            Text("Scan the code on \(macName)")
          }
          .font(.body.weight(.medium))
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
        .padding(.top, JunoSpace.snug)
        .accessibilityIdentifier("juno.mobile.link-pair-again")
      }
    }
    .padding(JunoSpace.regular)
    .junoGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    .frame(maxWidth: JunoMobileMeasure.reading)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.link-not-paired")
  }
}

/// No Mac paired over the link yet: what the remote does, and Pair a Mac.
struct JunoMobileLinkPairPrompt: View {
  var body: some View {
    VStack(spacing: JunoSpace.cozy) {
      JunoIconView(.device, size: 30)
        .foregroundStyle(Color.junoTertiaryInk)
      Text("Drive Alevr on your Mac from here")
        .font(.title3)
        .multilineTextAlignment(.center)
      Text("Start sessions in your Mac's folders, answer its approvals, review and revert its changes, and ship them, all from this iPhone.")
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
      Button {
        junoMobileRequestPairing()
      } label: {
        Text("Pair a Mac").font(.body.weight(.medium)).padding(.horizontal, JunoSpace.cozy)
      }
      .buttonStyle(.glass)
      .controlSize(.large)
      .frame(minHeight: 44)
      .padding(.top, JunoSpace.snug)
      .accessibilityIdentifier("juno.mobile.link-pair")
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, JunoSpace.section)
  }
}
