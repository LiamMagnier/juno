import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import SwiftUI

// MARK: - The model selector
//
// The phone's catalogue, rebuilt (owner, Oct 10: "first choose your AI labs,
// then the model"). It replaced one inset-grouped list of every model under
// its lab's heading — a single scroll several screens long.
//
// Two levels, in a native sheet:
//
// 1. **Models** — Auto on its own, the last few models picked, then the labs
//    as a grid of tiles (mark, name, how many models, or the model in use).
//    A modality filter (Text · Image · Video · Audio) sits on top whenever
//    the catalogue carries more than one kind.
// 2. **A lab** — that lab's models, current generation first, its past
//    generations folded behind "Past models", with the same filter where the
//    lab ships more than one kind.
//
// Search in the bar searches every lab at once and answers in place, grouped
// by lab. Every grouping rule — lab order, which row is Auto, what a search
// matches, modality order and labels, recents — is the Mac's and the web's,
// read from ``JunoModelSelectorCatalog`` over ``JunoModelDescriptor``s rather
// than restated here. Only the layout is the phone's.

/// The phone's model catalogue. Presented as a sheet by the composer.
struct JunoMobileModelSelectorView: View {
  let models: [NativeChatModelOption]
  let selectedModelID: String
  let onSelect: (NativeChatModelOption) -> Void

  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var query = ""
  /// The kind of model the root is showing; nil is every kind.
  @State private var modality: JunoModelModality?
  @State private var path: [String] = []
  @State private var pickHaptic = JunoMobileHapticTrigger()
  /// Shared with the Mac's selector: the web's `juno:models:recent`.
  @AppStorage(JunoModelRecents.key) private var recentsRaw = ""

  init(
    models: [NativeChatModelOption],
    selectedModelID: String,
    onSelect: @escaping (NativeChatModelOption) -> Void
  ) {
    self.models = models
    self.selectedModelID = selectedModelID
    self.onSelect = onSelect
    self.descriptors = models.map(\.junoDescriptor)
  }

  private let descriptors: [JunoModelDescriptor]

