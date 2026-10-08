import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoVoiceKit
import SwiftUI
import UIKit
import UserNotifications

/// Preferences that belong to this phone rather than to the account.
///
/// Whether a call keeps running in the background, whether the orb is held
/// to talk, which Mac Code opens on — these describe how *this device* behaves
/// and would be wrong to sync to a Mac. `@AppStorage` keys, named in one place
/// so a page and the feature it configures read the same string.
enum JunoMobilePreferences {
  static let voiceBackground = "juno.mobile.voice.background"
  static let voicePushToTalk = "juno.mobile.voice.push-to-talk"
  static let voiceProvider = "juno.mobile.voice.provider"
  static let voiceSpeakerDefault = "juno.mobile.voice.speaker"
  /// Shared with the controller that plays the chimes, so it reads JunoVoiceKit's key.
  static let voiceSounds = JunoVoiceCues.defaultsKey
  static let codeDefaultHost = "juno.mobile.code.default-host"
  static let codeApprovalNotifications = "juno.mobile.code.notify-approvals"
  static let codeCompletionNotifications = "juno.mobile.code.notify-completions"
}

// MARK: - Voice

/// Settings › Voice: the voice, and how a call behaves on this phone.
struct JunoMobileVoiceSettingsView: View {
  let settings: NativeAccountSettings?
  let disabled: Bool
  let update: @MainActor @Sendable (NativeSettingsPatch) -> Void
  var messageActions: NativeMessageActionsClient?
  var accountID: AccountID?
  /// The live speech provider (`GET /api/settings`); the picker lists its
  /// voices, as the web's `voicesFor(features.ttsProvider)` does.
  var ttsProvider: NativeTTSProviderStatus = .unknown

  @AppStorage(JunoMobilePreferences.voiceBackground) private var background = true
  @AppStorage(JunoMobilePreferences.voicePushToTalk) private var pushToTalk = false
  @AppStorage(JunoMobilePreferences.voiceProvider) private var providerRaw = ""
  /// Shared with the call's own menu through ``JunoVoiceReasoningEffort/storageKey(for:)``.
  @AppStorage(JunoVoiceReasoningEffort.storageKey(for: .openai))
  private var openaiEffortRaw = JunoVoiceProvider.openai.defaultReasoningEffort.rawValue
  @AppStorage(JunoVoiceReasoningEffort.storageKey(for: .gemini))
  private var geminiEffortRaw = JunoVoiceProvider.gemini.defaultReasoningEffort.rawValue
  @AppStorage(JunoMobilePreferences.voiceSpeakerDefault) private var speakerDefault = true
  @AppStorage(JunoMobilePreferences.voiceSounds) private var voiceSounds = true
  @State private var readAloud: JunoMobileReadAloud?
  @State private var selectionHaptic = JunoMobileHapticTrigger()

  private var voices: [NativeSettingsChoice] {
    NativeVoiceCatalog.voices(for: ttsProvider)
  }

  /// What will be heard: the saved voice when this provider lists it, else
  /// the provider's default (`sections/voice.tsx`).
  private var voiceID: String? {
    NativeVoiceCatalog.selectedVoice(saved: settings?.voiceID, for: ttsProvider)?.id
  }

  private var provider: Binding<JunoVoiceProvider> {
    Binding(
      get: { JunoVoiceProvider(rawValue: providerRaw) ?? .productionDefault },
      set: { providerRaw = $0.rawValue }
    )
  }

