import JunoCodeCore
import JunoCodeKit
import JunoCodeRemote
import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// Code's home on the phone, after Codex's remote (owner, Oct 11): a row of
// scopes (All, Cloud, each paired computer), one plain Recents list across
// them, and a composer docked at the foot that starts a session where the
// scope points.
//
// Type: regular and medium only. Coral marks a session that is working or
// needs you, and nothing else. No pills, no dots, no "Online".

// MARK: - Scope

/// Where the home looks and where its composer starts work.
enum JunoMobileCodeScope: Hashable {
  case all
  case cloud
  case device(String)

  var deviceID: String? {
    if case .device(let id) = self { return id }
    return nil
  }

  /// "all", "cloud" or "device:<id>", for AppStorage.
  var stored: String {
    switch self {
    case .all: "all"
    case .cloud: "cloud"
    case .device(let id): "device:\(id)"
    }
  }

  init?(stored: String) {
    switch stored {
    case "all": self = .all
    case "cloud": self = .cloud
    default:
      guard stored.hasPrefix("device:") else { return nil }
      let id = String(stored.dropFirst("device:".count))
      guard !id.isEmpty else { return nil }
      self = .device(id)
    }
  }
}

/// A computer in the scope row and the composer's target menu.
struct JunoMobileCodeScopeDevice: Identifiable, Equatable {
  let id: String
  let name: String
  /// Reachable now (an unreachable one is greyed, never labelled).
  var reachable: Bool
  /// Something on it is working or waiting on you.
  var working: Bool
  /// Paired with this iPhone over the device link: it can take new sessions.
  var paired: Bool
  var icon: JunoIcon = .device
}

/// All, Cloud, then one chip per computer. The chosen one sits on a soft
/// glass capsule; the rest are plain text and icon.
struct JunoMobileCodeScopeBar<Overflow: View>: View {
  @Binding var scope: JunoMobileCodeScope
  let devices: [JunoMobileCodeScopeDevice]
  var cloudWorking = false
  var onPair: () -> Void
  @ViewBuilder var overflow: () -> Overflow

  @State private var haptic = JunoMobileHapticTrigger()
  @Namespace private var glassSpace

