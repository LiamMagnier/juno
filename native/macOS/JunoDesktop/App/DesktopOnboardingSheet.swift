import JunoChatKit
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// Onboarding (`src/components/app/onboarding.tsx`): three optional choices —
/// a name, a theme and an accent — saved to the account (P3-9: the theme too,
/// because the Mac's theme is the account's), with no dot-field backdrop.
///
/// Signature detail: choosing a swatch recolours "Start Chatting" at once, so
/// the choice is previewed on the one coral control.
struct DesktopOnboardingSheet: View {
    let settingsModel: NativeMemorySettingsModel<SQLiteAccountRepository>?
    let initialName: String
    let finish: () -> Void

    @State private var name = ""
    @State private var theme: NativeThemePreference = .system
    @State private var accent: JunoAccent = .coral
    @State private var saving = false
    @State private var didLoad = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.section) {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Welcome to Juno")
                    .junoType(.title)
                    .foregroundStyle(Color.junoForeground)
                    .accessibilityAddTraits(.isHeader)
                Text("Three quick choices, all optional. Everything here is in Settings later.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                label("What should Juno call you?")
                TextField("What should Juno call you?", text: $name, prompt: Text("Your first name"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(start)
                    .accessibilityIdentifier("juno.desktop.onboarding.name")
            }

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                label("Theme")
                HStack(spacing: JunoSpace.snug) {
                    themeTile(.light, "Light", .sun)
                    themeTile(.dark, "Dark", .moon)
                    themeTile(.system, "System", .monitor)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Theme")
            }

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                label("Accent")
                HStack(spacing: JunoSpace.close) {
                    ForEach(JunoAccent.allCases) { option in
                        DesktopAccentSwatch(
                            fill: AnyShapeStyle(option.color),
                            ink: option.onAccent,
                            label: option.displayName,
                            isSelected: accent == option,
                            select: { pick(option) }
                        )
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Accent color")
            }

            Spacer(minLength: 0)

            HStack(spacing: JunoSpace.snug) {
                Spacer(minLength: 0)
                Button("Skip for Now", action: finish)
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                Button("Start Chatting", action: start)
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving)
                    // The accent changes live, and so does this button.
                    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: accent)
                    .accessibilityIdentifier("juno.desktop.onboarding.start")
            }
        }
        .padding(JunoSpace.region)
        .frame(width: 480, height: 440)
        .presentationSizing(.form)
        .onAppear {
            guard !didLoad else { return }
            didLoad = true
            name = initialName
            theme = settingsModel?.settings?.theme ?? .system
            accent = JunoAccent(setting: settingsModel?.settings?.accent)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .junoType(JunoType.ui.weight(.medium))
            .foregroundStyle(Color.junoForeground)
    }

    private func themeTile(_ value: NativeThemePreference, _ title: String, _ icon: JunoIcon) -> some View {
        let selected = theme == value
        return Button {
            guard theme != value else { return }
            theme = value
            Task { await settingsModel?.saveSettings(NativeSettingsPatch(theme: value)) }
        } label: {
            VStack(spacing: JunoSpace.tight) {
                JunoIconView(icon, size: 18)
                Text(title)
                    .junoType(.ui)
            }
            .foregroundStyle(selected ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(maxWidth: .infinity, minHeight: 72)
            .background(
                selected ? Color.junoSelectedFill : Color.junoCard,
                in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                    .strokeBorder(selected ? Color.junoSelectedEdge : Color.junoBorder, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
        }
        .buttonStyle(.junoPress)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func pick(_ option: JunoAccent) {
        guard accent != option else { return }
        accent = option
        JunoAccentSelection.shared.apply(setting: option.rawValue)
        Task { await settingsModel?.saveSettings(NativeSettingsPatch(accent: option.rawValue)) }
    }

    private func start() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != initialName, let settingsModel else {
            finish()
            return
        }
        saving = true
        Task {
            await settingsModel.saveSettings(NativeSettingsPatch(name: value))
            saving = false
            finish()
        }
    }
}
