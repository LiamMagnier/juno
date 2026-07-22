import JunoChatKit
#if DEBUG
import JunoPreviewSupport
#endif
import JunoDesignSystem
import JunoStorage
import SwiftUI

/// The chat composer: one Liquid Glass container holding the message editor and,
/// beneath it, a single row of compact controls — `+`, the model, Thinking, then
/// Send. The model and Thinking controls live *inside* this container rather
/// than above it, because they are part of composing a message, not settings.
struct JunoMobileComposer: View {
    @Bindable var model: NativeConversationModel<SQLiteAccountRepository>
    let conversation: NativeConversation
    var projects: [NativeProject] = []
    @Binding var prompt: String
    @Binding var selectedModelID: String
    @Binding var reasoningEffort: NativeReasoningEffort?
    /// The one line explaining a thinking level that had to move when the model
    /// changed. Cleared by the owner once shown.
    @Binding var thinkingNotice: String?
    var composerFocused: FocusState<Bool>.Binding

    @State private var showingActions = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedModel: NativeChatModelOption? {
        model.modelCatalog.first { $0.id == selectedModelID }
    }

    private var thinkingScale: NativeThinkingScale? {
        selectedModel.map(NativeThinkingScale.init)
    }

    private var generatingHere: Bool {
        model.isGenerating && model.activeChatConversationID == conversation.id
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.isGenerating
            || conversation.isPending
    }

    var body: some View {
        VStack(spacing: 8) {
            if model.canRetrySelectedConversation && !model.isGenerating {
                retryBanner
            }

            // Above the composer, not below it: under the container it would sit
            // in the home-indicator strip and go unread.
            if let thinkingNotice {
                Label(thinkingNotice, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
                    .accessibilityIdentifier("juno.mobile.thinking-notice")
            }

            VStack(spacing: 8) {
                TextField("Message Juno", text: $prompt, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused(composerFocused)
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
                    .accessibilityIdentifier("juno.mobile.chat-composer")

                controlRow
            }
            .padding(8)
            .background(JunoGlassBackground(cornerRadius: 24))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: sendDisabled)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: generatingHere)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: thinkingNotice)
        .task { await applyPreviewFlags() }
    }

    /// Drives the composer into one exact state for visual QA. No effect — and
    /// no code — outside DEBUG.
    private func applyPreviewFlags() async {
        #if DEBUG
        if let forced = JunoComposerPreviewFlags.forcedModelID {
            // The catalog arrives asynchronously; without waiting, a scripted
            // screenshot silently lands on whatever was selected by default.
            for _ in 0..<20 where !model.modelCatalog.contains(where: { $0.id == forced }) {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if model.modelCatalog.contains(where: { $0.id == forced }) {
                selectedModelID = forced
            }
        }
        if let level = JunoComposerPreviewFlags.forcedThinkingLevel {
            reasoningEffort = level
        }
        if JunoComposerPreviewFlags.focusesComposer {
            composerFocused.wrappedValue = true
        }
        if JunoComposerPreviewFlags.opensComposerActions {
            try? await Task.sleep(nanoseconds: 400_000_000)
            showingActions = true
        }
        #endif
    }

    /// `+` · model · Thinking · phase · Send. There is deliberately no
    /// microphone: dictation is not wired on iPhone yet, and a control that
    /// does nothing is worse than one that is absent. The system keyboard's own
    /// dictation key remains available in the meantime.
    private var controlRow: some View {
        HStack(spacing: 8) {
            composerPlusButton

            JunoMobileModelControl(
                models: model.modelCatalog,
                selectedModelID: $selectedModelID,
                fallbackName: junoDisplayModelName(conversation.model)
            )
            .layoutPriority(1)

            if let thinkingScale {
                JunoMobileThinkingControl(scale: thinkingScale, effort: $reasoningEffort)
                    .layoutPriority(2)
            }

            Spacer(minLength: 4)

            if model.chatPhase != .idle {
                phaseIndicator
            }

            composerActionButton
        }
    }

    private var phaseIndicator: some View {
        HStack(spacing: 5) {
            if isStreamingPhase {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: phaseSymbol)
            }
            Text(phaseLabel)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(phaseLabel)
    }

    private var retryBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(model.chatErrorDescription ?? "The response was interrupted.")
                .lineLimit(2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Retry") {
                model.retryLastMessage(conversationID: conversation.id)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("juno.mobile.chat-retry")
        }
        .font(.caption)
    }

    private var isStreamingPhase: Bool {
        switch model.chatPhase {
        case .appending, .submitting, .reasoning, .streaming, .reconnecting: true
        case .idle, .stopping, .failed: false
        }
    }

    private var phaseLabel: String {
        switch model.chatPhase {
        case .idle: "Ready"
        case .appending: "Saving message"
        case .submitting: "Starting"
        case .reasoning: "Reasoning"
        case .streaming: "Writing"
        case .stopping: "Stopping"
        case .reconnecting: "Reconnecting"
        case .failed: "Interrupted"
        }
    }