  var body: some View {
    Form {
      Section {
        if voices.isEmpty {
          Text(NativeVoiceCatalog.unavailableDescription(for: ttsProvider))
            .foregroundStyle(.secondary)
        }
        ForEach(voices) { voice in
          Button {
            selectionHaptic.fire()
            update(NativeSettingsPatch(voiceID: .some(voice.id)))
          } label: {
            HStack(spacing: JunoSpace.cozy) {
              VStack(alignment: .leading, spacing: 2) {
                Text(voice.label)
                  .junoRowLabel()
                  .foregroundStyle(.primary)
                Text(voice.description)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
              Spacer(minLength: JunoSpace.tight)
              Button {
                preview(voice)
              } label: {
                Image(systemName: readAloud?.isSpeaking("voice-\(voice.id)") == true ? "stop.circle" : "speaker.wave.2")
                  .font(.body)
                  .foregroundStyle(.secondary)
                  .frame(width: 44, height: 44)
                .contentShape(Circle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Preview \(voice.label)")
              Image(systemName: "checkmark")
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .opacity(voice.id == voiceID ? 1 : 0)
                .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(disabled || settings == nil)
          .accessibilityAddTraits(voice.id == voiceID ? .isSelected : [])
          .accessibilityIdentifier("juno.mobile.voice-\(voice.id)")
        }
      } header: {
        Text("Voice")
      } footer: {
        Text("Used when Alevr reads a reply aloud and in voice conversations. Stored on your account, so the web and the Mac use it too.")
      }

      Section {
        Picker("Provider", selection: provider) {
          ForEach(JunoVoiceProvider.allCases) { provider in
            Text("\(provider.displayName) · \(provider.modelName)").tag(provider)
          }
        }
        if provider.wrappedValue.offersReasoningEffort, let delegate = provider.wrappedValue.delegateModelName {
          // The composer's own Thinking track (JunoThinkingTrack), one dial
          // per provider, remembered on this phone.
          let chosen = provider.wrappedValue
          let raw = chosen == .gemini ? $geminiEffortRaw : $openaiEffortRaw
          let effort = JunoVoiceReasoningEffort(rawValue: raw.wrappedValue) ?? chosen.defaultReasoningEffort
          VStack(alignment: .leading, spacing: JunoSpace.snug) {
            HStack {
              Text("voice.thinking")
              Spacer(minLength: JunoSpace.tight)
              Text(verbatim: effort.displayName)
                .foregroundStyle(.secondary)
            }
            JunoThinkingTrack(
              ladder: JunoThinkingLadder(
                stops: chosen.reasoningEfforts.map {
                  JunoThinkingStop(id: $0.rawValue, label: $0.displayName, accessibilityLabel: "Thinking \($0.displayName)")
                },
                modelName: delegate
              ),
              stopID: Binding(get: { raw.wrappedValue }, set: { if let id = $0 { raw.wrappedValue = id } })
            )
            .frame(height: 44)
            Text(
              verbatim: "\(chosen.modelName(at: effort)) answers. \(delegate) takes the harder questions at "
                + "\(chosen.delegateEffort(at: effort).displayName.lowercased()) and can search the web."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
          }
          .accessibilityIdentifier("juno.mobile.voice-effort-setting")
        }
        Toggle(isOn: $background) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Background conversations")
            Text("Keep talking when you leave the app or lock the screen.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("juno.mobile.voice-background")
        Toggle(isOn: $pushToTalk) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Push to talk")
            Text("Hold the orb to speak, release to send. Off, Alevr listens continuously.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("juno.mobile.voice-push-to-talk")
        Toggle(isOn: $speakerDefault) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Start on speaker")
            Text("Off, a call starts in the earpiece like a phone call.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        Toggle(isOn: $voiceSounds) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Voice sounds")
            Text("A soft chime when a call can hear you, and another when it ends. Silent when your iPhone is.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("juno.mobile.voice-sounds")
      } header: {
        Text("Conversations")
      } footer: {
        Text("These are settings for this iPhone.")
      }
    }
    .junoGroupedPage()
    .navigationTitle("Voice")
    .navigationBarTitleDisplayMode(.inline)
    .junoHaptic(JunoMobileHaptic.selection, trigger: selectionHaptic)
    .onDisappear { readAloud?.stop() }
    .accessibilityIdentifier("juno.mobile.settings-voice")
  }

  private func preview(_ voice: NativeSettingsChoice) {
    if readAloud == nil {
      readAloud = JunoMobileReadAloud(client: messageActions, accountID: accountID)
    }
    readAloud?.toggle(
      messageID: "voice-\(voice.id)",
      text: "Hi, I'm Alevr. This is how \(voice.label) sounds.",
      voiceID: voice.id
    )
  }
}

// MARK: - Notifications

/// Settings › Notifications: the phone's real permission state, what Juno
/// notifies about, and the two account emails.
struct JunoMobileNotificationSettingsView: View {
  let settings: NativeAccountSettings?
  let disabled: Bool
  let update: @MainActor @Sendable (NativeSettingsPatch) -> Void

  @AppStorage(JunoMobilePreferences.codeApprovalNotifications) private var notifyApprovals = true
  @AppStorage(JunoMobilePreferences.codeCompletionNotifications) private var notifyCompletions = true
  /// This phone's push switches. The registrar keeps them on the device and
  /// tells the server when one changes, so a switch here is the whole story.
  @State private var pushes = NativePushRegistrar.shared
  @State private var authorization: UNAuthorizationStatus?
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Form {
      Section {
        HStack(spacing: JunoSpace.cozy) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Notifications on this iPhone")
            Text(statusLine)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: JunoSpace.tight)
          switch authorization {
          // Quiet delivery is where sign-in leaves a phone that was never
          // asked, so it offers the real question too.
          case .notDetermined?, .provisional?:
            Button("Allow") { Task { await requestPermission() } }
              .buttonStyle(.bordered)
                    .accessibilityIdentifier("juno.mobile.notifications-allow")
          case .denied?:
            Button("Open Settings") {
              guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
              openURL(url)
            }
            .buttonStyle(.bordered)
          case .authorized?, .ephemeral?:
            Text("On")
              .foregroundStyle(.secondary)
          default:
            ProgressView().controlSize(.small)
          }
        }
        .frame(minHeight: 44)
      } footer: {
        Text("Alevr only notifies you about things you asked it to do.")
      }

      Section {
        Toggle(isOn: $pushes.preferences.needsYou) {
          VStack(alignment: .leading, spacing: 2) {
            Text("When something needs you")
            Text("An approval or a question a task is waiting on.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!isAuthorized)
        .accessibilityIdentifier("juno.mobile.notifications-needs-you")
        Toggle(isOn: $pushes.preferences.updates) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Updates")
            Text("A task finished, an agent has ideas, or one agent handed work to another.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!isAuthorized)
        .accessibilityIdentifier("juno.mobile.notifications-updates")
      } header: {
        Text("Agents and Work")
      } footer: {
        Text(pushes.lastError ?? "Sent to this iPhone even when Alevr is closed. These switches are for this iPhone only.")
      }

      Section("Code") {
        Toggle(isOn: $notifyApprovals) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Approvals")
            Text("When a session on your Mac is waiting for a yes.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!isAuthorized)
        .accessibilityIdentifier("juno.mobile.notifications-approvals")
        Toggle(isOn: $notifyCompletions) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Completions")
            Text("When a session you started from here finishes.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .disabled(!isAuthorized)
      }

      if let settings {
        Section {
          Toggle(isOn: binding(settings, \.emailBudgetAlerts) { NativeSettingsPatch(emailBudgetAlerts: $0) }) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Budget alerts")
              Text("Email me at 80% of my monthly budget.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
          }
            .disabled(disabled)
          .accessibilityIdentifier("juno.mobile.settings-budget-alerts")
          Toggle(isOn: binding(settings, \.emailWeeklyDigest) { NativeSettingsPatch(emailWeeklyDigest: $0) }) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Weekly digest")
              Text("Usage recap every Monday.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
          }
            .disabled(disabled)
          .accessibilityIdentifier("juno.mobile.settings-weekly-digest")
        } header: {
          Text("Email")
        } footer: {
          Text("Both go to your account's email address and are stored on the account — turning one off here turns it off on the web too.")
        }
      }
    }
    .junoGroupedPage()
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .task { await refreshAuthorization() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await refreshAuthorization() } }
    }
    .accessibilityIdentifier("juno.mobile.settings-notifications")
  }

  private var isAuthorized: Bool {
    switch authorization {
    case .authorized?, .provisional?, .ephemeral?: true
    default: false
    }
  }

  private var statusLine: String {
    switch authorization {
    case .authorized?: "Allowed"
    case .provisional?: "Delivered quietly"
    case .ephemeral?: "Allowed for now"
    case .denied?: "Off in iOS Settings"
    case .notDetermined?: "Not asked yet"
    default: "Checking…"
    }
  }

  private func refreshAuthorization() async {
    authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
  }

  private func requestPermission() async {
    await pushes.requestFullAuthorization()
    await refreshAuthorization()
  }

  private func binding<Value: Equatable & Sendable>(
    _ settings: NativeAccountSettings,
    _ keyPath: KeyPath<NativeAccountSettings, Value> & Sendable,
    patch: @escaping @Sendable (Value) -> NativeSettingsPatch
  ) -> Binding<Value> {
    let update = update
    return Binding(
      get: { settings[keyPath: keyPath] },
      set: { value in
        guard value != settings[keyPath: keyPath] else { return }
        MainActor.assumeIsolated { update(patch(value)) }
      }
    )
  }
}

// MARK: - Juno Code

/// Settings › Juno Code: which Mac opens first, notifications, and the
/// paired hosts.
struct JunoMobileCodeSettingsView: View {
  var remoteModel: CodeRemoteBrowserModel?

  @AppStorage(JunoMobilePreferences.codeDefaultHost) private var defaultHost = ""
  @AppStorage(JunoMobilePreferences.codeApprovalNotifications) private var notifyApprovals = true

  var body: some View {
    Form {
      Section {
        Picker("Default host", selection: $defaultHost) {
          Text("Most recently online").tag("")
          ForEach(remoteModel?.hosts ?? []) { host in
            Text(host.name).tag(host.id)
          }
        }
        .accessibilityIdentifier("juno.mobile.code-default-host")
        NavigationLink {
          JunoMobileCodeDevicesView(remoteModel: remoteModel)
        } label: {
          HStack {
            Text("Paired computers")
            Spacer()
            Text("\(remoteModel?.hosts.count ?? 0)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("juno.mobile.code-devices")
      } header: {
        Text("Remote")
      } footer: {
        Text("Alevr Code on your Mac registers itself with your account when you turn on Remote there. Nothing runs on a computer that has not opted in.")
      }

      Section {
        Toggle(isOn: $notifyApprovals) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Notify me for approvals")
            Text("A local notification when a session is waiting on you while Alevr is in the background.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
      } header: {
        Text("Notifications")
      }
    }
    .junoGroupedPage()
    .navigationTitle("Code")
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("juno.mobile.settings-code")
  }
}