  var body: some View {
    NavigationStack(path: $path) {
      root
        .navigationTitle("Models")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          JunoMobileSheetClose(label: "Done", identifier: "juno.mobile.model-close") { dismiss() }
        }
        .navigationDestination(for: String.self) { labID in
          if let lab = lab(labID) {
            JunoMobileModelLabPage(
              lab: lab,
              models: descriptors.filter { $0.providerID == labID },
              selectedModelID: selectedModelID,
              initialModality: modality,
              choose: choose
            )
          }
        }
        .searchable(
          text: $query,
          placement: .navigationBarDrawer(displayMode: .always),
          prompt: "Search models"
        )
    }
    .tint(Color.junoForeground)
    .junoHaptic(JunoMobileHaptic.selection, trigger: pickHaptic)
    .task { applyPreviewFlags() }
  }

  // MARK: Root

  @ViewBuilder
  private var root: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: JunoSpace.section) {
        if presentModalities.count > 1 {
          JunoMobileModalityBar(modalities: presentModalities, selection: $modality)
            .accessibilityIdentifier("juno.mobile.model-modality")
        }
        if JunoModelSelectorCatalog.isSearching(query) {
          searchResults
        } else {
          landing
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.region)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: modality)
    }
    .scrollDismissesKeyboard(.interactively)
    .accessibilityIdentifier("juno.mobile.model-list")
  }

  @ViewBuilder
  private var landing: some View {
    if let auto, modality == nil || modality == .chat {
      JunoMobileModelCard {
        JunoMobileModelRow(
          model: auto,
          selected: auto.id == selectedModelID,
          showsMark: true,
          detail: auto.summary ?? "Picks the right model for each message",
          choose: { choose(auto) }
        )
      }
    }

    if !recentModels.isEmpty {
      JunoMobileModelSection(title: "Recent") {
        JunoMobileModelCard {
          ForEach(Array(recentModels.enumerated()), id: \.element.id) { index, model in
            if index > 0 { JunoMobileModelDivider(inset: true) }
            JunoMobileModelRow(
              model: model,
              selected: model.id == selectedModelID,
              showsMark: true,
              choose: { choose(model) }
            )
          }
        }
      }
    }

    if modality == nil || modality == .chat {
      JunoMobileModelSection(title: "Labs") {
        LazyVGrid(
          columns: Array(
            repeating: GridItem(.flexible(), spacing: JunoSpace.snug, alignment: .top),
            count: JunoMobileModelSelectorMetrics.labColumns
          ),
          spacing: JunoSpace.snug
        ) {
          ForEach(labs) { lab in
            NavigationLink(value: lab.id) {
              JunoMobileLabTile(
                lab: lab,
                inUse: selectedLabID == lab.id ? selected?.displayName : nil
              )
            }
            .buttonStyle(.junoQuietPress)
            .accessibilityIdentifier("juno.mobile.model-lab.\(lab.id)")
          }
        }
        .accessibilityIdentifier("juno.mobile.model-labs")
      }
    }

    // Pictures and video in sections of their own, across every lab, each
    // row with its lab's mark (owner, Oct 10). Picking one sends the turn
    // through /api/generate, as the web's composer does.
    ForEach(JunoModelSelectorCatalog.mediaGroups(visible)) { group in
      JunoMobileModelSection(title: group.label) {
        JunoMobileModelCard {
          JunoMobileModelRows(
            rows: group.current + group.legacy,
            selectedModelID: selectedModelID,
            showsMark: true,
            choose: choose
          )
        }
      }
      .accessibilityIdentifier("juno.mobile.model-section.\(group.id)")
    }
  }

  /// Every lab at once, grouped the Mac's way, with no folds: a match never
  /// hides behind "Past models".
  @ViewBuilder
  private var searchResults: some View {
    let groups = JunoModelSelectorCatalog.groups(models: visible, filter: .all, query: query)
    if groups.isEmpty {
      ContentUnavailableView.search(text: query)
        .frame(maxWidth: .infinity, minHeight: 240)
        .accessibilityIdentifier("juno.mobile.model-no-results")
    } else {
      ForEach(groups) { group in
        JunoMobileModelSection(
          title: group.showsLabel ? group.label : nil,
          mark: group.showsLabel ? group.id : nil
        ) {
          JunoMobileModelCard {
            JunoMobileModelRows(
              rows: group.current + group.legacy,
              selectedModelID: selectedModelID,
              showsMark: group.id == "auto:",
              choose: choose
            )
          }
        }
      }
    }
  }

  // MARK: Choosing

  private func choose(_ model: JunoModelDescriptor) {
    guard model.unavailabilityReason == nil,
      let option = models.first(where: { $0.id == model.id })
    else { return }
    if !JunoModelSelectorCatalog.isAuto(model) {
      recentsRaw = JunoModelRecents.recording(model.id, in: recentsRaw)
    }
    pickHaptic.fire()
    onSelect(option)
  }

  // MARK: Data

  /// The catalogue, narrowed to the chosen kind.
  private var visible: [JunoModelDescriptor] {
    guard let modality else { return descriptors }
    return descriptors.filter { $0.modality == modality || JunoModelSelectorCatalog.isAuto($0) && modality == .chat }
  }

  private var auto: JunoModelDescriptor? { descriptors.first(where: JunoModelSelectorCatalog.isAuto) }

  private var selected: JunoModelDescriptor? { descriptors.first { $0.id == selectedModelID } }

  private var selectedLabID: String? {
    guard let selected, !JunoModelSelectorCatalog.isAuto(selected), selected.modality == .chat else { return nil }
    return selected.providerID
  }

  /// The kinds the catalogue actually carries, in the web's order.
  private var presentModalities: [JunoModelModality] {
    JunoMobileModelSelectorView.modalities(in: descriptors)
  }

  static func modalities(in models: [JunoModelDescriptor]) -> [JunoModelModality] {
    let kinds = Set(models.filter { !JunoModelSelectorCatalog.isAuto($0) }.map(\.modality))
    return [JunoModelModality.chat, .image, .video, .audio].filter(kinds.contains)
  }

  /// The labs grid: the labs' text models; pictures and video have their
  /// own sections below it.
  private var labs: [JunoModelSelectorCatalog.Lab] {
    JunoModelSelectorCatalog.labs(in: visible.filter { $0.modality == .chat })
  }

  private func lab(_ id: String) -> JunoModelSelectorCatalog.Lab? {
    // Every kind the lab ships counts on its own page.
    JunoModelSelectorCatalog.labs(in: descriptors).first { $0.id == id }
  }

  /// The last three picked, still in the catalogue and of the chosen kind.
  private var recentModels: [JunoModelDescriptor] {
    JunoModelRecents.ids(in: recentsRaw).compactMap { id in
      visible.first { $0.id == id && !JunoModelSelectorCatalog.isAuto($0) }
    }
  }

  private func applyPreviewFlags() {
    #if DEBUG
    if let search = JunoComposerPreviewFlags.modelSearch { query = search }
    if let raw = JunoComposerPreviewFlags.value("--juno-preview-model-modality") {
      modality = JunoModelModality(raw: raw)
    }
    if let lab = JunoComposerPreviewFlags.modelProvider, path.isEmpty { path = [lab] }
    #endif
  }

  // MARK: Names

  static func isOwnProvider(_ id: String) -> Bool {
    let lower = id.lowercased()
    return lower == "juno" || lower == "alevr"
  }

  /// The lab alone ("Anthropic · Claude" → "Anthropic"), and never the old
  /// product name: the router is Alevr's.
  static func labName(_ providerName: String) -> String {
    let short = shortProviderName(providerName)
    return short.caseInsensitiveCompare("Juno") == .orderedSame ? "Alevr" : short
  }

  /// Provider labels arrive as "Anthropic · Claude"; a tile only has room
  /// for the lab.
  static func shortProviderName(_ name: String) -> String {
    name.split(separator: "·").first
      .map { $0.trimmingCharacters(in: .whitespaces) } ?? name
  }
}