    private var phaseSymbol: String {
        switch model.chatPhase {
        case .reconnecting: "wifi.exclamationmark"
        case .failed: "exclamationmark.circle"
        case .stopping: "stop.circle"
        default: "sparkles"
        }
    }

    /// The "+" control. A neutral glass circle (never accent — that stays
    /// reserved for Send) that morphs to an "×" and presents a compact anchored
    /// actions panel.
    private var composerPlusButton: some View {
        Button {
            showingActions = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 32, height: 32)
                .rotationEffect(.degrees(showingActions ? 45 : 0))
                .modifier(JunoComposerGlassCircle())
        }
        .buttonStyle(.plain)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: showingActions)
        .accessibilityLabel("Add content or tools")
        .accessibilityIdentifier("juno.mobile.chat-plus")
        .popover(isPresented: $showingActions) {
            composerActionsPanel
                .presentationCompactAdaptation(.popover)
        }
    }

    /// A compact popover anchored to the "+" button. Only genuinely wired
    /// actions appear here — today that is associating the current conversation
    /// with a project (server-validated), so the panel is the project picker
    /// with the current association checked and a "No project" row to clear it.
    private var composerActionsPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Add to project")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 11)
                .padding(.bottom, 5)

            ScrollView {
                VStack(spacing: 1) {
                    projectOptionRow(
                        id: nil, name: "No project", icon: "tray",
                        selected: conversation.projectId == nil
                    )
                    ForEach(projects) { project in
                        projectOptionRow(
                            id: project.id, name: project.name, icon: "folder",
                            selected: conversation.projectId == project.id
                        )
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 244)
        }
        .frame(width: 268)
        .padding(.bottom, 6)
        .accessibilityIdentifier("juno.mobile.composer-actions")
    }

    private func projectOptionRow(id: String?, name: String, icon: String, selected: Bool) -> some View {
        Button {
            Task {
                await model.setProject(id: conversation.id, projectID: id)
                showingActions = false
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .frame(width: 24)
                    .foregroundStyle(selected ? Color.junoAccent : .primary)
                Text(name)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.junoAccent)
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "\(name), selected" : name)
    }

    /// The send / stop control: a circular coral Liquid Glass button that fades
    /// to a discreet disabled state when there is nothing to send and swaps to
    /// Stop while streaming.
    @ViewBuilder
    private var composerActionButton: some View {
        if generatingHere {
            Button {
                model.stopGeneration()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: true))
            }
            .buttonStyle(.plain)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Stop generation")
            .accessibilityIdentifier("juno.mobile.chat-stop")
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .modifier(JunoComposerSendBackground(active: !sendDisabled))
                    .scaleEffect(sendDisabled ? 0.92 : 1)
            }
            .buttonStyle(.plain)
            .disabled(sendDisabled)
            .transition(.scale.combined(with: .opacity))
            .accessibilityLabel("Send message")
            .accessibilityIdentifier("juno.mobile.chat-send")
        }
    }

    private func send() {
        if model.sendMessage(
            conversationID: conversation.id,
            prompt: prompt,
            modelID: selectedModelID.isEmpty ? conversation.model : selectedModelID,
            reasoningEffort: reasoningEffort
        ) {
            prompt = ""
        }
    }
}

/// The composer's selection rules, kept as pure functions so the fallback
/// behaviour is testable without standing up a view.
enum JunoMobileComposerSelection {
    /// The model the composer should be on. Preference order: keep the current
    /// choice if it is still selectable, otherwise the conversation's own model,
    /// otherwise the first selectable one. The conversation's model is the last
    /// resort when nothing is selectable at all — the composer then still names
    /// something real rather than going blank.
    static func resolvedModelID(
        current: String,
        conversationModel: String,
        selectable: [NativeChatModelOption]
    ) -> String {
        if !current.isEmpty, selectable.contains(where: { $0.id == current }) {
            return current
        }
        if selectable.contains(where: { $0.id == conversationModel }) {
            return conversationModel
        }
        return selectable.first?.id ?? conversationModel
    }
}

/// A circular coral Liquid Glass background for the composer's send/stop button,
/// with a material fallback below OS 26. When inactive the coral tint fades to a
/// discreet level so the disabled state stays legible without shouting.
struct JunoComposerSendBackground: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(Color.junoAccent.opacity(active ? 0.95 : 0.32)).interactive(),
                    in: Circle()
                )
        } else {
            content
                .background(Color.junoAccent.opacity(active ? 1 : 0.35), in: Circle())
        }
    }
}

/// A neutral (non-accent) circular Liquid Glass background for the composer's
/// "+" button, with a material fallback below OS 26.
struct JunoComposerGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.junoHairline, lineWidth: 1))
        }
    }
}
