import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// Settings › Personalization (`sections/personalization.tsx`): what Juno calls
/// you and your standing instructions, then how it replies.
///
/// Both fields save when they lose focus (and the name on Return too), as the
/// web's do; there is no Save button and no character count.
struct DesktopSettingsPersonalizationPane: View {
    let context: DesktopSettingsContext

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            DesktopSettingsPersonalizationSections(context: context, settings: settings)
        }
    }
}

/// The web's `PERSONALITIES` (`src/lib/personalities.ts`), in order.
enum DesktopPersonalities {
    static let all: [(id: String, label: String, description: String)] = [
        ("default", "Default", "Juno's natural voice: warm, clear, and adapted to the question."),
        ("concise", "Concise", "Answer first, no preamble. Expands only when the topic needs it."),
        ("encouraging", "Encouraging", "Supportive and motivating, without sugar-coating the truth."),
        ("socratic", "Socratic", "Leads with questions so you reach the answer yourself."),
        ("formal", "Formal", "Professional register suited to work and formal writing."),
        ("nerdy", "Nerdy", "Precise and detail-loving, with the mechanism behind the answer."),
    ]

    /// A stored id, or Default for anything this build does not know.
    static func active(_ stored: String) -> String {
        all.contains { $0.id == stored } ? stored : "default"
    }
}

/// The web's `LANGUAGES` for replies, in order.
enum DesktopResponseLanguages {
    static let all: [(value: String, label: String)] = [
        ("auto", "Match my message"),
        ("English", "English"), ("Spanish", "Spanish"), ("French", "French"),
        ("German", "German"), ("Portuguese", "Portuguese"), ("Italian", "Italian"),
        ("Japanese", "Japanese"), ("Korean", "Korean"), ("Chinese", "Chinese"),
        ("Hindi", "Hindi"), ("Arabic", "Arabic"),
    ]
}

private struct DesktopSettingsPersonalizationSections: View {
    let context: DesktopSettingsContext
    let settings: NativeAccountSettings

    @State private var name = ""
    @State private var instructions = ""
    /// What each field was last handed, so a sync landing mid-sentence cannot
    /// erase what is being typed.
    @State private var nameBaseline: String?
    @State private var instructionsBaseline: String?
    @FocusState private var focus: Field?

    private enum Field {
        case name
        case instructions
    }

    var body: some View {
        Section {
            DesktopSettingRow(
                title: "What Juno calls you",
                description: "Used in greetings, and shown in the sidebar.",
                status: context.saves.status("name")
            ) {
                TextField("Your name", text: $name, prompt: Text("Your name"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.leading)
                    .frame(width: DesktopSettingsMetrics.menuWidth)
                    .focused($focus, equals: .name)
                    .onSubmit { saveName() }
                    .accessibilityLabel("What Juno calls you")
                    .accessibilityIdentifier("juno.desktop.settings.name")
            }

            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                DesktopSettingLabel(
                    title: "Custom instructions",
                    description: "Juno keeps these in mind in every conversation.",
                    status: context.saves.status("customInstructions")
                )
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $instructions)
                        .junoType(.ui)
                        .scrollContentBackground(.hidden)
                        .focused($focus, equals: .instructions)
                        .padding(JunoSpace.tight)
                        .accessibilityLabel("Custom instructions")
                        .accessibilityIdentifier("juno.desktop.settings.instructions")
                    if instructions.isEmpty {
                        Text("For example: I’m a product manager. Keep answers short and use bullet points.")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoTertiaryInk)
                            .padding(.horizontal, JunoSpace.snug + 1)
                            .padding(.vertical, JunoSpace.snug)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minHeight: DesktopSettingsMetrics.editorMinHeight)
                .background(
                    Color.junoCard,
                    in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous)
                        .strokeBorder(Color.junoBorder, lineWidth: 1)
                )
            }
            .padding(.vertical, JunoSpace.micro)
        }
        .onChange(of: focus) { previous, _ in
            if previous == .name { saveName() }
            if previous == .instructions { saveInstructions() }
        }
        .task(id: context.displayName) {
            let stored = context.displayName ?? ""
            if name == (nameBaseline ?? "") { name = stored }
            nameBaseline = stored
        }
        .task(id: settings.customInstructions) {
            let stored = settings.customInstructions
            if instructions == (instructionsBaseline ?? "") { instructions = stored }
            instructionsBaseline = stored
        }
        .onDisappear {
            saveName()
            saveInstructions()
        }

        Section {
            personalityRow
            languageRow
        } header: {
            DesktopSettingsGroupHeader(
                title: "Responses",
                note: "Your custom instructions take priority over both."
            )
        }
    }

    private var personalityRow: some View {
        let active = DesktopPersonalities.active(settings.personality)
        return DesktopSettingRow(
            title: "Personality",
            description: DesktopPersonalities.all.first { $0.id == active }?.description,
            status: context.saves.status("personality")
        ) {
            Picker("Personality", selection: Binding(
                get: { active },
                set: { value in
                    guard value != active else { return }
                    context.save("personality", NativeSettingsPatch(personality: value))
                }
            )) {
                ForEach(DesktopPersonalities.all, id: \.id) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(nil)
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.personality")
        }
    }

    private var languageRow: some View {
        let known = DesktopResponseLanguages.all.contains { $0.value == settings.responseLanguage }
        let options = known
            ? DesktopResponseLanguages.all
            : DesktopResponseLanguages.all + [(settings.responseLanguage, settings.responseLanguage)]
        return DesktopSettingRow(
            title: "Response language",
            description: "The language Juno replies in.",
            status: context.saves.status("responseLanguage")
        ) {
            Picker("Response language", selection: Binding(
                get: { settings.responseLanguage },
                set: { value in
                    guard value != settings.responseLanguage else { return }
                    context.save("responseLanguage", NativeSettingsPatch(responseLanguage: value))
                }
            )) {
                ForEach(options, id: \.value) { option in
                    Text(option.label.desktopMenuTitle).tag(option.value)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .tint(nil)
            .fixedSize()
            .accessibilityIdentifier("juno.desktop.settings.response-language")
        }
    }

    private func saveName() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value != (context.displayName ?? "") else { return }
        context.save("name", NativeSettingsPatch(name: value), failure: "Couldn’t save your name.")
    }

    private func saveInstructions() {
        guard instructions != settings.customInstructions else { return }
        context.save("customInstructions", NativeSettingsPatch(customInstructions: instructions))
    }
}
