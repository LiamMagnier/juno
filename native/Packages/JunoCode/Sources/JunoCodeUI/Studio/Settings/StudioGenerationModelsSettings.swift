import SwiftUI
import JunoCodeRuntime
import JunoDesignSystem

/// Settings › General › Generation models: one menu per kind of media the
/// catalogue can make. The agent's `generate_image`, `generate_video` and
/// `generate_audio` tools use these; the composer's model picker lists only
/// the text models that write code.
struct StudioGenerationModelsSettings: View {
    let models: [ModelOption]
    var defaults: UserDefaults = .standard

    /// Bumped on every change so the menus re-read the stored choices.
    @State private var revision = 0

    var body: some View {
        let kinds = CodeGenerationModels.kinds(in: models)
        Section {
            if kinds.isEmpty {
                Text("Your plan has no image, video or music models yet.")
                    .foregroundStyle(Studio.Ink.secondary)
            }
            ForEach(kinds, id: \.self) { kind in
                row(kind)
            }
        } header: {
            Text("Generation models")
        } footer: {
            Text("When Code needs to make an image, a video or music, it uses these models. The model picker lists only models that write code.")
        }
    }

    private func row(_ kind: CodeMediaKind) -> some View {
        let choices = CodeGenerationModels.choices(kind, in: models)
        let fallback = CodeGenerationModels.defaultModel(kind, in: choices)
        let selection = Binding<String>(
            get: {
                _ = revision
                return CodeGenerationModels.resolved(kind, in: models, defaults: defaults) ?? ""
            },
            set: { id in
                // Choosing the default stores nothing, so a newer default
                // arrives on its own.
                CodeGenerationModels.store(id == fallback ? nil : id, for: kind, defaults: defaults)
                revision += 1
            }
        )
        return Picker(selection: selection) {
            ForEach(choices) { choice in
                Text("\(choice.name) · \(choice.lab)" + (choice.id == fallback ? " (default)" : ""))
                    .tag(choice.id)
            }
        } label: {
            Label {
                Text(kind.title)
            } icon: {
                JunoIconView(kind.icon, size: 14)
            }
        }
        .accessibilityIdentifier("juno.code.settings.generation.\(kind.rawValue)")
    }
}

extension CodeMediaKind {
    var icon: JunoIcon {
        switch self {
        case .image: .image
        case .video: .video
        case .audio: .audioLines
        }
    }
}
