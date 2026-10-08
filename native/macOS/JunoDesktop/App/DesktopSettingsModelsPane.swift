import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Settings › Models (`sections/models.tsx`): the default model, what each new
/// message starts with on this Mac, and the pinned favorites.
///
/// "On this device" holds only what the composer stores on this Mac: Fast
/// mode, under the composer's own key. The web's Thinking effort and Web
/// search rows are not shown until the composer keeps a stored default for
/// them — a switch here would change nothing (P3-25).
struct DesktopSettingsModelsPane: View {
    let context: DesktopSettingsContext

    /// The composer's own key (`ChatComposer.swift`), so the two stay one.
    @AppStorage("juno.desktop.composer.fast-mode") private var fastMode = false
    @State private var isChoosingDefault = false

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            Section {
                defaultModelRow(settings)
            }

            Section {
                autoPreferenceRow(settings)
                autoDataBoundaryRow(settings)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Auto",
                    note: "How Auto chooses when it picks the model for you. Choosing a model yourself always overrides it."
                )
            }

            Section {
                DesktopSettingToggleRow(
                    title: "Fast mode",
                    description: "Prefer the quickest capable model and skip extended thinking.",
                    status: context.saves.status("fastMode"),
                    isOn: Binding(
                        get: { fastMode },
                        set: { value in
                            fastMode = value
                            context.saves.mark("fastMode", ok: true)
                        }
                    ),
                    identifier: "juno.desktop.settings.fast-mode"
                )
            } header: {
                DesktopSettingsGroupHeader(
                    title: "On this device",
                    note: "Where each new message starts on this Mac. The composer can change any of them."
                )
            }

            Section {
                favoriteRows(settings)
            } header: {
                DesktopSettingsGroupHeader(
                    title: "Favorites",
                    note: "Pinned models lead the model picker, in this order."
                ) {
                    HStack(spacing: JunoSpace.cozy) {
                        DesktopSaveStatus(state: context.saves.status("favoriteModels"))
                        addMenu(settings)
                    }
                }
            }
        }
    }

    // MARK: Default model

    private var descriptors: [JunoModelDescriptor] {
        context.modelCatalog.map(\.junoDescriptor)
    }

    private func isAuto(_ id: String) -> Bool {
        id == "auto" || id == "juno:auto"
    }

    private func defaultModelRow(_ settings: NativeAccountSettings) -> some View {
        let auto = isAuto(settings.defaultModel)
        let selected = descriptors.first { $0.id == settings.defaultModel }
        return DesktopSettingRow(
            title: "Default model",
            description: auto
                ? "Alevr picks the model and thinking depth each message needs."
                : "New chats start on this model. You can switch in any message.",
            status: context.saves.status("defaultModel")
        ) {
            Button {
                isChoosingDefault = true
            } label: {
                HStack(spacing: JunoSpace.snug) {
                    JunoProviderMark(
                        providerID: selected?.providerID ?? "juno",
                        providerName: selected?.providerName ?? "Alevr",
                        size: 16
                    )
                    Text(auto ? "Auto" : (selected?.displayName ?? junoDisplayModelName(settings.defaultModel)))
                        .junoType(.ui)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    JunoIconView(.chevronsUpDown, size: 12)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                .frame(width: 208)
                .contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .tint(nil)
            .disabled(context.modelCatalog.isEmpty)
            .accessibilityLabel("Default model")
            .accessibilityValue(auto ? "Auto" : (selected?.displayName ?? settings.defaultModel))
            .accessibilityIdentifier("juno.desktop.settings.default-model")
            // Dismissed with its anchor, always: a popover whose anchor leaves
            // the hierarchy while presented has crashed this app before.
            .onDisappear { isChoosingDefault = false }
            .popover(isPresented: $isChoosingDefault, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
                JunoModelSelector(
                    models: descriptors,
                    selectedModelID: settings.defaultModel,
                    select: { descriptor in
                        isChoosingDefault = false
                        guard descriptor.id != settings.defaultModel else { return }
                        context.save("defaultModel", NativeSettingsPatch(defaultModel: descriptor.id))
                    }
                )
                .frame(
                    width: JunoModelSelectorMetrics.standard.width,
                    height: JunoModelSelectorMetrics.standard.height
                )
            }
        }
    }

    // MARK: Auto

    private func autoPreferenceRow(_ settings: NativeAccountSettings) -> some View {
        let current = NativeAutoPreference.option(for: settings.autoPreference)
        return DesktopSettingRow(
            title: "Optimise for",
            description: current.description,
            status: context.saves.status("autoPreference")
        ) {
            Picker("What Auto optimises for", selection: Binding(
                get: { current.id },
                set: { value in
                    guard value != current.id else { return }
                    context.save("autoPreference", NativeSettingsPatch(autoPreference: value))
                }
            )) {
                ForEach(NativeAutoPreference.options) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(nil)
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.auto-preference")
        }
    }

    private func autoDataBoundaryRow(_ settings: NativeAccountSettings) -> some View {
        let current = NativeAutoDataBoundary.option(for: settings.autoDataBoundary)
        return DesktopSettingRow(
            title: "Labs Auto may use",
            description: current.description,
            status: context.saves.status("autoDataBoundary")
        ) {
            Picker("Labs Auto may use", selection: Binding(
                get: { current.id },
                set: { value in
                    guard value != current.id else { return }
                    context.save("autoDataBoundary", NativeSettingsPatch(autoDataBoundary: value))
                }
            )) {
                ForEach(NativeAutoDataBoundary.options) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(nil)
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.auto-data-boundary")
        }
    }

    // MARK: Favorites

    private func pinned(_ settings: NativeAccountSettings) -> [NativeChatModelOption] {
        settings.favoriteModels.compactMap { id in context.modelCatalog.first { $0.id == id } }
    }

    @ViewBuilder
    private func favoriteRows(_ settings: NativeAccountSettings) -> some View {
        let rows = pinned(settings)
        if rows.isEmpty {
            DesktopSettingsNote(text: "Nothing pinned yet.")
        } else {
            ForEach(rows) { option in
                HStack(spacing: JunoSpace.cozy) {
                    JunoProviderMark(providerID: option.providerID, providerName: option.providerName, size: 16)
                    Text(option.displayName)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                    Spacer(minLength: JunoSpace.cozy)
                    Text(option.providerName)
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(1)
                    Button {
                        setFavorite(option.id, false, settings)
                    } label: {
                        JunoIconView(.star, size: 15, isOn: true)
                            .foregroundStyle(Color.junoForeground)
                            .frame(width: 28, height: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help("Unpin")
                    .accessibilityLabel("Unpin \(option.displayName)")
                }
                .frame(minHeight: 32)
            }
        }
    }

    /// Provider name → its models, in catalog order, minus what is pinned.
    private func addable(_ settings: NativeAccountSettings) -> [(provider: String, models: [NativeChatModelOption])] {
        let remaining = context.modelCatalog.filter { !settings.favoriteModels.contains($0.id) }
        var order: [String] = []
        var grouped: [String: [NativeChatModelOption]] = [:]
        for option in remaining {
            if grouped[option.providerName] == nil { order.append(option.providerName) }
            grouped[option.providerName, default: []].append(option)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }

    private func addMenu(_ settings: NativeAccountSettings) -> some View {
        Menu {
            ForEach(addable(settings), id: \.provider) { group in
                Menu(group.provider) {
                    ForEach(group.models) { option in
                        Button(option.displayName) { setFavorite(option.id, true, settings) }
                    }
                }
            }
        } label: {
            Label {
                Text("Add")
            } icon: {
                JunoIconView(.plus, size: 13)
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.bordered)
        .tint(nil)
        .fixedSize()
        .disabled(addable(settings).isEmpty)
        .contentShape(.rect)
        .accessibilityIdentifier("juno.desktop.settings.add-favorite")
    }

    private func setFavorite(_ modelID: String, _ isFavorite: Bool, _ settings: NativeAccountSettings) {
        var favorites = settings.favoriteModels
        if isFavorite {
            guard !favorites.contains(modelID) else { return }
            favorites.append(modelID)
        } else {
            guard favorites.contains(modelID) else { return }
            favorites.removeAll { $0 == modelID }
        }
        context.save("favoriteModels", NativeSettingsPatch(favoriteModels: favorites))
    }
}
