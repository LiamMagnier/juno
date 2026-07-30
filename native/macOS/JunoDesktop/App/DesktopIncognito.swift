import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import SwiftUI

/// Incognito, as a window of its own.
///
/// The Mac has had the model for this all along — `JunoDesktopConfiguration`
/// builds a `NativePrivateChatModel` — and nothing ever referenced it, so the
/// feature existed everywhere except on screen. The phone reached it from the
/// conversations list; a Mac reaches it from ⇧⌘N, because on this platform
/// "private browsing" is a *window*, which is the shape Safari and Chrome
/// established and the shape that makes the guarantee legible: close the window
/// and the conversation is gone, because there was never anywhere for it to go.
///
/// What incognito actually means here is worth restating, since the window is the
/// only place a reader learns it: nothing is written to the local store, nothing
/// is queued to the outbox, nothing syncs, and no conversation row is ever
/// created. The whole exchange lives in this model's `turns` array and dies with
/// it. Quota and spend are still metered — the generation costs what it costs.
struct DesktopIncognitoWindow: View {
    let configuration: JunoDesktopConfiguration

    var body: some View {
        if let model = configuration.privateChatModel,
           case .signedIn(let session) = configuration.authModel.phase {
            DesktopIncognitoChat(
                model: model,
                selectableModels: configuration.conversationModel?.selectableModels ?? [],
                accountID: session.profile.id,
                profileName: session.profile.name
            )
        } else {
            // Signed out. The window still opens — ⇧⌘N is a menu item and a menu
            // item that silently does nothing is worse than one that explains.
            ContentUnavailableView(
                "Sign in to use incognito",
                systemImage: "theatermasks",
                description: Text("Incognito chats are never saved, but they still run on your account.")
            )
        }
    }
}

struct DesktopIncognitoChat: View {
    @Bindable var model: NativePrivateChatModel
    let selectableModels: [NativeChatModelOption]
    let accountID: AccountID
    let profileName: String?

    @State private var prompt = ""
    @State private var selectedModelID = ""
    @State private var reasoningEffort: NativeReasoningEffort?
    @FocusState private var composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            transcript
            composer
        }
        .background(Color.junoCanvas)
        .navigationTitle("Incognito")
        .task(id: accountID.rawValue) {
            model.start(for: accountID)
        }
        .onDisappear {
            // The window closing IS the erase. Nothing else holds a reference to
            // these turns, so dropping them here is what makes the promise true
            // rather than merely stated.
            model.stopGeneration()
            model.reset()
            model.stop()
        }
        .onAppear {
            if selectedModelID.isEmpty {
                selectedModelID = selectableModels.first(where: \.isAvailable)?.id ?? ""
            }
            composerFocused = true
        }
    }

    // MARK: - Transcript

    @ViewBuilder
    private var transcript: some View {
        if model.isEmpty {
            greeting
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: JunoSpace.region) {
                    ForEach(model.turns) { turn in
                        turnRow(turn)
                    }
                }
                .padding(.horizontal, JunoSpace.region)
                .padding(.vertical, JunoSpace.region)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
        }
    }

    /// The empty state carries the whole contract, because this window has no
    /// other chrome that could. A ghost glyph and one sentence about what does
    /// not happen — not a marketing line about privacy.
    private var greeting: some View {
        VStack(spacing: JunoSpace.snug) {
            Image(systemName: "theatermasks")
                .font(.system(size: 34))
                .foregroundStyle(Color.junoMutedForeground)
            Text(profileName.map { "Off the record, \($0)" } ?? "Off the record")
                .font(JunoSerif.font(size: 26, relativeTo: .title, face: .medium))
            Text("Nothing here is saved, synced, or titled. Closing this window erases it.")
                .junoCaption()
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(JunoSpace.region)
    }

    @ViewBuilder
    private func turnRow(_ turn: NativePrivateChatModel.Turn) -> some View {
        if turn.role == .user {
            HStack(spacing: 0) {
                Spacer(minLength: JunoSpace.region)
                Text(turn.content)
                    .junoBody()
                    .textSelection(.enabled)
                    .padding(.horizontal, JunoSpace.cozy)
                    .padding(.vertical, JunoSpace.snug + 1)
                    .background(
                        RoundedRectangle(cornerRadius: JunoCornerRadius.message, style: .continuous)
                            .fill(Color.junoRaised)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: JunoCornerRadius.message, style: .continuous)
                            .strokeBorder(Color.junoHairline)
                    )
            }
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                // The same AIcss trace the saved transcript shows. Incognito is
                // about where the words are stored, not about showing the reader
                // less of what happened.
                if let reasoning = turn.reasoning, !reasoning.isEmpty {
                    JunoAIcssReasoningStream(
                        lines: JunoAIcssReasoningLines.lines(text: reasoning),
                        streaming: model.isStreaming && turn.id == model.turns.last?.id,
                        showsHeader: !model.isStreaming
                    )
                    .frame(maxWidth: 520, alignment: .leading)
                }
                if turn.content.isEmpty, model.isStreaming {
                    HStack(spacing: 10) {
                        JunoThinkingMatrix()
                            .foregroundStyle(Color.junoMutedForeground.opacity(0.65))
                        JunoAIcssThinkingLabel("Thinking about your request", size: 15)
                    }
                } else {
                    JunoMarkdownText(
                        turn.content,
                        streaming: model.isStreaming && turn.id == model.turns.last?.id
                    )
                    .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(spacing: JunoSpace.snug) {
            if let error = model.lastErrorDescription {
                Text(error)
                    .junoCaption()
                    .foregroundStyle(Color.junoDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: JunoSpace.snug) {
                TextField("Message Juno — off the record", text: $prompt, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($composerFocused)
                    .junoBody()
                    .onSubmit(send)

                if model.isStreaming {
                    Button("Stop", systemImage: "stop.fill") { model.stopGeneration() }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderedProminent)
                } else {
                    Button("Send", systemImage: "arrow.up") { send() }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderedProminent)
                        .disabled(sendDisabled)
                        .keyboardShortcut(.return, modifiers: [])
                }
            }
            .padding(JunoSpace.cozy)
            .background(
                RoundedRectangle(cornerRadius: JunoCornerRadius.composer, style: .continuous)
                    .fill(Color.junoRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoCornerRadius.composer, style: .continuous)
                    .strokeBorder(Color.junoHairline)
            )

            HStack(spacing: JunoSpace.snug) {
                Picker("Model", selection: $selectedModelID) {
                    ForEach(selectableModels.filter(\.isAvailable), id: \.id) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 240)
                Spacer(minLength: 0)
                Label("Not saved", systemImage: "theatermasks")
                    .junoCaption()
                    .foregroundStyle(.secondary)
            }
        }
        .padding(JunoSpace.region)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
    }

    private var sendDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedModelID.isEmpty
    }

    private func send() {
        guard !sendDisabled else { return }
        model.send(prompt: prompt, modelID: selectedModelID, reasoningEffort: reasoningEffort)
        prompt = ""
    }
}
