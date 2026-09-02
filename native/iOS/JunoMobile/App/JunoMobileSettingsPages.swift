import JunoChatKit
import JunoCodeKit
import JunoCore
import JunoDesignSystem
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
  static let codeDefaultHost = "juno.mobile.code.default-host"
  static let codeApprovalNotifications = "juno.mobile.code.notify-approvals"
  static let codeCompletionNotifications = "juno.mobile.code.notify-completions"
}

/// The read-aloud and voice-mode voices, as the web lists them.
///
/// A copy of `src/lib/voices.ts` rather than a request: the list is the API's
/// own enumeration and changes with a release, not with an account, and the
/// preview button is the real answer to what a voice sounds like.
struct JunoMobileVoiceOption: Identifiable, Hashable {
  let id: String
  let label: String
  let detail: String

  static let all: [JunoMobileVoiceOption] = [
    .init(id: "alloy", label: "Alloy", detail: "Neutral and crisp"),
    .init(id: "echo", label: "Echo", detail: "Even and measured"),
    .init(id: "fable", label: "Fable", detail: "Bright and expressive"),
    .init(id: "onyx", label: "Onyx", detail: "Low and steady"),
    .init(id: "nova", label: "Nova", detail: "Rounded and friendly"),
    .init(id: "shimmer", label: "Shimmer", detail: "Light and airy"),
    .init(id: "coral", label: "Coral", detail: "Warm and lively"),
    .init(id: "verse", label: "Verse", detail: "Animated and varied"),
    .init(id: "ballad", label: "Ballad", detail: "Soft and unhurried"),
    .init(id: "ash", label: "Ash", detail: "Firm and direct"),
    .init(id: "sage", label: "Sage", detail: "Calm and level"),
    .init(id: "marin", label: "Marin", detail: "Relaxed and conversational"),
    .init(id: "cedar", label: "Cedar", detail: "Smooth and easy-going"),
  ]

  static let defaultID = "alloy"
}

// MARK: - Voice

/// Settings › Voice: the voice, and how a call behaves on this phone.
struct JunoMobileVoiceSettingsView: View {
  let settings: NativeAccountSettings?
  let disabled: Bool
  let update: @MainActor @Sendable (NativeSettingsPatch) -> Void
  var messageActions: NativeMessageActionsClient?
  var accountID: AccountID?

  @AppStorage(JunoMobilePreferences.voiceBackground) private var background = true
  @AppStorage(JunoMobilePreferences.voicePushToTalk) private var pushToTalk = false
  @AppStorage(JunoMobilePreferences.voiceProvider) private var providerRaw = ""
  @AppStorage(JunoMobilePreferences.voiceSpeakerDefault) private var speakerDefault = true
  @State private var readAloud: JunoMobileReadAloud?
  @State private var selectionHaptic = JunoMobileHapticTrigger()

