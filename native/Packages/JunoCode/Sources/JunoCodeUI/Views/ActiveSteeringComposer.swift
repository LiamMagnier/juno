import JunoDesignSystem
import SwiftUI

/// The composer shown while a Code run is active.
///
/// Changing direction is intentionally an **interrupt**, not a second concurrent
/// executor. The copy states that boundary directly so the user knows the tool
/// currently in flight will be stopped before the new instruction begins.
struct ActiveSteeringComposer: View {
    let controller: SessionController
    @State private var direction = ""
    @State private var isSending = false
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !direction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSending
            && controller.isAgentTransportConfigured
    }

    var body: some View {
        JunoDesktopGlass(spacing: JunoSpace.snug) {
            VStack(alignment: .leading, spacing: JunoSpace.snug) {
                HStack(spacing: JunoSpace.tight) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Juno is working")
                        .font(.caption.weight(.semibold))
                    Text("·")
                        .junoMetaInk()
                    Text("Send a new direction to interrupt this run and continue in the same session.")
                        .junoCaption()
                        .lineLimit(1)
                    Spacer(minLength: JunoSpace.snug)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "Juno is working. A new direction interrupts this run and continues in the same session."
                )

                TextField("Change direction…", text: $direction, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .font(.body)
                    .padding(.horizontal, JunoSpace.tight)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        submit()
                        return .handled
                    }
                    .accessibilityLabel("Change direction")
                    .accessibilityIdentifier("juno.code.steering.field")

                HStack(spacing: JunoSpace.snug) {
                    Text("Shift-Return for a new line")
                        .junoCaption()
                        .junoMetaInk()
                    Spacer(minLength: 0)

                    Button {
                        Task { await controller.stop() }
                    } label: {
                        JunoIconLabel(verbatim: "Stop", icon: .stop, size: 14)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .contentShape(.rect)
                    .keyboardShortcut(".", modifiers: .command)
                    .help("Stop the current run (⌘.)")
                    .accessibilityIdentifier("juno.code.steering.stop")

                    Button {
                        submit()
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            if isSending {
                                ProgressView().controlSize(.small)
                            } else {
                                JunoIconView(.send, size: 14)
                            }
                            Text("Interrupt & send")
                                .font(.callout.weight(.semibold))
                        }
                        .frame(minWidth: 132, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.junoAccent)
                    .disabled(!canSend)
                    .contentShape(.rect)
                    .help("Stop this run and continue with the new direction")
                    .accessibilityIdentifier("juno.code.steering.send")
                }
            }
            .padding(JunoSpace.snug)
            .junoFloatingChrome(cornerRadius: JunoRadius.composer)
        }
        .task { focused = true }
    }

    private func submit() {
        guard canSend else { return }
        let submitted = direction
        isSending = true
        Task {
            let accepted = await controller.interruptAndSend(submitted)
            await MainActor.run {
                isSending = false
                if accepted { direction = "" }
            }
        }
    }
}
