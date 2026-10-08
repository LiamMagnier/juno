import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import UIKit

/// Settings › Account › Sign-in and security (`account-security.tsx`): two-step
/// verification, the password, the sign-in address, and signing every other
/// device out. Every refusal is the server's own sentence, under the field it
/// names.
struct JunoMobileAccountSecurityView: View {
  let email: String
  /// Signs this device out; the server has already ended its session when a
  /// password change or "sign out everywhere" calls this.
  var signOut: (() async -> Void)? = nil

  @Environment(\.junoFeatureHub) private var hub
  @State private var status: NativeAccountSecurityStatus?
  @State private var loadFailure: String?
  @State private var sheet: Sheet?
  @State private var confirmingSignOutEverywhere = false
  @State private var notice: String?
  @State private var busy = false

  enum Sheet: String, Identifiable {
    case twoStepSetup, twoStepDisable, password, email
    var id: String { rawValue }
  }

  private var client: NativeAccountSecurityClient? { hub?.securityClient }
  private var accountID: AccountID? { hub?.accountID }

  var body: some View {
    Form {
      if let loadFailure {
        Section {
          Text(loadFailure).foregroundStyle(Color.junoDestructiveInk)
          Button("Try Again") { Task { await load() } }
        }
      }

      Section {
        LabeledContent {
          Button(status?.enabled == true ? "Turn Off" : "Set Up") {
            sheet = status?.enabled == true ? .twoStepDisable : .twoStepSetup
          }
          .disabled(status == nil)
          .accessibilityIdentifier("juno.mobile.security.two-step")
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text("Two-step verification")
            Text(twoStepDetail)
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
          }
        }
      } footer: {
        Text("A code from your authenticator app, on top of your password.")
      }

      Section {
        if status?.hasPassword ?? true {
          Button("Change Password") { sheet = .password }
            .disabled(client == nil)
            .accessibilityIdentifier("juno.mobile.security.password")
          // Ink, not the accent: the page's one accent is Set Up.
          .tint(Color.primary)
        } else {
          Text("This account signs in with Google or Apple, so it has no password.")
            .foregroundStyle(Color.junoSecondaryInk)
        }
        Button("Change Email Address") { sheet = .email }
          .disabled(client == nil)
          .accessibilityIdentifier("juno.mobile.security.email")
          // Ink, not the accent: the page's one accent is Set Up.
          .tint(Color.primary)
      } header: {
        Text("Sign-in")
      } footer: {
        Text("You sign in as \(email). Changing the password signs out every device, this one too.")
      }

      Section {
        Button("Sign Out Everywhere", role: .destructive) { confirmingSignOutEverywhere = true }
          .disabled(client == nil || busy)
          .accessibilityIdentifier("juno.mobile.security.sign-out-everywhere")
      } footer: {
        Text("Ends every session on every device, including this one. Use it if you’ve lost a phone or laptop.")
      }

      if let notice {
        Section { Text(notice).foregroundStyle(Color.junoSecondaryInk) }
      }
    }
    .junoGroupedPage()
    .navigationTitle("Sign-in & Security")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .confirmationDialog(
      "Sign out of every device?",
      isPresented: $confirmingSignOutEverywhere,
      titleVisibility: .visible
    ) {
      Button("Sign Out Everywhere", role: .destructive) { signOutEverywhere() }
      .contentShape(.rect)
    } message: {
      Text("Every browser, phone and app signed in to this account is signed out immediately, this one included.")
    }
    .sheet(item: $sheet) { sheet in
      NavigationStack {
        switch sheet {
        case .twoStepSetup:
          JunoMobileTwoStepSetupView(email: email) { await load() }
        case .twoStepDisable:
          JunoMobileTwoStepDisableView { locked in
            notice = locked
              ? "Two-step verification is off. The Admin panel stays locked until you turn it back on."
              : "Two-step verification is off."
            await load()
          }
        case .password:
          JunoMobilePasswordChangeView(email: email) { await signOut?() }
        case .email:
          JunoMobileEmailChangeView(hasPassword: status?.hasPassword ?? true)
        }
      }
      .environment(\.junoFeatureHub, hub)
      .tint(Color.junoAccent)
    }
  }

  private var twoStepDetail: String {
    guard let status else { return loadFailure == nil ? "Checking…" : "Unknown" }
    return status.enabled
      ? "On. \(status.recoveryCodesRemaining) of 10 recovery codes left."
      : "Off"
  }

  private func load() async {
    guard let client, let accountID else { return }
    do {
      status = try await client.status(for: accountID)
      loadFailure = nil
    } catch {
      loadFailure = NativeFailureMessage.presentable(error)
    }
  }

  private func signOutEverywhere() {
    guard let client, let accountID else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        try await client.signOutEverywhere(for: accountID)
        await signOut?()
      } catch {
        notice = NativeFailureMessage.presentable(error)
      }
    }
  }
}

