import AppKit
import Foundation
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// A model an assistant may prefer: its id and its display name.
struct DesktopAssistantModelOption: Identifiable, Hashable {
    let id: String
    let name: String
    let provider: String
}

/// **Assistants** — reusable specialists (`/assistants`, Phase 4 B4): a grid
/// of opaque tiles with the house anatomy (inset glyph, name, two lines of
/// description, a footer rule) and a dashed "New assistant" tile at the end.
///
/// A card opens its editor. The web's card starts `/chat?assistantId=…`,
/// which nothing reads, so there is no Start chat here (register #60).
struct DesktopAssistantsScreen: View {
    @Bindable var model: NativeAssistantsModel
    let models: [DesktopAssistantModelOption]

    @Environment(\.junoToast) private var toast
    @State private var editing: DesktopAssistantEditing?
    @State private var confirmation: JunoConfirmation?
    @State private var dealt = false

    private func followNewAssistantRequest() {
        if DesktopPageRouter.shared.takeNewAssistantRequest() {
            editing = DesktopAssistantEditing(assistant: nil)
        }
    }

    var body: some View {
        JunoPage(measure: .wide) {
            JunoPageHeader(
                "Specialists you can reuse",
                caption: "Assistants",
                lede: "Focused Juno personalities with their own instructions, starter prompts and model preference."
            ) {
                Button { editing = DesktopAssistantEditing(assistant: nil) } label: {
                    Label("New assistant", icon: .plus, size: 13)
                }
                .buttonStyle(.junoProminent)
                .accessibilityIdentifier("juno.desktop.assistants.new")
                .contentShape(.rect)
            }
        } controls: {
            JunoPageControls {
                JunoPageSearchField(
                    text: $model.query,
                    prompt: "Search assistants",
                    accessibilityIdentifier: "juno.desktop.assistants.search"
                )
            } trailing: {
                if model.phase == .ready {
                    Text("\(model.filtered.count) \(model.filtered.count == 1 ? "assistant" : "assistants")")
                        .junoType(.ui)
                        .monospacedDigit()
                        .foregroundStyle(Color.junoSecondaryInk)
                }
            }
        } content: {
            content
        }
        .task {
            await model.loadIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { dealt = true }
        }
        // ⌘K's "New assistant" (``DesktopPageRouter/openNewAssistant()``).
        .onAppear(perform: followNewAssistantRequest)
        .onChange(of: DesktopPageRouter.shared.newAssistantRequest) { _, _ in followNewAssistantRequest() }
        .sheet(item: $editing) { editing in
            DesktopAssistantEditor(model: model, assistant: editing.assistant, models: models)
        }
        .junoConfirmation($confirmation)
        .accessibilityIdentifier("juno.desktop.assistants")
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .failed:
            JunoEmptyState(
                title: "Assistants are unavailable",
                message: "Juno could not read your assistant library. Nothing was deleted; retry the request.",
                icon: .error,
                actionLabel: "Try again",
                action: { Task { await model.reload() } },
                tone: .error
            )
        case .idle, .loading:
            grid {
                ForEach(0..<3, id: \.self) { _ in DesktopAssistantTileSkeleton() }
            }
            .accessibilityLabel("Loading assistants")
        case .ready:
            let filtered = model.filtered
            if filtered.isEmpty {
                if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    JunoEmptyState(
                        title: "No assistants yet",
                        message: "Create a reusable specialist for a workflow, domain, class, project or writing style.",
                        icon: .assistants,
                        actionLabel: "Create assistant",
                        action: { editing = DesktopAssistantEditing(assistant: nil) }
                    )
                } else {
                    JunoEmptyState(
                        title: "No matching assistants",
                        message: "Try a different name or description.",
                        icon: .assistants,
                        actionLabel: "Clear search",
                        action: { model.query = "" },
                        size: .panel
                    )
                }
            } else {
                grid {
                    ForEach(Array(filtered.enumerated()), id: \.element.id) { index, assistant in
                        DesktopAssistantTile(
                            assistant: assistant,
                            modelName: modelName(assistant.preferredModelID),
                            open: { editing = DesktopAssistantEditing(assistant: assistant) },
                            togglePin: { Task { if let sentence = await model.togglePin(assistant) { toast(.error(sentence)) } } },
                            delete: { confirmation = deletion(assistant) }
                        )
                        .desktopDealIn(index, dealt: dealt)
                    }
                    if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        DesktopNewAssistantTile { editing = DesktopAssistantEditing(assistant: nil) }
                            .desktopDealIn(filtered.count, dealt: dealt)
                    }
                }
            }
        }
    }

    /// 1 / 2 / 3 columns at 640 / 1024 of the page's own width, 16pt gaps.
    private func grid<Tiles: View>(@ViewBuilder tiles: () -> Tiles) -> some View {
        DesktopAssistantGrid(content: tiles)
    }

    private func modelName(_ id: String?) -> String {
        guard let id, id != "juno:auto" else { return "Auto" }
        return models.first { $0.id == id }?.name ?? "Auto"
    }

    private func deletion(_ assistant: NativeAssistant) -> JunoConfirmation {
        JunoConfirmation(
            title: "Delete assistant?",
            message: "\(assistant.name) will be removed from your assistant library. Existing chats are not deleted.",
            confirmTitle: "Delete Assistant"
        ) {
            Task { if let sentence = await model.delete(assistant) { toast(.error(sentence)) } }
        }
    }
}