enum JunoMobileModelSelectorMetrics {
  /// Three tiles a row: the fourteen labs the web ships fit in five rows, one
  /// screen with Auto and Recent above them.
  static let labColumns = 3
  static let cardRadius: CGFloat = JunoSpace.section
  static let tileRadius: CGFloat = JunoSpace.roomy
  static let labMark: CGFloat = 26
  static let rowMark: CGFloat = 22
}

// MARK: - A lab

/// One lab's models: the current generation, then its past generations behind
/// a fold, filtered by kind where the lab ships more than one.
private struct JunoMobileModelLabPage: View {
  let lab: JunoModelSelectorCatalog.Lab
  let models: [JunoModelDescriptor]
  let selectedModelID: String
  let initialModality: JunoModelModality?
  let choose: (JunoModelDescriptor) -> Void

  @State private var modality: JunoModelModality?
  @State private var showsPast = false
  @State private var seeded = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var kinds: [JunoModelModality] { JunoMobileModelSelectorView.modalities(in: models) }

  private var shown: [JunoModelDescriptor] {
    guard let modality else { return models }
    return models.filter { $0.modality == modality }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: JunoSpace.section) {
        header
        if kinds.count > 1 {
          JunoMobileModalityBar(modalities: kinds, selection: $modality)
            .accessibilityIdentifier("juno.mobile.model-modality")
        }
        let groups = JunoModelSelectorCatalog.groups(
          models: shown, filter: .lab(lab.id), query: ""
        )
        ForEach(groups) { group in
          JunoMobileModelCard {
            JunoMobileModelRows(
              rows: group.current,
              selectedModelID: selectedModelID,
              showsMark: false,
              choose: choose
            )
          }
          if group.legacyCount > 0 {
            pastModels(group)
          }
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.snug)
      .padding(.bottom, JunoSpace.region)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: modality)
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: showsPast)
    }
    .navigationTitle(lab.name)
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("juno.mobile.model-lab-page")
    .onAppear {
      guard !seeded else { return }
      seeded = true
      if let initialModality, kinds.contains(initialModality) { modality = initialModality }
      // Open on the past generations when the model in use is one of them,
      // so the check is on screen.
      showsPast = models.contains { $0.id == selectedModelID && $0.isLegacy }
    }
  }

  private var header: some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoProviderMark(providerID: lab.id, providerName: lab.name, size: JunoSpace.region)
        .frame(width: JunoSpace.vast, height: JunoSpace.vast)
        .background(Color.primary.opacity(0.06), in: Circle())
      VStack(alignment: .leading, spacing: JunoSpace.micro) {
        Text(verbatim: lab.name)
          .junoFont(size: 22, relativeTo: .title2, weight: .semibold)
          .foregroundStyle(Color.junoForeground)
        Text(models.count == 1 ? "1 model" : "\(models.count) models")
          .junoFont(size: 15, relativeTo: .subheadline)
          .foregroundStyle(Color.junoSecondaryInk)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func pastModels(_ group: JunoModelSelectorCatalog.Group) -> some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      Button {
        showsPast.toggle()
      } label: {
        HStack(spacing: JunoSpace.tight) {
          Text("Past models")
            .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          Text(verbatim: "\(group.legacyCount)")
            .junoFont(size: 15, relativeTo: .subheadline)
            .monospacedDigit()
            .foregroundStyle(Color.junoTertiaryInk)
          Spacer(minLength: 0)
          JunoIconView(.chevronDown, size: 12)
            .foregroundStyle(Color.junoTertiaryInk)
            .rotationEffect(.degrees(showsPast ? 180 : 0))
        }
        .foregroundStyle(Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.regular)
        .frame(minHeight: JunoLayout.touchTarget)
        .contentShape(.rect)
      }
      .buttonStyle(.junoQuietPress)
      .accessibilityValue(showsPast ? Text("Expanded") : Text("Collapsed"))
      .accessibilityIdentifier("juno.mobile.model-legacy.\(group.id)")

      if showsPast {
        JunoMobileModelCard {
          JunoMobileModelRows(
            rows: group.legacy,
            selectedModelID: selectedModelID,
            showsMark: false,
            choose: choose
          )
        }
        .transition(.opacity.combined(with: .offset(y: -JunoSpace.tight)))
      }
    }
  }
}