  var body: some View {
    HStack(spacing: 0) {
      ScrollView(.horizontal) {
        JunoGlass(spacing: JunoSpace.hairline) {
          HStack(spacing: JunoSpace.hairline) {
              chip(.all, title: "All", icon: nil, working: false, muted: false)
              chip(.cloud, title: "Cloud", icon: .cloud, working: cloudWorking, muted: false)
              ForEach(devices) { device in
                chip(.device(device.id), title: device.name, icon: device.icon, working: device.working, muted: !device.reachable)
              }
              if devices.allSatisfy({ !$0.paired }) {
                Button(action: onPair) {
                  HStack(spacing: JunoSpace.hairline + 2) {
                    JunoIconView(.scan, size: 14)
                    Text("Pair a Mac")
                  }
                  .font(.subheadline)
                  .foregroundStyle(Color.junoTertiaryInk)
                  .padding(.horizontal, JunoSpace.cozy)
                  .frame(height: 36)
                  .frame(minHeight: 44)
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("juno.mobile.code-scope-pair")
              }
          }
        }
        .padding(.horizontal, JunoSpace.regular)
      }
      .scrollIndicators(.hidden)
      .contentMargins(.vertical, JunoSpace.hairline, for: .scrollContent)
      overflow()
        .padding(.trailing, JunoSpace.snug)
    }
    .frame(minHeight: 44)
    .junoHaptic(JunoMobileHaptic.selection, trigger: haptic)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.code-scopes")
  }

  private func chip(_ value: JunoMobileCodeScope, title: String, icon: JunoIcon?, working: Bool, muted: Bool) -> some View {
    let selected = scope == value
    return Button {
      guard scope != value else { return }
      haptic.fire()
      scope = value
    } label: {
      HStack(spacing: JunoSpace.hairline + 2) {
        if let icon { JunoIconView(icon, size: 14) }
        Text(title).lineLimit(1)
        if working {
          ProgressView()
            .controlSize(.mini)
            .tint(Color.junoAccent)
            .accessibilityLabel("Working")
        }
      }
      .font(.subheadline.weight(selected ? .medium : .regular))
      .foregroundStyle(muted ? Color.junoTertiaryInk : (selected ? Color.primary : Color.junoSecondaryInk))
      .padding(.horizontal, JunoSpace.cozy)
      .frame(height: 36)
      .contentShape(Capsule())
      .modifier(JunoMobileScopeGlass(on: selected, namespace: glassSpace))
      .frame(minHeight: 44)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("juno.mobile.code-scope-\(value.stored)")
  }
}

/// The chosen scope's soft glass capsule; the others draw nothing behind.
/// One id for whichever chip holds it, so the bar's container moves the
/// capsule from chip to chip.
private struct JunoMobileScopeGlass: ViewModifier {
  let on: Bool
  let namespace: Namespace.ID
  func body(content: Content) -> some View {
    if on {
      content
        .glassEffect(.regular.interactive(), in: Capsule())
        .junoGlassID("selected-scope", in: namespace)
    } else {
      content
    }
  }
}

// MARK: - Recents

/// One row of Recents, whichever runner it lives on.
struct JunoMobileCodeRecent: Identifiable, Equatable {
  enum Source: Equatable {
    /// A run through `/api/code/tasks`: in the cloud, or queued to a computer.
    case cloud(taskID: String, deviceID: String?)
    case link(deviceID: String, session: CodeV2.SessionSummary)
    case relay(deviceID: String, sessionID: String)
  }

  let source: Source
  let title: String
  /// "Cloud", or the computer's name.
  let place: String
  let date: Date
  let status: CodeLinkSessionStatus

  var id: String {
    switch source {
    case .cloud(let id, _): "cloud:\(id)"
    case .link(let device, let session): "link:\(device):\(session.id)"
    case .relay(let device, let id): "relay:\(device):\(id)"
    }
  }

  var deviceID: String? {
    switch source {
    case .cloud(_, let device): device
    case .link(let id, _), .relay(let id, _): id
    }
  }

  var isCloud: Bool {
    if case .cloud(_, nil) = source { return true }
    return false
  }

  /// Needs you first; the rest newest first.
  static func ordered(_ rows: [JunoMobileCodeRecent]) -> [JunoMobileCodeRecent] {
    rows.sorted { a, b in
      let na = a.status == .needsYou, nb = b.status == .needsYou
      if na != nb { return na }
      if a.date != b.date { return a.date > b.date }
      return a.id < b.id
    }
  }

  /// The rows a scope shows, matching a search when there is one.
  static func visible(_ rows: [JunoMobileCodeRecent], scope: JunoMobileCodeScope, query: String) -> [JunoMobileCodeRecent] {
    let scoped = rows.filter { row in
      switch scope {
      case .all: true
      case .cloud: row.isCloud
      case .device(let id): row.deviceID == id
      }
    }
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let found = needle.isEmpty ? scoped : scoped.filter {
      $0.title.localizedCaseInsensitiveContains(needle) || $0.place.localizedCaseInsensitiveContains(needle)
    }
    return ordered(found)
  }
}

extension CodeLinkSessionStatus {
  /// A cloud run's state in the same words.
  init(cloud status: NativeCodeTaskStatus) {
    switch status {
    case .awaitingApproval: self = .needsYou
    case .queued, .running: self = .working
    case .failed: self = .failed
    case .done, .cancelled: self = .idle
    }
  }

  init(relay session: CodeRemoteSessionSummary) {
    if session.isAwaitingApproval { self = .needsYou }
    else if session.isRunning { self = .working }
    else if session.lastError != nil || session.currentStatus == "failed" { self = .failed }
    else { self = .idle }
  }
}

/// The title on one line; under it, the state when it asks something, and
/// where it runs. The time on the right, or a quiet spinner while it works.
struct JunoMobileCodeRecentRow: View {
  let recent: JunoMobileCodeRecent

  var body: some View {
    HStack(alignment: .center, spacing: JunoSpace.cozy) {
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(recent.title)
          .font(.body)
          .foregroundStyle(Color.primary)
          .lineLimit(1)
        HStack(spacing: JunoSpace.hairline) {
          if recent.status == .needsYou {
            JunoIconView(.hand, size: 12)
              .foregroundStyle(Color.junoAccentInk)
            Text("Needs you,").foregroundStyle(Color.junoAccentInk)
          } else if recent.status == .working {
            Text("Working,").foregroundStyle(Color.junoAccentInk)
          } else if recent.status == .failed {
            Text("Stopped,")
          } else if recent.status == .limited {
            Text("Paused,")
          }
          Text(recent.place)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
      }
      Spacer(minLength: JunoSpace.snug)
      if recent.status == .working {
        ProgressView()
          .controlSize(.small)
          .tint(Color.junoAccent)
      } else {
        Text(recent.date, format: .relative(presentation: .numeric, unitsStyle: .narrow))
          .font(.subheadline)
          .monospacedDigit()
          .foregroundStyle(Color.junoTertiaryInk)
      }
    }
    .padding(.vertical, JunoSpace.snug)
    .frame(minHeight: 52)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(recent.title), \(recent.status.words), \(recent.place)")
  }
}

/// The plain list: an optional search field and pairing line, Recents with
/// its compose glyph, the rows, and a quiet line when there is nothing.
struct JunoMobileCodeRecentsList<Leading: View>: View {
  let rows: [JunoMobileCodeRecent]
  var loading = false
  var emptyLine: String
  @Binding var query: String
  var searching: Bool
  /// Whether `leading` has anything to show (an empty row still takes room).
  var hasLeading = true
  var compose: () -> Void
  var open: (JunoMobileCodeRecent) -> Void
  var stop: (JunoMobileCodeRecent) -> Void
  var refresh: () async -> Void
  @ViewBuilder var leading: () -> Leading

  @FocusState private var searchFocused: Bool

  var body: some View {
    List {
      if hasLeading {
        leading()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: JunoSpace.regular, bottom: 0, trailing: JunoSpace.regular))
      }
      if searching {
        searchField
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: JunoSpace.hairline, leading: JunoSpace.regular, bottom: JunoSpace.hairline, trailing: JunoSpace.regular))
      }
      Section {
        if rows.isEmpty {
          Text(loading ? "Looking for sessions" : (query.isEmpty ? emptyLine : "Nothing matches \u{201C}\(query)\u{201D}"))
            .font(.subheadline)
            .foregroundStyle(Color.junoTertiaryInk)
            .padding(.vertical, JunoSpace.cozy)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("juno.mobile.code-recents-empty")
        }
        ForEach(rows) { recent in
          Button { open(recent) } label: { JunoMobileCodeRecentRow(recent: recent) }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: JunoSpace.regular, bottom: 0, trailing: JunoSpace.regular))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              if recent.status == .working {
                Button {
                  stop(recent)
                } label: {
                  Label("Stop", image: JunoIcon.circleStop.assetName(.regular))
                }
                .tint(Color.junoDanger)
              }
            }
            .accessibilityIdentifier("juno.mobile.code-recent-\(recent.id)")
        }
      } header: {
        HStack {
          Text("Recents")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.junoSecondaryInk)
          Spacer(minLength: 0)
          Button(action: compose) {
            JunoIconView(.compose, size: 17)
              .foregroundStyle(Color.junoSecondaryInk)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("New session")
          .accessibilityIdentifier("juno.mobile.code-compose")
        }
        .textCase(nil)
        .padding(.trailing, -JunoSpace.cozy)
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(0)
    .contentMargins(.top, 0, for: .scrollContent)
    .environment(\.defaultMinListHeaderHeight, 0)
    .scrollContentBackground(.hidden)
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await refresh() }
    .onChange(of: searching, initial: true) { _, now in searchFocused = now }
    .accessibilityIdentifier("juno.mobile.code-recents")
  }

  private var searchField: some View {
    HStack(spacing: JunoSpace.snug) {
      JunoIconView(.search, size: 15)
        .foregroundStyle(Color.junoTertiaryInk)
      TextField("Search sessions", text: $query)
        .font(.body)
        .focused($searchFocused)
        .submitLabel(.search)
        .accessibilityIdentifier("juno.mobile.code-search-field")
      if !query.isEmpty {
        Button { query = "" } label: {
          JunoIconView(.close, size: 12)
            .foregroundStyle(Color.junoSecondaryInk)
            .frame(width: 32, height: 32)
            // A 44pt touch in the glyph's 32pt of the row: the frame takes
            // the touch, the negative inset hands the extra width back.
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .padding(.horizontal, -JunoSpace.tight)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, JunoSpace.cozy)
    .frame(height: 44)
    .junoGlass(in: Capsule())
    .junoGlassSearchContainer()
  }
}

/// A computer this iPhone cannot start sessions on yet: one quiet line and a
/// text button, inline, never a slab.
struct JunoMobileCodePairLine: View {
  let name: String
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: JunoSpace.snug) {
      JunoIconView(.link, size: 14)
        .foregroundStyle(Color.junoSecondaryInk)
      Text("Pair this iPhone with \(name) to start sessions on it from here.")
        .font(.subheadline)
        .foregroundStyle(Color.junoSecondaryInk)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("Pair") { junoMobileRequestPairing() }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Color.primary)
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.mobile.code-pair-line")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("juno.mobile.code-not-paired")
  }
}