struct DesktopAssistantEditing: Identifiable {
    let id = UUID()
    let assistant: NativeAssistant?
}

/// The gallery's columns, stepped on the page's own width.
private struct DesktopAssistantGrid<Content: View>: View {
    let content: Content
    @Environment(\.junoPageLayout) private var layout

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        let width = layout?.columnWidth ?? 900
        let count = width >= 1024 - 64 ? 3 : (width >= 640 - 48 ? 2 : 1)
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: JunoSpace.regular, alignment: .top), count: count),
            alignment: .leading,
            spacing: JunoSpace.regular
        ) {
            content
        }
    }
}

/// One assistant: its inset glyph, its name and a neutral pin when pinned,
/// two lines of what it is for, and a footer with the model it prefers and
/// its version. Pin, Edit and Delete wait for the pointer.
private struct DesktopAssistantTile: View {
    let assistant: NativeAssistant
    let modelName: String
    let open: () -> Void
    let togglePin: () -> Void
    let delete: () -> Void

    @State private var isHovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                    HStack(alignment: .top, spacing: JunoSpace.cozy) {
                        DesktopInsetTile(icon: .assistants, isActive: isHovering)
                        VStack(alignment: .leading, spacing: JunoSpace.micro) {
                            HStack(spacing: JunoSpace.tight) {
                                Text(assistant.name)
                                    .junoType(JunoType.ui.weight(.medium))
                                    .foregroundStyle(Color.junoForeground)
                                    .lineLimit(1)
                                if assistant.isPinned {
                                    JunoIconView(.pin, size: 11, isOn: true)
                                        .foregroundStyle(Color.junoSecondaryInk)
                                        .accessibilityLabel("Pinned")
                                }
                            }
                            // Room for the hover actions beside the name only;
                            // the description takes the tile's full width.
                            .padding(.trailing, 92)
                            Text(assistant.description.isEmpty ? "Custom Juno assistant" : assistant.description)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoSecondaryInk)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 2)
                        Spacer(minLength: 0)
                    }
                    Spacer(minLength: 0)
                    Rectangle().fill(Color.junoBorder.opacity(0.6)).frame(height: 1).accessibilityHidden(true)
                    HStack {
                        Text(modelName)
                            .lineLimit(1)
                        Spacer()
                        Text("v\(assistant.version)")
                    }
                    .junoType(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Color.junoSecondaryInk)
                }
                .padding(JunoSpace.regular)
                .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                        .fill(isHovering ? Color.junoHover : Color.junoCard)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                        .strokeBorder(isHovering ? Color.junoForeground.opacity(0.2) : Color.junoBorder, lineWidth: 1)
                )
                .contentShape(.rect(cornerRadius: JunoRadius.card))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(assistant.name)
            .accessibilityHint("Opens its editor")
            HStack(spacing: 0) {
                DesktopQuietIconButton(
                    icon: .pin,
                    label: assistant.isPinned ? "Unpin \(assistant.name)" : "Pin \(assistant.name)",
                    help: assistant.isPinned ? "Unpin" : "Pin",
                    isOn: assistant.isPinned,
                    action: togglePin
                )
                DesktopQuietIconButton(icon: .edit, label: "Edit \(assistant.name)", help: "Edit", action: open)
                DesktopQuietIconButton(icon: .delete, label: "Delete \(assistant.name)", help: "Delete", action: delete)
            }
            .padding(JunoSpace.snug)
            .opacity(isHovering ? 1 : 0)
            .accessibilityHidden(!isHovering)
        }
        .onHover { isHovering = $0 }
        .contextMenu {
            Button(assistant.isPinned ? "Unpin" : "Pin", action: togglePin)
            Button("Edit…", action: open)
            Divider()
            Button("Delete…", role: .destructive, action: delete)
        }
    }
}