// MARK: - Pieces

/// A section: a quiet heading (with the lab's mark in search results) over
/// its content.
private struct JunoMobileModelSection<Content: View>: View {
  var title: String?
  var mark: String?
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if let title {
        HStack(spacing: JunoSpace.tight) {
          if let mark {
            JunoProviderMark(providerID: mark, providerName: title, size: 14)
          }
          Text(verbatim: title)
            .junoFont(size: 13, relativeTo: .footnote, weight: .semibold)
        }
        .foregroundStyle(Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.hairline)
        .accessibilityAddTraits(.isHeader)
      }
      content()
    }
  }
}

/// Rows on one rounded card, the grouped-list shape drawn on the sheet's
/// own glass rather than on an opaque grouped background.
private struct JunoMobileModelCard<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(spacing: 0) { content() }
      .background(
        Color.primary.opacity(0.05),
        in: .rect(cornerRadius: JunoMobileModelSelectorMetrics.cardRadius, style: .continuous)
      )
      .clipShape(.rect(cornerRadius: JunoMobileModelSelectorMetrics.cardRadius, style: .continuous))
  }
}

private struct JunoMobileModelDivider: View {
  var inset: Bool

  var body: some View {
    Rectangle()
      .fill(Color.junoHairline)
      .frame(height: 0.5)
      .padding(.leading, inset ? JunoSpace.regular : 0)
      .accessibilityHidden(true)
  }
}

/// A catalogue group's rows: models, with a small kind heading wherever the
/// catalogue puts one (a lab shipping text and images).
private struct JunoMobileModelRows: View {
  let rows: [JunoModelSelectorCatalog.Row]
  let selectedModelID: String
  let showsMark: Bool
  let choose: (JunoModelDescriptor) -> Void

  var body: some View {
    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
      switch row {
      case .model(let model, _):
        if index > 0, rows[index - 1].model != nil { JunoMobileModelDivider(inset: true) }
        JunoMobileModelRow(
          model: model,
          selected: model.id == selectedModelID,
          showsMark: showsMark,
          choose: { choose(model) }
        )
      case .modality(let modality, let count, _):
        HStack(spacing: JunoSpace.tight) {
          JunoIconView(JunoMobileModalityBar.icon(modality), size: 12)
          Text(verbatim: JunoModelSelectorCatalog.modalityLabel(modality))
          Text(verbatim: "\(count)")
            .monospacedDigit()
            .foregroundStyle(Color.junoTertiaryInk)
          Spacer(minLength: 0)
        }
        .junoFont(size: 12, relativeTo: .caption, weight: .semibold)
        .foregroundStyle(Color.junoSecondaryInk)
        .padding(.horizontal, JunoSpace.regular)
        .padding(.top, index == 0 ? JunoSpace.cozy : JunoSpace.regular)
        .padding(.bottom, JunoSpace.micro)
        .accessibilityAddTraits(.isHeader)
      }
    }
  }
}