// MARK: - The docked composer

/// Where the dock's next session goes.
enum JunoMobileCodeTarget: Hashable {
  case cloud
  case device(String)

  var stored: String {
    switch self {
    case .cloud: "cloud"
    case .device(let id): "device:\(id)"
    }
  }

  init?(stored: String) {
    if stored == "cloud" { self = .cloud; return }
    guard stored.hasPrefix("device:") else { return nil }
    let id = String(stored.dropFirst("device:".count))
    guard !id.isEmpty else { return nil }
    self = .device(id)
  }
}

/// "Ask Alevr", always at the foot, floating over the list: one Liquid Glass
/// capsule with "+", the target (in All, its glyph and a short name), the
/// field and the microphone, as Codex's "+ Ask Codex mic". A tap opens the
/// full composer where the target lives (the empty thread on a Mac, in place
/// for Cloud); what "+" picks goes with it.
struct JunoMobileCodeDock: View {
  let target: JunoMobileCodeTarget
  let devices: [JunoMobileCodeScopeDevice]
  /// Draws the target menu (the scope is All).
  var showsTarget: Bool
  /// The home's attachment surfaces; nil draws no "+".
  var attachments: JunoMobileAttachmentCoordinator? = nil
  var canAttach = true
  var attachNote: String? = nil
  var choose: (JunoMobileCodeTarget) -> Void
  var open: (_ dictate: Bool) -> Void