/// Creating one reads as filling the next slot: a dashed tile at the end.
private struct DesktopNewAssistantTile: View {
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: JunoSpace.snug) {
                JunoIconView(.plus, size: 14)
                Text("New assistant")
            }
            .junoType(.ui)
            .foregroundStyle(isHovering ? Color.junoForeground : Color.junoSecondaryInk)
            .frame(maxWidth: .infinity, minHeight: 160)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .fill(Color.junoCanvas)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
                    .strokeBorder(
                        isHovering ? Color.junoForeground.opacity(0.3) : Color.junoBorder.opacity(0.8),
                        style: StrokeStyle(lineWidth: 1, dash: [4, 3])
                    )
            )
            .contentShape(.rect(cornerRadius: JunoRadius.card))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel("New assistant")
    }
}

private struct DesktopAssistantTileSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                JunoSkeleton(height: 36, width: 36, cornerRadius: JunoRadius.field)
                VStack(alignment: .leading, spacing: JunoSpace.snug) {
                    JunoSkeleton(height: 12, width: 120)
                    JunoSkeleton(height: 10)
                    JunoSkeleton(height: 10, width: 140)
                }
            }
            Spacer(minLength: 0)
            JunoSkeleton(height: 8, width: 64)
        }
        .padding(JunoSpace.regular)
        .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).fill(Color.junoCard))
        .overlay(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

// MARK: - The editor

/// The editor for a reusable assistant (`assistant-studio.tsx`, register
/// #66): the form on the left, and on the right a live preview of the tile
/// the gallery will show — the name and the starters appear as you type
/// them, which is the page's signature.
struct DesktopAssistantEditor: View {
    let model: NativeAssistantsModel
    let assistant: NativeAssistant?
    let models: [DesktopAssistantModelOption]

    @Environment(\.dismiss) private var dismiss
    @State private var draft: NativeAssistantDraft
    @State private var saving = false
    @State private var error: String?

    init(model: NativeAssistantsModel, assistant: NativeAssistant?, models: [DesktopAssistantModelOption]) {
        self.model = model
        self.assistant = assistant
        self.models = models
        _draft = State(initialValue: assistant.map(NativeAssistantDraft.init) ?? NativeAssistantDraft())
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: JunoSpace.cozy) {
                DesktopInsetTile(icon: .assistants)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(assistant == nil ? "Create assistant" : "Edit assistant")
                        .junoType(.heading)
                        .accessibilityAddTraits(.isHeader)
                    Text("Give Juno a reusable role, operating instructions, starter prompts and a preferred model.")
                        .junoType(.ui)
                        .foregroundStyle(Color.junoSecondaryInk)
                }
                Spacer()
            }
            .padding(JunoSpace.roomy)
            Divider()
            HStack(spacing: 0) {
                ScrollView { form.padding(JunoSpace.roomy) }
                    .frame(maxWidth: .infinity)
                Divider()
                ScrollView { preview.padding(JunoSpace.roomy) }
                    .frame(width: 340)
                    .background(Color.junoSecondary.opacity(0.5))
            }
            Divider()
            HStack(spacing: JunoSpace.snug) {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .tint(nil)
                    .disabled(saving)
                    .contentShape(.rect)
                Button(saving ? "Saving…" : (assistant == nil ? "Create Assistant" : "Save Changes")) {
                    Task { await save() }
                }
                .buttonStyle(.junoProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(saving)
                .contentShape(.rect)
            }
            .padding(.horizontal, JunoSpace.roomy)
            .padding(.vertical, JunoSpace.regular)
        }
        .frame(width: 880, height: 640)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            if let error {
                DesktopNoteBand(icon: .error, tone: Color.junoDestructiveInk) { Text(error) }
            }
            HStack(alignment: .top, spacing: JunoSpace.regular) {
                DesktopSkillField(label: "Name", text: $draft.name, placeholder: "Python data analyst")
                VStack(alignment: .leading, spacing: JunoSpace.tight) {
                    Text("Preferred model")
                        .junoType(JunoType.ui.weight(.medium))
                    Picker("Preferred model", selection: Binding(
                        get: { draft.preferredModelID ?? "juno:auto" },
                        set: { draft.preferredModelID = $0 == "juno:auto" ? nil : $0 }
                    )) {
                        Text("Auto · intelligent routing").tag("juno:auto")
                        ForEach(models) { option in
                            Text("\(option.name) · \(option.provider)").tag(option.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(nil)
                    .frame(height: 32)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            DesktopSkillField(
                label: "Description",
                text: $draft.description,
                placeholder: "What is this assistant for?",
                help: Text("Keep this short enough to scan in the gallery.")
            )
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                Text("Instructions")
                    .junoType(JunoType.ui.weight(.medium))
                DesktopMonoEditor(
                    text: $draft.systemPrompt,
                    placeholder: "Define the role, how it should reason about the work, output conventions, boundaries, and what it should ask before doing.",
                    minHeight: 150
                )
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        Text("Conversation starters")
                            .junoType(JunoType.ui.weight(.medium))
                        Text("Optional prompts that make the assistant useful immediately.")
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                    Spacer()
                    Button { draft.starterPrompts.append("") } label: { Label("Add", icon: .plus, size: 12) }
                        .buttonStyle(.borderless)
                        .tint(nil)
                        .contentShape(.rect)
                }
                ForEach(draft.starterPrompts.indices, id: \.self) { index in
                    HStack(spacing: JunoSpace.snug) {
                        TextField("Analyze this dataset and explain the important patterns.", text: Binding(
                            get: { index < draft.starterPrompts.count ? draft.starterPrompts[index] : "" },
                            set: { if index < draft.starterPrompts.count { draft.starterPrompts[index] = $0 } }
                        ))
                        .textFieldStyle(.plain)
                        .junoType(.ui)
                        .padding(.horizontal, JunoSpace.cozy)
                        .frame(height: 32)
                        .background(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).fill(Color.junoCanvas))
                        .overlay(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous).strokeBorder(Color.junoInput, lineWidth: 1))
                        .accessibilityLabel("Starter prompt \(index + 1)")
                        DesktopQuietIconButton(icon: .delete, label: "Remove starter prompt \(index + 1)", help: "Remove starter") {
                            if index < draft.starterPrompts.count { draft.starterPrompts.remove(at: index) }
                        }
                        .disabled(draft.starterPrompts.count == 1)
                    }
                }
            }
        }
    }

    /// The tile this form produces, raised on an inset shelf, with the
    /// starters and the instructions below it.
    private var preview: some View {
        let starters = draft.starterPrompts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return VStack(alignment: .leading, spacing: JunoSpace.roomy) {
            Text("Preview")
                .junoType(JunoType.caption.weight(.medium))
                .foregroundStyle(Color.junoSecondaryInk)
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                HStack(alignment: .top, spacing: JunoSpace.cozy) {
                    DesktopInsetTile(icon: .assistants)
                    VStack(alignment: .leading, spacing: JunoSpace.micro) {
                        Text(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "Untitled assistant" : draft.name.trimmingCharacters(in: .whitespacesAndNewlines))
                            .junoType(JunoType.ui.weight(.medium))
                            .lineLimit(1)
                        Text(draft.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "A one-line description shows here." : draft.description)
                            .junoType(.caption)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .lineLimit(2)
                    }
                }
                Rectangle().fill(Color.junoBorder.opacity(0.6)).frame(height: 1)
                HStack {
                    Text(previewModel)
                    Spacer()
                    Text("v\(assistant?.version ?? 1)")
                }
                .junoType(.caption)
                .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(JunoSpace.regular)
            .background(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).fill(Color.junoCard))
            .overlay(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Starters")
                    .junoType(JunoType.caption.weight(.medium))
                    .foregroundStyle(Color.junoSecondaryInk)
                if starters.isEmpty {
                    Text("Add a starter to see it here.")
                        .junoType(.caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                } else {
                    DesktopWrapRow {
                        ForEach(Array(starters.enumerated()), id: \.offset) { _, starter in
                            Text(starter)
                                .junoType(.caption)
                                .foregroundStyle(Color.junoForeground)
                                .lineLimit(1)
                                .padding(.horizontal, JunoSpace.snug)
                                .frame(height: 24)
                                .overlay(Capsule(style: .continuous).strokeBorder(Color.junoBorder, lineWidth: 1))
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                Text("Instructions")
                    .junoType(JunoType.caption.weight(.medium))
                    .foregroundStyle(Color.junoSecondaryInk)
                Text(draft.systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "The system prompt appears here as you write it." : draft.systemPrompt)
                    .junoType(.micro)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .lineLimit(6)
            }
        }
    }

    private var previewModel: String {
        guard let id = draft.preferredModelID else { return "Auto" }
        return models.first { $0.id == id }?.name ?? "Auto"
    }

    private func save() async {
        saving = true
        error = nil
        let result = await model.save(draft, editing: assistant?.id)
        saving = false
        switch result {
        case .success: dismiss()
        case .failure(let failure): error = failure.message ?? NativeAssistantsModel.saveFailure
        }
    }
}

/// Chips that wrap onto as many lines as the column needs.
struct DesktopWrapRow: Layout {
    var spacing: CGFloat = JunoSpace.tight

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: limit, height: nil))
            let width = min(size.width, limit)
            if x > 0, x + width > limit {
                y += line + spacing
                x = 0
                line = 0
            }
            x += width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, limit), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            let width = min(size.width, bounds.width)
            if x > bounds.minX, x + width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: width, height: size.height))
            x += width + spacing
            line = max(line, size.height)
        }
    }
}
