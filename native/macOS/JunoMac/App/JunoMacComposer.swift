import JunoChatKit
import JunoDesignSystem
import SwiftUI

/// The floating Liquid Glass composer.
///
/// It floats over the transcript rather than sitting in a docked bar, so the
/// conversation reads as one continuous surface and the input is always within
/// reach at any window height. Glass is used here — and only here, plus the
/// scroll-to-latest control — because those are the two elements that overlap
/// content; the reading surface itself stays opaque and calm.
struct JunoMacComposer: View {
    @Binding var text: String
    let conversation: NativeConversation
    let catalog: [NativeChatModelOption]
    @Binding var selectedModelID: String
    @Binding var reasoningEffort: NativeReasoningEffort?
    let projectName: String?
    let isGenerating: Bool
    let canSend: Bool
    let send: () -> Void
    let stop: () -> Void

    @FocusState private var isFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedModel: NativeChatModelOption? {
        catalog.first { $0.id == selectedModelID }
    }

    var body: some View {
        VStack(spacing: JunoSpacing.compact) {
            if let projectName {
                contextChip(projectName)
            }

            VStack(spacing: JunoSpace.tight) {
                editor
                controls
            }
            .padding(.horizontal, JunoSpace.cozy)
            .padding(.top, JunoSpace.snug)
            .padding(.bottom, JunoSpace.tight)
            .junoFloatingGlass(cornerRadius: JunoRadius.floating)
            .overlay(
                RoundedRectangle(
                    cornerRadius: JunoRadius.floating,
                    style: .continuous
                )
                // A focused composer states it: a visible ring rather than a
                // hairline that never changes.
                .strokeBorder(
                    isFocused ? Color.junoAccent.opacity(0.55) : Color.junoBorder,
                    lineWidth: isFocused ? 1.5 : 1
                )
            )
            .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
        }
        .frame(maxWidth: 820)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, JunoSpace.region)
        .padding(.bottom, JunoSpace.regular)
        .animation(
            JunoMotion.reduced(JunoMotion.fast, when: reduceMotion),
            value: isFocused
        )
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.body)
            .scrollContentBackground(.hidden)
            .focused($isFocused)
            // Grows with the message up to a ceiling, then scrolls — a composer
            // that can eat the whole window is as bad as one stuck at one line.
            .frame(minHeight: 22, maxHeight: 156)
            .fixedSize(horizontal: false, vertical: true)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text("chat.composer.placeholder")
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 5)
                        .padding(.top, 8)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityLabel(Text("chat.composer.label"))
            .accessibilityIdentifier("juno.mac.chat-composer")
            // ⌘↩ sends; plain ↩ inserts a newline, which is the convention for
            // a multiline desktop composer.
            .onKeyPress(.return, phases: .down) { press in
                guard press.modifiers.contains(.command), canSend else { return .ignored }
                send()
                return .handled
            }
    }

    private var controls: some View {
        HStack(spacing: JunoSpace.tight) {
            attachmentsMenu
            modelPicker
            effortPicker
            Spacer(minLength: JunoSpace.hairline)
            sendOrStop
        }
    }

    /// The `+` actions menu. It lists only what is wired: attachments, Deep
    /// Research and Canvas are recorded as GAP-022/023 and are deliberately
    /// absent rather than shown disabled or faked.
    private var attachmentsMenu: some View {
        Menu {
            Text("chat.actions.none")
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 20, height: 20)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help(Text("chat.actions"))
        .accessibilityLabel(Text("chat.actions"))
        .accessibilityIdentifier("juno.mac.composer-actions")
    }

    @ViewBuilder
    private var modelPicker: some View {
        if catalog.isEmpty {
            // No catalog yet (still loading, or offline): show the
            // conversation's own model humanized rather than an empty control.
            Label(junoDisplayModelName(conversation.model), systemImage: "cpu")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else {
            Picker(selection: $selectedModelID) {
                ForEach(catalog) { option in
                    Text(option.displayName).tag(option.id)
                }
            } label: {
                Text("chat.model")
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .fixedSize()
            .accessibilityLabel(Text("chat.model"))
            .accessibilityIdentifier("juno.mac.model-picker")
        }
    }

    @ViewBuilder
    private var effortPicker: some View {
        if let selectedModel, !selectedModel.supportedReasoningEfforts.isEmpty {
            Picker(selection: $reasoningEffort) {
                if selectedModel.canDisableReasoning {
                    Text("chat.effort.instant").tag(nil as NativeReasoningEffort?)
                }
                ForEach(selectedModel.supportedReasoningEfforts) { effort in
                    Text(effort.displayName).tag(effort as NativeReasoningEffort?)
                }
            } label: {
                Text("chat.effort")
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .fixedSize()
            .accessibilityLabel(Text("chat.effort"))
            .accessibilityIdentifier("juno.mac.effort-picker")
        }
    }

    @ViewBuilder
    private var sendOrStop: some View {
        if isGenerating {
            Button(action: stop) {
                // Icon-only via `Label`, not a bare `Image`: an Image-only
                // button reaches VoiceOver unnamed.
                Label("chat.stop", systemImage: "stop.fill")
                    .labelStyle(.iconOnly)
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .background(Circle().fill(Color.junoAccent))
            .help(Text("chat.stop"))
            .accessibilityIdentifier("juno.mac.chat-stop")
            .transition(.scale.combined(with: .opacity))
        } else {
            Button(action: send) {
                Label("chat.send", systemImage: "arrow.up")
                    .labelStyle(.iconOnly)
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? Color.white : Color.secondary)
            .background(
                Circle().fill(canSend ? Color.junoAccent : Color.junoHairline)
            )
            .disabled(!canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help(Text("chat.send"))
            .accessibilityIdentifier("juno.mac.chat-send")
            .transition(.scale.combined(with: .opacity))
        }
    }

    private func contextChip(_ name: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "folder")
                .font(.caption2)
            Text(name)
                .font(.caption)
                .lineLimit(1)
        }
        .padding(.horizontal, JunoSpacing.control)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous).fill(Color.junoAccent.opacity(0.14))
        )
        .foregroundStyle(Color.junoAccent)
        .accessibilityLabel(Text("chat.context.project \(name)"))
    }
}

extension NativeReasoningEffort {
    /// A human label for the effort ladder. The raw values are API tokens and
    /// should never reach the interface.
    var displayName: LocalizedStringKey {
        switch self {
        case .minimal: "chat.effort.minimal"
        case .low: "chat.effort.low"
        case .medium: "chat.effort.medium"
        case .high: "chat.effort.high"
        case .xhigh: "chat.effort.xhigh"
        case .max: "chat.effort.max"
        }
    }
}
