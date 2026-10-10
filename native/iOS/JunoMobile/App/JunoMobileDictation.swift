import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
#if DEBUG
  import JunoPreviewSupport
#endif

// MARK: - Dictation, in place
//
// The composer, listening. Nothing new arrives on screen: the field keeps its
// place and shows the words as they are heard, and the composer's accessory
// row becomes [✕] [a live waveform] [✓]. ✕ sits where `+` was, ✓ where Send
// is, so the thumb finds both without looking. No second card, no status
// label, no second send button, nothing outside the composer's own edge.
//
// Three pieces, so any composer can embed it (Chat today, Code next):
//
//     @State private var dictation: JunoMobileDictationSession?
//
//     // start
//     let take = JunoMobileDictationSession()
//     dictation = take
//     Task { await take.start() }
//
//     // in the field's slot
//     JunoMobileDictationTranscript(session: take, draft: draft)
//
//     // in the accessory row's slot
//     JunoMobileDictationRow(level: take.level, onCancel: {...}, onDone: {...})
//
// `finish()` returns the words heard (the live hypothesis included) and
// stops the microphone; `cancel()` discards them. The composer appends the
// words to its own draft.

/// One dictation take: the recogniser, its words, and the microphone's level.
///
/// Owns a `JunoSpeechService` for the length of one take. Create a new one
/// per take; a finished or cancelled session does not restart.
@MainActor
@Observable
final class JunoMobileDictationSession: Identifiable {
  let id = UUID()
  private let speech = JunoSpeechService()

  /// Why the take could not start, in words the reader can act on. Nil while
  /// it is working.
  private(set) var failure: String?
  /// True once ✓ or ✕ has been pressed: the row stops answering the voice.
  private(set) var isFinished = false

  init() {}

  /// Committed words, in full ink.
  var finalText: String { speech.finalizedText.trimmingCharacters(in: .whitespaces) }
  /// The hypothesis still being heard, in secondary ink until it settles.
  var partialText: String { speech.partialText.trimmingCharacters(in: .whitespaces) }
  /// Everything heard so far.
  var transcript: String { speech.transcript }
  /// The microphone now, 0...1 on the speech-loudness window: a quiet room
  /// sits near 0, a normal voice reaches the top.
  var level: Double { isListening ? speech.loudness : 0 }
  /// True while the microphone is open and the take is not finishing.
  var isListening: Bool { speech.isListening && !isFinished && failure == nil }

  /// Asks for the microphone and speech permissions, then opens the
  /// microphone. A refusal lands in ``failure``.
  func start() async {
    #if DEBUG
      // `--juno-preview-dictation idle|listening|transcribed`: a take with no
      // microphone behind it, for screenshots on a simulator.
      if let state = JunoComposerPreviewFlags.value("--juno-preview-dictation") {
        startPreview(state)
        return
      }
    #endif
    guard await speech.requestPermission() else {
      failure = String(localized: "Alevr needs the microphone and speech recognition to dictate. Allow them in Settings.")
      return
    }
    guard !isFinished else { return }
    do {
      try speech.start()
    } catch {
      failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
  }

  /// Stops listening and returns every word heard, the live hypothesis
  /// included: it is read *before* the recogniser is torn down, which is the
  /// race that used to drop the last few words.
  @discardableResult
  func finish() -> String {
    isFinished = true
    return speech.stopAndFreeze().trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Stops listening and discards the take.
  func cancel() {
    isFinished = true
    speech.cancel()
  }

  #if DEBUG
    /// A fixed take for snapshots and the simulator.
    func startPreview(_ state: String) {
      switch state {
      case "idle":
        speech.beginPreviewSession(speaking: false)
      case "transcribed":
        speech.beginPreviewSession(
          final: "Can you move the design review to Thursday afternoon and",
          partial: "let the team know"
        )
        speech.seedPreviewHistory()
      default:
        speech.beginPreviewSession(final: "", partial: "Move the design review to")
        speech.seedPreviewHistory(phase: 1.3)
      }
    }
  #endif
}

/// The field's slot while dictating: the draft already typed (quiet), the
/// committed words (full ink) and the live hypothesis (secondary), newest
/// line pinned in view. Same font, inset and six-line ceiling as the text
/// field it stands in for, so the card does not change size as the
/// microphone opens.
struct JunoMobileDictationTranscript: View {
  let session: JunoMobileDictationSession
  /// The words already typed, shown ahead of the heard ones so the field
  /// does not appear to empty as the microphone opens.
  var draft: String = ""

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ScrollView {
      text
        .junoFont(size: 17, relativeTo: .body)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .animation(
          JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint),
          value: session.transcript
        )
    }
    .defaultScrollAnchor(.bottom)
    .scrollBounceBehavior(.basedOnSize)
    .scrollIndicators(.hidden)
    .frame(maxHeight: 132)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityLabel(accessibilityText)
    .accessibilityAddTraits(.updatesFrequently)
    .accessibilityIdentifier("juno.mobile.dictation-preview")
  }