// MARK: - Two-step verification

struct JunoMobileTwoStepSetupView: View {
  let email: String
  let changed: () async -> Void

  @Environment(\.junoFeatureHub) private var hub
  @Environment(\.dismiss) private var dismiss
  @State private var enrolment: NativeTwoStepEnrolment?
  @State private var codes: [String]?
  @State private var code = ""
  @State private var error: String?
  @State private var busy = false
  @State private var copied = false

  var body: some View {
    Form {
      if let codes {
        Section {
          ForEach(codes, id: \.self) { value in
            Text(value).font(.body.monospaced()).textSelection(.enabled)
          }
          Button(copied ? "Copied" : "Copy Codes") {
            UIPasteboard.general.string = codes.joined(separator: "\n")
            copied = true
          }
        } header: {
          Text("Recovery codes")
        } footer: {
          Text("Each one signs you in once if you lose your authenticator app. This is the only time they are shown.")
        }
      } else if let enrolment {
        Section {
          if let data = enrolment.qrImage, let image = UIImage(data: data) {
            Image(uiImage: image)
              .interpolation(.none)
              .resizable()
              .scaledToFit()
              .frame(maxWidth: 200)
              .frame(maxWidth: .infinity)
              .accessibilityLabel("QR code enrolling \(email) in two-step verification")
          }
          if let url = URL(string: enrolment.otpauthURL) {
            Link("Open in Authenticator App", destination: url)
          }
          VStack(alignment: .leading, spacing: 4) {
            Text("No camera? Enter this key instead:")
              .font(.footnote)
              .foregroundStyle(Color.junoSecondaryInk)
            Text(enrolment.secret)
              .font(.body.monospaced())
              .textSelection(.enabled)
          }
        } footer: {
          Text("Scan this with an authenticator app, then type the 6-digit code it shows.")
        }
        Section {
          TextField("123456", text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .accessibilityIdentifier("juno.mobile.security.code")
        } header: {
          Text("Code from your app")
        } footer: {
          if let error { Text(error).foregroundStyle(Color.junoDestructiveInk) }
        }
      } else if let error {
        Section { Text(error).foregroundStyle(Color.junoDestructiveInk) }
      } else {
        Section {
          HStack {
            ProgressView()
            Text("Preparing your code…").foregroundStyle(Color.junoSecondaryInk)
          }
        }
      }
    }
    .navigationTitle(codes == nil ? "Two-Step Verification" : "Save Your Codes")
    .navigationBarTitleDisplayMode(.inline)
    .interactiveDismissDisabled(codes != nil && !copied)
    .toolbar {
      if codes != nil {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      } else {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Turn On") { confirm() }
            .disabled(busy || enrolment == nil || code.trimmingCharacters(in: .whitespaces).count < 6)
        }
      }
    }
    .task { await start() }
  }

  private func start() async {
    guard enrolment == nil, let client = hub?.securityClient, let accountID = hub?.accountID else { return }
    do {
      enrolment = try await client.startTwoStep(for: accountID)
    } catch {
      self.error = NativeFailureMessage.presentable(error)
    }
  }

  private func confirm() {
    guard let client = hub?.securityClient, let accountID = hub?.accountID else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        codes = try await client.confirmTwoStep(code: code, for: accountID)
        await changed()
      } catch {
        self.error = NativeFailureMessage.presentable(error)
      }
    }
  }
}

struct JunoMobileTwoStepDisableView: View {
  let turnedOff: (Bool) async -> Void

  @Environment(\.junoFeatureHub) private var hub
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    Form {
      Section {
        TextField("123456", text: $code)
          .textContentType(.oneTimeCode)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
      } header: {
        Text("Code")
      } footer: {
        if let error {
          Text(error).foregroundStyle(Color.junoDestructiveInk)
        } else {
          Text("Your password alone will be enough to sign in again. Confirm with a current code, or one of your unused recovery codes.")
        }
      }
    }
    .navigationTitle("Turn Off Two-Step")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }.disabled(busy)
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Turn Off", role: .destructive) { submit() }
          .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 6)
      }
    }
  }

  private func submit() {
    guard let client = hub?.securityClient, let accountID = hub?.accountID else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        let locked = try await client.disableTwoStep(code: code, for: accountID)
        await turnedOff(locked)
        dismiss()
      } catch {
        self.error = NativeFailureMessage.presentable(error)
      }
    }
  }
}