  private var targetName: String {
    switch target {
    case .cloud: "Cloud"
    case .device(let id): devices.first { $0.id == id }?.name ?? "Mac"
    }
  }

  private var targetIcon: JunoIcon {
    switch target {
    case .cloud: .cloud
    case .device(let id): devices.first { $0.id == id }?.icon ?? .device
    }
  }

  /// "Liam's MacBook Pro" is too long for the capsule: its first word or two.
  static func shortName(_ name: String) -> String {
    guard name.count > 15 else { return name }
    let words = name.split(separator: " ")
    var out = ""
    for word in words {
      let next = out.isEmpty ? String(word) : out + " " + word
      if next.count > 15 { break }
      out = next
    }
    return out.isEmpty ? String(name.prefix(10)) : out
  }

  var body: some View {
    JunoGlass {
      HStack(spacing: 0) {
        if let attachments {
          JunoMobileLinkAttachMenu(coordinator: attachments, enabled: canAttach, note: attachNote)
            .accessibilityIdentifier("juno.mobile.code-dock-attach")
        }
        if showsTarget {
          Menu {
            Picker("Start on", selection: Binding(get: { target }, set: { choose($0) })) {
              Label("Cloud", image: JunoIcon.cloud.assetName(.regular))
                .tag(JunoMobileCodeTarget.cloud)
              ForEach(devices) { device in
                Label(device.name, image: device.icon.assetName(.regular))
                  .tag(JunoMobileCodeTarget.device(device.id))
              }
            }
            .pickerStyle(.inline)
          } label: {
            HStack(spacing: JunoSpace.hairline) {
              JunoIconView(targetIcon, size: 14)
              Text(Self.shortName(targetName))
                .lineLimit(1)
                .fixedSize()
              JunoIconView(.chevronDown, size: 9)
                .foregroundStyle(Color.junoTertiaryInk)
            }
            .font(.subheadline)
            .foregroundStyle(Color.junoSecondaryInk)
            .padding(.horizontal, JunoSpace.snug)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .tint(Color.primary)
          .accessibilityLabel("Start on \(targetName)")
          .accessibilityIdentifier("juno.mobile.code-dock-target")
        }
        Button {
          open(false)
        } label: {
          Text("Ask Alevr")
            .font(.body)
            .foregroundStyle(Color.junoTertiaryInk)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.leading, showsTarget || attachments != nil ? JunoSpace.hairline : JunoSpace.regular)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showsTarget ? "Ask Alevr on \(targetName)" : "Ask Alevr")
        .accessibilityIdentifier("juno.mobile.code-dock")
        if JunoSpeechService.isSupported {
          Button {
            open(true)
          } label: {
            JunoIconView(.mic, size: 19)
              .foregroundStyle(Color.junoSecondaryInk)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Dictate")
          .accessibilityIdentifier("juno.mobile.code-dock-dictate")
        }
      }
      .padding(.horizontal, JunoSpace.hairline)
      .frame(minHeight: 52)
      .junoGlass(in: Capsule())
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.bottom, JunoSpace.snug)
    // No slab: the list runs under the glass, with a soft fade at the foot
    // so a row passing behind never reads through the field.
    .background(alignment: .bottom) {
      LinearGradient(
        stops: [
          .init(color: Color.junoCanvas.opacity(0), location: 0),
          .init(color: Color.junoCanvas.opacity(0.8), location: 0.45),
          .init(color: Color.junoCanvas.opacity(0.92), location: 1),
        ],
        startPoint: .top, endPoint: .bottom
      )
      .padding(.top, -JunoSpace.section)
      .ignoresSafeArea(edges: .bottom)
      .allowsHitTesting(false)
    }
  }
}