  private var voiceID: String {
    settings?.voiceID ?? JunoMobileVoiceOption.defaultID
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
        ForEach(JunoMobileVoiceOption.all) { voice in
          Button {
            selectionHaptic.fire()
            update(NativeSettingsPatch(voiceID: .some(voice.id)))
          } label: {
            HStack(spacing: JunoSpace.cozy) {
              VStack(alignment: .leading, spacing: 2) {
                Text(voice.label)
                  .junoRowLabel()
                  .foregroundStyle(.primary)
                Text(voice.detail)
                  .junoCaption()
              }
              Spacer(minLength: JunoSpace.tight)
              Button {
                preview(voice)
              } label: {
                JunoIconView(
                  readAloud?.isSpeaking("voice-\(voice.id)") == true ? .stop : .volume, size: 15
                )
                .foregroundStyle(Color.junoAccent)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Preview \(voice.label)")
              if voice.id == voiceID {
                JunoIconView(.check, size: 15)
                  .foregroundStyle(Color.junoAccent)
                  .accessibilityHidden(true)
              }
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
        Text("Used when Juno reads a reply aloud and in voice conversations. Stored on your account, so the web and the Mac use it too.")
      }

      Section {
        Picker("Provider", selection: provider) {
          ForEach(JunoVoiceProvider.allCases) { provider in
            Text(provider.displayName).tag(provider)
          }
        }
        Toggle(isOn: $background) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Background conversations")
            Text("Keep talking when you leave the app or lock the screen.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
        .accessibilityIdentifier("juno.mobile.voice-background")
        Toggle(isOn: $pushToTalk) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Push to talk")
            Text("Hold the orb to speak, release to send. Off, Juno listens continuously.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
        .accessibilityIdentifier("juno.mobile.voice-push-to-talk")
        Toggle(isOn: $speakerDefault) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Start on speaker")
            Text("Off, a call starts in the earpiece like a phone call.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
      } header: {
        Text("Conversations")
      } footer: {
        Text("These are settings for this iPhone.")
      }
    }
    .scrollContentBackground(.hidden)
    .junoScreenCanvas()
    .navigationTitle("Voice")
    .navigationBarTitleDisplayMode(.inline)
    .junoHaptic(JunoMobileHaptic.selection, trigger: selectionHaptic)
    .onDisappear { readAloud?.stop() }
    .accessibilityIdentifier("juno.mobile.settings-voice")
  }

  private func preview(_ voice: JunoMobileVoiceOption) {
    if readAloud == nil {
      readAloud = JunoMobileReadAloud(client: messageActions, accountID: accountID)
    }
    readAloud?.toggle(
      messageID: "voice-\(voice.id)",
      text: "Hi, I'm Juno. This is how \(voice.label) sounds.",
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
              .junoCaption()
          }
          Spacer(minLength: JunoSpace.tight)
          switch authorization {
          case .notDetermined?:
            Button("Allow") { Task { await requestPermission() } }
              .buttonStyle(.borderedProminent)
              .tint(Color.junoAccent)
              .accessibilityIdentifier("juno.mobile.notifications-allow")
          case .denied?:
            Button("Open Settings") {
              guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
              openURL(url)
            }
            .buttonStyle(.bordered)
          case .authorized?, .provisional?, .ephemeral?:
            JunoIconView(.check, size: 15)
              .foregroundStyle(Color.junoSuccess)
          default:
            ProgressView().controlSize(.small)
          }
        }
        .frame(minHeight: 44)
      } footer: {
        Text("Juno only notifies you about things you asked it to do.")
      }

      Section("Juno Code") {
        Toggle(isOn: $notifyApprovals) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Approvals")
            Text("When a session on your Mac is waiting for a yes.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
        .disabled(!isAuthorized)
        .accessibilityIdentifier("juno.mobile.notifications-approvals")
        Toggle(isOn: $notifyCompletions) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Completions")
            Text("When a session you started from here finishes.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
        .disabled(!isAuthorized)
      }

      if let settings {
        Section {
          Toggle(isOn: binding(settings, \.emailBudgetAlerts) { NativeSettingsPatch(emailBudgetAlerts: $0) }) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Budget alerts")
              Text("Email me at 80% of my monthly budget.")
                .junoCaption()
            }
          }
          .tint(Color.junoAccent)
          .disabled(disabled)
          .accessibilityIdentifier("juno.mobile.settings-budget-alerts")
          Toggle(isOn: binding(settings, \.emailWeeklyDigest) { NativeSettingsPatch(emailWeeklyDigest: $0) }) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Weekly digest")
              Text("Usage recap every Monday.")
                .junoCaption()
            }
          }
          .tint(Color.junoAccent)
          .disabled(disabled)
          .accessibilityIdentifier("juno.mobile.settings-weekly-digest")
        } header: {
          Text("Email")
        } footer: {
          Text("Both go to your account's email address and are stored on the account — turning one off here turns it off on the web too.")
        }
      }
    }
    .scrollContentBackground(.hidden)
    .junoScreenCanvas()
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
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
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
              .junoCaption()
          }
        }
        .accessibilityIdentifier("juno.mobile.code-devices")
      } header: {
        Text("Remote")
      } footer: {
        Text("Juno Code on your Mac registers itself with your account when you turn on Remote there. Nothing runs on a computer that has not opted in.")
      }

      Section {
        Toggle(isOn: $notifyApprovals) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Notify me for approvals")
            Text("A local notification when a session is waiting on you while Juno is in the background.")
              .junoCaption()
          }
        }
        .tint(Color.junoAccent)
      } header: {
        Text("Notifications")
      }
    }
    .scrollContentBackground(.hidden)
    .junoScreenCanvas()
    .navigationTitle("Juno Code")
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("juno.mobile.settings-code")
  }
}