// MARK: - Password and address

struct JunoMobilePasswordChangeView: View {
  let email: String
  let signOut: () async -> Void

  @Environment(\.junoFeatureHub) private var hub
  @Environment(\.dismiss) private var dismiss
  @State private var current = ""
  @State private var new = ""
  @State private var currentError: String?
  @State private var newError: String?
  @State private var resetNote: String?
  @State private var busy = false

  var body: some View {
    Form {
      Section {
        SecureField("Current password", text: $current)
          .textContentType(.password)
      } footer: {
        if let currentError { Text(currentError).foregroundStyle(Color.junoDestructiveInk) }
      }
      Section {
        SecureField("New password", text: $new)
          .textContentType(.newPassword)
      } footer: {
        if let newError {
          Text(newError).foregroundStyle(Color.junoDestructiveInk)
        } else {
          Text("At least 8 characters. Every signed-in device is signed out when you change it, this one too.")
        }
      }
      Section {
        Button("Email Me a Reset Link") { sendReset() }
          .disabled(busy)
      } footer: {
        if let resetNote { Text(resetNote) }
      }
    }
    .navigationTitle("Change Password")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }.disabled(busy)
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Change") { submit() }.disabled(busy)
      }
    }
  }

  private func submit() {
    currentError = current.isEmpty ? "Enter your current password." : nil
    newError = new.count < 8 ? "Use at least 8 characters." : nil
    guard currentError == nil, newError == nil,
      let client = hub?.securityClient, let accountID = hub?.accountID
    else { return }
    busy = true
    Task {
      defer { busy = false }
      do {
        try await client.changePassword(current: current, new: new, for: accountID)
        dismiss()
        await signOut()
      } catch let error as NativeWebRouteError {
        if error.field == "newPassword" { newError = error.message } else { currentError = error.message }
      } catch {
        currentError = "Couldn’t reach the server. Try again."
      }
    }
  }

  private func sendReset() {
    guard let client = hub?.securityClient, let accountID = hub?.accountID else { return }
    Task {
      do {
        resetNote = try await client.sendPasswordReset(email: email, for: accountID)
          ?? "A password-reset link is on its way."
      } catch {
        resetNote = NativeFailureMessage.presentable(error)
      }
    }
  }
}

struct JunoMobileEmailChangeView: View {
  let hasPassword: Bool

  @Environment(\.junoFeatureHub) private var hub
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var password = ""
  @State private var emailError: String?
  @State private var passwordError: String?
  @State private var sentTo: String?
  @State private var busy = false

  var body: some View {
    Form {
      if let sentTo {
        Section {
          Text("If \(sentTo) isn’t already in use here, a confirmation link is on its way to it. The link lasts 24 hours.")
        } footer: {
          Text("Nothing has changed yet. Open the link to finish.")
        }
      } else {
        Section {
          TextField("you@example.com", text: $address)
            .keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } header: {
          Text("New email address")
        } footer: {
          if let emailError {
            Text(emailError).foregroundStyle(Color.junoDestructiveInk)
          } else {
            Text("Your current address keeps working until the new one is confirmed.")
          }
        }
        if hasPassword {
          Section {
            SecureField("Current password", text: $password)
              .textContentType(.password)
          } footer: {
            if let passwordError {
              Text(passwordError).foregroundStyle(Color.junoDestructiveInk)
            } else {
              Text("Your address is how you recover this account, so changing it needs your password.")
            }
          }
        }
      }
    }
    .navigationTitle("Change Email")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if sentTo != nil {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      } else {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Send Link") { submit() }
            .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
    }
  }

  private func submit() {
    guard let client = hub?.securityClient, let accountID = hub?.accountID else { return }
    emailError = nil
    passwordError = nil
    busy = true
    Task {
      defer { busy = false }
      do {
        try await client.changeEmail(to: address, currentPassword: hasPassword ? password : nil, for: accountID)
        sentTo = address.trimmingCharacters(in: .whitespacesAndNewlines)
      } catch let error as NativeWebRouteError {
        if error.field == "currentPassword" { passwordError = error.message } else { emailError = error.message }
      } catch {
        emailError = "Couldn’t reach the server. Try again."
      }
    }
  }
}