/// One model: its name, one line of what it is for, and the facts that
/// separate it from its siblings (context and price). A check when it is the
/// model in use, a lock and the plan when the account cannot reach it. Touch
/// and hold previews the full spec sheet.
private struct JunoMobileModelRow: View {
  let model: JunoModelDescriptor
  let selected: Bool
  var showsMark: Bool
  var detail: String? = nil
  let choose: () -> Void

  private var auto: Bool { JunoModelSelectorCatalog.isAuto(model) }
  private var reason: String? { model.unavailabilityReason }

  private var line: String? {
    if let detail { return detail }
    if let summary = model.summary, !summary.isEmpty { return summary }
    return JunoModelSelectorCatalog.capabilityLine(model)
  }

  private var facts: String? {
    guard !auto else { return nil }
    var parts: [String] = []
    if model.modality == .chat, let tokens = model.contextWindowTokens, tokens > 0 {
      parts.append("\(JunoModelFormatting.contextWindow(tokens)) context")
    }
    if let price = JunoModelSelectorCatalog.priceLabel(model) { parts.append(price) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  var body: some View {
    Button(action: choose) {
      HStack(alignment: .center, spacing: JunoSpace.cozy) {
        if showsMark {
          Group {
            if auto {
              JunoMark(size: JunoMobileModelSelectorMetrics.rowMark)
            } else {
              JunoProviderMark(
                providerID: model.providerID,
                providerName: model.providerName,
                size: JunoMobileModelSelectorMetrics.rowMark
              )
            }
          }
          .foregroundStyle(Color.junoForeground)
          .frame(width: JunoSpace.expanse, height: JunoSpace.expanse)
          .background(Color.primary.opacity(0.06), in: Circle())
        }
        VStack(alignment: .leading, spacing: JunoSpace.micro) {
          Text(verbatim: model.displayName)
            .junoFont(size: 17, relativeTo: .body, weight: selected ? .semibold : .medium)
            .foregroundStyle(Color.junoForeground)
            .lineLimit(1)
          if let reason {
            HStack(spacing: JunoSpace.hairline) {
              JunoIconView(.lock, size: 12)
              Text(verbatim: reason)
            }
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .foregroundStyle(Color.junoSecondaryInk)
          } else if let line {
            Text(verbatim: line)
              .junoFont(size: 14, relativeTo: .subheadline)
              .foregroundStyle(Color.junoSecondaryInk)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let facts {
            Text(verbatim: facts)
              .junoFont(size: 12, relativeTo: .caption)
              .monospacedDigit()
              .foregroundStyle(Color.junoTertiaryInk)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if selected {
          JunoIconView(.check, size: 16, weight: .bold)
            .foregroundStyle(Color.junoAccent)
            .accessibilityHidden(true)
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.vertical, JunoSpace.cozy)
      .frame(minHeight: JunoLayout.touchTarget)
      .background(selected ? Color.junoSelectedFill : Color.clear)
      .contentShape(.rect)
    }
    .buttonStyle(JunoMobileModelRowPress())
    .disabled(reason != nil)
    .opacity(reason == nil ? 1 : 0.6)
    .contextMenu {
      if reason == nil {
        Button(action: choose) {
          JunoIconLabel(verbatim: selected ? "In use" : "Use this model", icon: .check)
        }
        .disabled(selected)
      }
    } preview: {
      JunoModelSpecSheet(model: model)
        .padding(JunoSpace.regular)
        .frame(width: 340)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(JunoModelSelectorCatalog.accessibilityLabel(model))
    .accessibilityValue(selected ? Text("Selected") : Text(verbatim: ""))
    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    .accessibilityIdentifier("juno.mobile.model-row.\(model.id)")
  }
}

/// A row's press: the system's row highlight, which a plain button style
/// would drop.
private struct JunoMobileModelRowPress: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .overlay(Color.primary.opacity(configuration.isPressed ? 0.06 : 0))
  }
}

/// A lab: its mark, its name, and either how many models it has or, for the
/// lab in use, the model in use.
private struct JunoMobileLabTile: View {
  let lab: JunoModelSelectorCatalog.Lab
  let inUse: String?

  var body: some View {
    VStack(alignment: .leading, spacing: JunoSpace.snug) {
      HStack(alignment: .top) {
        JunoProviderMark(providerID: lab.id, providerName: lab.name, size: JunoMobileModelSelectorMetrics.labMark)
          .foregroundStyle(Color.junoForeground)
        Spacer(minLength: 0)
        if inUse != nil {
          JunoIconView(.check, size: 12, weight: .bold)
            .foregroundStyle(Color.junoAccent)
            .accessibilityHidden(true)
        }
      }
      Spacer(minLength: 0)
      VStack(alignment: .leading, spacing: 0) {
        Text(verbatim: lab.name)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .semibold)
          .foregroundStyle(Color.junoForeground)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
        Text(verbatim: inUse.map(JunoMobileModelSelectorView.compactName) ?? (lab.count == 1 ? "1 model" : "\(lab.count) models"))
          .junoFont(size: 12, relativeTo: .caption)
          .foregroundStyle(inUse == nil ? Color.junoSecondaryInk : Color.junoAccent)
          .lineLimit(1)
      }
    }
    .padding(JunoSpace.cozy)
    .frame(maxWidth: .infinity, minHeight: JunoMobileModelSelectorMetrics.tileHeight, alignment: .topLeading)
    .background(
      inUse == nil ? Color.primary.opacity(0.05) : Color.junoSelectedFill,
      in: .rect(cornerRadius: JunoMobileModelSelectorMetrics.tileRadius, style: .continuous)
    )
    .contentShape(.rect(cornerRadius: JunoMobileModelSelectorMetrics.tileRadius, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: lab.name))
    .accessibilityValue(Text(verbatim: inUse.map { "In use: \($0)" } ?? "\(lab.count) models"))
    .accessibilityAddTraits(.isButton)
  }
}

extension JunoMobileModelSelectorMetrics {
  /// A tile's height: the mark, air, and two lines of text.
  static let tileHeight: CGFloat = 96
}

extension JunoMobileModelSelectorView {
  /// A model's name without a leading vendor word the lab's mark already
  /// says: "Claude Opus 4.8" is "Opus 4.8" on Anthropic's tile.
  static func compactName(_ name: String) -> String {
    let words = name.split(separator: " ")
    guard words.count >= 2, vendorWords.contains(words[0].lowercased()) else { return name }
    return words.dropFirst().joined(separator: " ")
  }

  private static let vendorWords: Set<String> = [
    "claude", "anthropic", "openai", "google", "meta", "mistral", "xai", "deepseek",
  ]
}

/// The kind filter: capsules for All and each kind the catalogue carries, the
/// chosen one in ink. Calendar's capsule controls, scrolled when they do not
/// fit.
struct JunoMobileModalityBar: View {
  let modalities: [JunoModelModality]
  @Binding var selection: JunoModelModality?
  @State private var haptic = JunoMobileHapticTrigger()

  static func icon(_ modality: JunoModelModality) -> JunoIcon {
    switch modality {
    case .chat: .message
    case .image: .image
    case .video: .play
    case .audio: .audioLines
    }
  }

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: JunoSpace.snug) {
        chip(nil, label: "All", icon: nil)
        ForEach(modalities, id: \.self) { modality in
          chip(modality, label: JunoModelSelectorCatalog.modalityLabel(modality), icon: Self.icon(modality))
        }
      }
    }
    .scrollIndicators(.hidden)
    .scrollClipDisabled()
    .junoHaptic(JunoMobileHaptic.selection, trigger: haptic)
  }

  private func chip(_ value: JunoModelModality?, label: String, icon: JunoIcon?) -> some View {
    let on = selection == value
    return Button {
      guard selection != value else { return }
      haptic.fire()
      selection = value
    } label: {
      HStack(spacing: JunoSpace.tight) {
        if let icon { JunoIconView(icon, size: 14) }
        Text(verbatim: label)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
      }
      .foregroundStyle(on ? Color.junoCanvas : Color.junoForeground)
      .padding(.horizontal, JunoSpace.comfy)
      .frame(minHeight: JunoLayout.Control.compactHeight)
      .background(on ? Color.junoForeground : Color.primary.opacity(0.06), in: Capsule())
      .frame(minHeight: JunoLayout.touchTarget)
      .contentShape(Capsule())
    }
    .buttonStyle(.junoQuietPress)
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("juno.mobile.model-modality.\(value?.rawValue ?? "all")")
  }
}
