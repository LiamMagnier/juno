import JunoDesignSystem
import JunoVoiceKit
import SwiftUI
import UIKit

/// Full-screen voice: the orb, live captions, and the call's controls.
///
/// The dock is the default and stays so — a call that runs *beside* the chat
/// is what lets the reader drop a photo in mid-sentence. This is the other
/// mode, the one ChatGPT keeps behind "Separate mode": the reader has chosen
/// to look at the call, so the orb is the thing to look at, the transcript is
/// captions under it, and every control is a thumb's reach from the bottom.
/// Swiping the dock up opens it; the chevron or a swipe down goes back to the
/// dock with the call untouched.
struct JunoMobileVoiceFullScreen: View {
  let session: JunoMobileVoiceSession
  let close: () -> Void

  @AppStorage(JunoMobilePreferences.voicePushToTalk) private var pushToTalk = false
  @State private var captions = true
  @State private var holding = false
  @State private var dragOffset: CGFloat = 0
  @State private var muteHaptic = JunoMobileHapticTrigger()
  @State private var pushHaptic = JunoMobileHapticTrigger()
  @State private var endHaptic = JunoMobileHapticTrigger()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL

  private var controller: JunoRealtimeVoiceController { session.controller }
  private var canSee: Bool { controller.capabilities?.videoInput == true }