  private var text: Text {
    if let failure = session.failure {
      return Text(verbatim: failure).foregroundStyle(Color.junoSecondaryInk)
    }
    let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let lead = typed.isEmpty
      ? Text(verbatim: "")
      : Text(verbatim: "\(typed) ").foregroundStyle(Color.junoSecondaryInk)
    let final = session.finalText
    let partial = session.partialText
    if final.isEmpty, partial.isEmpty {
      return typed.isEmpty
        ? Text("Speak now.").foregroundStyle(Color.junoSecondaryInk)
        : lead
    }
    let separator = final.isEmpty || partial.isEmpty ? "" : " "
    return Text(
      "\(lead)\(Text(verbatim: final).foregroundStyle(Color.junoForeground))\(separator)\(Text(verbatim: partial).foregroundStyle(Color.junoSecondaryInk))"
    )
  }

  private var accessibilityText: Text {
    if let failure = session.failure { return Text(verbatim: failure) }
    let words = session.transcript
    return words.isEmpty ? Text("Listening") : Text(verbatim: words)
  }
}

/// The accessory row while dictating: ✕ in the `+` slot, the live waveform
/// across the middle, ✓ in Send's slot.
///
/// The row keeps its own short history of `level`, so a host only has to
/// pass the level it already has. Haptics mark the start (on appear) and the
/// end (✕ or ✓).
struct JunoMobileDictationRow: View {
  /// The microphone now, 0...1 (``JunoMobileDictationSession/level``).
  let level: Double
  /// False draws the waveform at rest: the take is finishing or failed.
  let isListening: Bool
  /// Set when the take could not start: the waveform's place offers
  /// Settings instead.
  let needsSettings: Bool
  let onCancel: () -> Void
  let onDone: () -> Void

  @State private var history: [Double] = []
  @State private var startHaptic = 0
  @State private var stopHaptic = 0
  @Environment(\.openURL) private var openURL

  init(
    level: Double,
    isListening: Bool = true,
    needsSettings: Bool = false,
    onCancel: @escaping () -> Void,
    onDone: @escaping () -> Void
  ) {
    self.level = level
    self.isListening = isListening
    self.needsSettings = needsSettings
    self.onCancel = onCancel
    self.onDone = onDone
  }

  /// The row for a take: its level, its state, and Settings if it failed.
  init(
    session: JunoMobileDictationSession,
    onCancel: @escaping () -> Void,
    onDone: @escaping () -> Void
  ) {
    self.init(
      level: session.level,
      isListening: session.isListening,
      needsSettings: session.failure != nil,
      onCancel: onCancel,
      onDone: onDone
    )
  }

  var body: some View {
    HStack(spacing: 0) {
      Button {
        stopHaptic += 1
        onCancel()
      } label: {
        JunoIconView(.close, size: 19)
          .foregroundStyle(Color.junoForeground)
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.junoQuietPress)
      .accessibilityLabel("Cancel dictation")
      .accessibilityIdentifier("juno.mobile.dictation-cancel")

      if needsSettings {
        Spacer(minLength: JunoSpace.snug)
        Button {
          guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
          openURL(url)
        } label: {
          Text("Open Settings")
            .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
            .foregroundStyle(Color.junoForeground)
            .padding(.horizontal, JunoSpace.cozy)
            .frame(height: 36)
            .modifier(JunoGlassCapsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("juno.mobile.dictation-settings")
      } else {
        JunoDictationWaveform(samples: history, active: isListening)
          .frame(maxWidth: .infinity)
          .frame(height: 44)
          .padding(.horizontal, JunoSpace.snug)
      }

      Button {
        stopHaptic += 1
        onDone()
      } label: {
        JunoIconView(.check, size: 18, weight: .bold)
          .foregroundStyle(Color.junoCanvas)
          .frame(width: 36, height: 36)
          .modifier(JunoComposerSendBackground(active: true, tint: Color.primary))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(needsSettings)
      .accessibilityLabel("Done dictating")
      .accessibilityIdentifier("juno.mobile.dictation-done")
    }
    .onChange(of: level, initial: true) { _, value in
      history.append(value)
      if history.count > JunoDictationWaveform.historyCapacity {
        history.removeFirst(history.count - JunoDictationWaveform.historyCapacity)
      }
    }
    .onAppear { startHaptic += 1 }
    .sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: startHaptic)
    .sensoryFeedback(.impact(weight: .medium, intensity: 0.6), trigger: stopHaptic)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Dictation")
    .accessibilityIdentifier("juno.mobile.dictation")
  }
}

extension JunoMobileDictationRow {
  /// For snapshots and previews: a row whose waveform starts full.
  init(
    samples: [Double],
    isListening: Bool = true,
    onCancel: @escaping () -> Void = {},
    onDone: @escaping () -> Void = {}
  ) {
    self.init(level: samples.last ?? 0, isListening: isListening, onCancel: onCancel, onDone: onDone)
    _history = State(initialValue: samples)
  }
}

#if DEBUG
  #Preview("Dictation row") {
    VStack(spacing: JunoSpace.section) {
      JunoMobileDictationRow(
        samples: (0..<72).map { 0.3 + 0.5 * abs(sin(Double($0) / 3)) }
      )
      JunoMobileDictationRow(samples: [])
    }
    .padding()
    .background(Color.junoCanvas)
  }
#endif
