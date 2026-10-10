import JunoDesignSystem
import JunoVoiceKit
import SwiftUI

// A self-contained listening composer for hosts that cannot yet swap their
// own field and controls row (Code's workspace mounts it over its composer).
//
// Host usage: prefer the in-shell pieces in `ComposerDictation.swift`
// (`ComposerDictationField`, `ComposerDictationControls`,
// `ComposerDictationGlow`), which replace the host's own field and row in
// place. Where that is not possible yet, mount this *instead of* the host's
// composer, never on top of a visible one:
//
//     DesktopDictation(onCancel: {...}, onStop: { words in ... }, onSend: { words in ... })
//
// It is the same object as Chat's composer while it listens: the composer
// glass, the words in the field slot, ✕ · waveform · ✓ Done in the controls
// row and the voice light on its edge. ✓ calls `onStop` with the words;
// Return calls `onSend`. There is no send disc.
struct DesktopDictation: View {
    let onCancel: () -> Void
    let onStop: (String) -> Void
    let onSend: (String) -> Void

    @State private var session = ComposerDictationSession()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ComposerDictationField(session: session)
                .padding(JunoComposerMetrics.fieldInsets)
                .frame(minHeight: JunoComposerMetrics.fieldMinimumHeight)
            ComposerDictationControls(session: session, cancel: cancel, done: stop)
                .padding(JunoComposerMetrics.controlsInsets)
        }
        .frame(maxWidth: JunoComposerMetrics.maxWidth)
        .junoComposerGlass()
        .overlay { ComposerDictationGlow(session: session) }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.escape) {
            cancel()
            return .handled
        }
        .onKeyPress(.return, phases: .down) { _ in
            if session.hasWords { send() }
            return .handled
        }
        .onAppear { focused = true }
        .task { await session.begin() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Dictation")
        .accessibilityIdentifier("juno.desktop.dictation")
    }

    private func cancel() {
        session.cancel()
        onCancel()
    }

    private func stop() {
        onStop(session.finish())
    }

    private func send() {
        let words = session.finish().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            onCancel()
            return
        }
        onSend(words)
    }
}