  var body: some View {
    ZStack {
      Color.junoCanvas.ignoresSafeArea()
      // The field, dimmed, as the room the orb sits in.
      JunoVoiceAura(
        level: controller.level,
        speaking: controller.assistantSpeaking,
        active: session.isLive
      )
      .opacity(0.55)
      .ignoresSafeArea()

      VStack(spacing: 0) {
        topBar
        Spacer(minLength: 0)
        orb
        status
        Spacer(minLength: 0)
        // Nothing to caption before the call is up, or after it is down: an
        // empty well under "Connecting…" is a box with nothing in it.
        if captions, session.isLive || !controller.transcript.isEmpty { captionsPanel }
        JunoMobileVoiceSelfView(camera: session.camera) { session.camera.stop() }
          .padding(.bottom, JunoSpace.cozy)
        controls
      }
      .padding(.bottom, JunoSpace.regular)
    }
    .offset(y: max(0, dragOffset))
    .simultaneousGesture(
      DragGesture(minimumDistance: 20)
        .onChanged { value in
          guard value.translation.height > 0, abs(value.translation.height) > abs(value.translation.width)
          else { return }
          dragOffset = value.translation.height
        }
        .onEnded { value in
          if value.translation.height > 140 || value.predictedEndTranslation.height > 300 {
            close()
          } else {
            withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
              dragOffset = 0
            }
          }
        }
    )
    .junoHaptic(JunoMobileHaptic.mute, trigger: muteHaptic)
    .junoHaptic(JunoMobileHaptic.pushToTalk, trigger: pushHaptic)
    .junoHaptic(JunoMobileHaptic.stop, trigger: endHaptic)
    .sensoryFeedback(JunoMobileHaptic.connect, trigger: session.isLive) { _, live in live }
    .onChange(of: pushToTalk, initial: true) { _, on in
      // Push to talk starts muted: the orb is the microphone.
      if on, session.isLive, !controller.muted { controller.setMuted(true) }
    }
    .onChange(of: session.isLive) { _, live in
      if live, pushToTalk, !controller.muted { controller.setMuted(true) }
    }
    .accessibilityIdentifier("juno.mobile.voice-fullscreen")
  }

  // MARK: - Top

  private var topBar: some View {
    HStack {
      Button(action: close) {
        JunoIconView(.chevronDown, size: 16)
          .foregroundStyle(.primary)
          .frame(width: 44, height: 44)
          .modifier(JunoGlassCircle())
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back to chat")
      .accessibilityIdentifier("juno.mobile.voice-collapse")

      Spacer()

      Button {
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
          captions.toggle()
        }
      } label: {
        Image(systemName: captions ? "captions.bubble.fill" : "captions.bubble")
          .junoFont(size: 16, relativeTo: .body)
          .foregroundStyle(captions ? Color.junoAccent : Color.primary)
          .frame(width: 44, height: 44)
          .modifier(JunoGlassCircle())
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(captions ? "Hide captions" : "Show captions")
      .accessibilityIdentifier("juno.mobile.voice-captions")

      Menu {
        Section("voice.provider") {
          ForEach(JunoVoiceProvider.allCases) { provider in
            Button {
              controller.switchProvider(provider)
            } label: {
              if provider == controller.provider {
                Label(provider.displayName, systemImage: "checkmark")
              } else {
                Text(provider.displayName)
              }
            }
            .disabled(provider == controller.provider)
          }
        }
        Section {
          Toggle(isOn: $pushToTalk) {
            Label("Push to talk", systemImage: "hand.tap")
          }
        }
        if !canSee {
          Section {
            JunoIconLabel("voice.camera.unsupported", icon: .photos)
          }
        }
      } label: {
        JunoIconView(.ellipsis, size: 16)
          .foregroundStyle(.primary)
          .frame(width: 44, height: 44)
          .modifier(JunoGlassCircle())
          .contentShape(Circle())
      }
      .tint(Color.primary)
      .accessibilityLabel("voice.options")
      .accessibilityIdentifier("juno.mobile.voice-fullscreen-options")
    }
    .padding(.horizontal, JunoSpace.regular)
    .padding(.top, JunoSpace.snug)
  }

  // MARK: - Orb

  private var orb: some View {
    JunoVoiceOrb(
      level: controller.level,
      speaking: controller.assistantSpeaking,
      active: session.isLive,
      pressed: holding
    )
    .frame(width: 260, height: 260)
    .contentShape(Circle())
    .gesture(orbGesture)
    .accessibilityElement()
    .accessibilityLabel(pushToTalk ? "Hold to talk" : "Tap to interrupt")
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("juno.mobile.voice-orb")
    .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion), value: holding)
  }

  /// Push to talk holds the mic open for the press; otherwise a tap interrupts
  /// Juno mid-sentence, the one gesture the dock also carries.
  private var orbGesture: some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { _ in
        guard pushToTalk, session.isLive, !holding else { return }
        holding = true
        pushHaptic.fire()
        controller.setMuted(false)
      }
      .onEnded { _ in
        if pushToTalk {
          guard holding else { return }
          holding = false
          pushHaptic.fire()
          controller.setMuted(true)
        } else if session.isLive, controller.assistantSpeaking {
          controller.interrupt()
        }
      }
  }

  private var status: some View {
    VStack(spacing: JunoSpace.hairline) {
      Text(statusTitle)
        .junoFont(size: 20, relativeTo: .title3, weight: .semibold)
        .contentTransition(.opacity)
        .animation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint), value: statusKey)
      HStack(spacing: JunoSpace.tight) {
        if let cost = costLabel {
          Text(cost).monospacedDigit()
        }
        if let route = session.audioSession.outputRouteName, session.audioSession.isExternalRoute {
          if costLabel != nil { Text("·") }
          Text(route)
        }
        if session.audioSession.interrupted {
          Text("· Paused for a call")
        }
      }
      .junoFont(size: 13, relativeTo: .footnote)
      .junoSecondaryInk()
      if let notice = controller.notice ?? failureMessage {
        Text(notice)
          .junoFont(size: 13, relativeTo: .footnote)
          .foregroundStyle(Color.junoCaution)
          .multilineTextAlignment(.center)
          .padding(.horizontal, JunoSpace.section)
          .padding(.top, JunoSpace.tight)
      }
      if case .error(let error) = controller.phase, error.isPermissionDenial {
        Button("voice.open-settings") {
          guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
          openURL(url)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.junoAccent)
        .padding(.top, JunoSpace.tight)
      }
    }
    .padding(.top, JunoSpace.regular)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.updatesFrequently)
  }

  private var statusKey: String { "\(controller.phase)-\(controller.assistantSpeaking)-\(controller.muted)-\(holding)" }

  private var statusTitle: LocalizedStringKey {
    switch controller.phase {
    case .idle, .connecting: return "voice.status.connecting"
    case .reconnecting: return "voice.status.reconnecting"
    case .error: return "voice.status.unavailable"
    case .ended: return "voice.status.session-ended"
    case .live:
      if controller.sessionPhase == .interrupting { return "voice.status.interrupting" }
      if controller.assistantSpeaking { return "voice.status.speaking" }
      if pushToTalk { return holding ? "voice.status.listening" : "Hold to talk" }
      return controller.muted ? "voice.status.muted" : "voice.status.listening"
    }
  }

  private var costLabel: String? {
    guard let usage = controller.usage, usage.estCostUsd > 0 else { return nil }
    if usage.estCostUsd < 0.01 { return String(format: "~$%.4f", usage.estCostUsd) }
    if usage.estCostUsd < 1 { return String(format: "~$%.3f", usage.estCostUsd) }
    return String(format: "~$%.2f", usage.estCostUsd)
  }

  private var failureMessage: String? {
    switch controller.phase {
    case .error(let error): return error.errorDescription
    case .ended(let reason):
      return switch reason {
      case .sessionLimit: String(localized: "voice.ended.limit")
      case .provider: String(localized: "voice.ended.provider")
      case .error: String(localized: "voice.ended.error")
      case .client: nil
      }
    default: return nil
    }
  }

  // MARK: - Captions

  /// The last few lines of the call, newest at the bottom, with the live
  /// hypothesis dimmed until it settles.
  private var captionsPanel: some View {
    let lines = controller.transcript.suffix(4).filter {
      !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return VStack(alignment: .leading, spacing: JunoSpace.snug) {
      if lines.isEmpty {
        Text(session.isLive ? "Captions appear here as you talk." : " ")
          .junoFont(size: 14, relativeTo: .subheadline)
          .junoMetaInk()
      }
      ForEach(lines) { line in
        HStack(alignment: .top, spacing: JunoSpace.snug) {
          Text(line.role == .assistant ? "Juno" : "You")
            .junoFont(size: 11, relativeTo: .caption2, weight: .semibold)
            .foregroundStyle(line.role == .assistant ? Color.junoAccent : Color.junoMutedForeground)
            .frame(width: 34, alignment: .leading)
            .padding(.top, 2)
          Text(line.text)
            .junoFont(size: 15, relativeTo: .body)
            .foregroundStyle(line.final ? Color.junoForeground : Color.junoMutedForeground)
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .transition(.junoInline)
      }
    }
    .padding(JunoSpace.regular)
    .frame(maxWidth: 520)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .fill(Color.junoSurface.opacity(0.9))
    )
    .overlay(
      RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
        .strokeBorder(Color.junoHairline, lineWidth: 1)
    )
    .padding(.horizontal, JunoSpace.regular)
    .padding(.bottom, JunoSpace.cozy)
    .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: lines.map(\.id))
    .accessibilityIdentifier("juno.mobile.voice-captions-panel")
  }

  // MARK: - Controls

  private var controls: some View {
    JunoGlass(spacing: JunoSpace.cozy) {
      HStack(spacing: JunoSpace.cozy) {
        if !pushToTalk {
          control(
            icon: .mic,
            label: controller.muted ? "voice.unmute" : "voice.mute",
            identifier: "juno.mobile.voice-fullscreen-mute",
            active: controller.muted
          ) {
            muteHaptic.fire()
            controller.setMuted(!controller.muted)
          }
          .disabled(!session.isLive)
        }
        if canSee {
          control(
            icon: .photos,
            label: session.camera.isLive ? "voice.camera.stop" : "voice.camera.start",
            identifier: "juno.mobile.voice-fullscreen-camera",
            active: session.camera.isLive
          ) {
            if session.camera.isLive {
              session.camera.stop()
            } else {
              session.screenShare.stop()
              Task { await session.camera.start(sending: controller) }
            }
          }
          .disabled(!session.isLive || session.camera.isBusy)
          control(
            icon: .artifactsTool,
            label: session.screenShare.isLive ? "Stop screen sharing" : "Start screen sharing",
            identifier: "juno.mobile.voice-fullscreen-screen",
            active: session.screenShare.isLive
          ) {
            if session.screenShare.isLive {
              session.screenShare.stop()
            } else {
              session.camera.stop()
              Task { await session.screenShare.start(sending: controller) }
            }
          }
          .disabled(!session.isLive || session.screenShare.isBusy)
        }
        control(
          icon: .volume,
          label: controller.speakerOutput ? "voice.speaker.on" : "voice.speaker.off",
          identifier: "juno.mobile.voice-fullscreen-speaker",
          active: controller.speakerOutput && !session.audioSession.isExternalRoute
        ) {
          controller.toggleSpeaker()
        }
        .disabled(session.audioSession.isExternalRoute)

        Button {
          endHaptic.fire()
          session.hangUp()
        } label: {
          JunoIconView(.close, size: 18)
            .foregroundStyle(Color.junoCanvas)
            .frame(width: 56, height: 56)
            .background(Color.junoDanger, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("voice.end")
        .accessibilityIdentifier("juno.mobile.voice-fullscreen-end")
      }
      .padding(.horizontal, JunoSpace.cozy)
      .padding(.vertical, JunoSpace.snug)
      .junoGlass(in: Capsule())
    }
    .padding(.horizontal, JunoSpace.regular)
  }

  private func control(
    icon: JunoIcon, label: LocalizedStringKey, identifier: String, active: Bool,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      JunoIconView(icon, size: 18)
        .foregroundStyle(active ? AnyShapeStyle(.background) : AnyShapeStyle(.primary))
        .frame(width: 48, height: 48)
        .background(active ? Color.primary : Color.primary.opacity(0.08), in: Circle())
        .frame(width: 56, height: 56)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier(identifier)
  }
}
