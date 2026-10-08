import AppKit
import JunoAuth
import JunoChatKit
import JunoDesignSystem
import JunoSync
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

/// Settings › Account (`sections/account.tsx`, `account-security.tsx`): who
/// you are, how you sign in, what Juno may email you and notify this Mac of,
/// and deleting the account. There is no "Danger zone" heading any more; the
/// destructive row stands apart in its own group.
struct DesktopSettingsAccountPane: View {
    let context: DesktopSettingsContext

    @State private var sheet: DesktopAccountSheet?
    @State private var confirmation: JunoConfirmation?
    @State private var avatarData: Data?
    @State private var uploadingAvatar = false
    @State private var hoveringAvatar = false
    @AppStorage(DesktopSettingsSection.storageKey) private var storedSection = DesktopSettingsSection.account.rawValue

    var body: some View {
        DesktopSettingsRecordForm(context: context) { settings in
            Section {
                profileBlock
                DesktopUsernameRow(context: context)
            }

            Section {
                twoStepRow
                passwordRow
                emailRow
                DesktopSettingRow(
                    title: "This session",
                    description: "Sign out on this device. Other devices stay signed in."
                ) {
                    DesktopOutlineButton(title: "Sign Out") {
                        confirmation = JunoConfirmation(
                            title: "Sign out of Alevr?",
                            message: "Alevr removes this Mac's local copy of your conversations and settings. Nothing is deleted on the server.",
                            confirmTitle: "Sign Out"
                        ) { Task { await context.signOut?() } }
                    }
                    .accessibilityIdentifier("juno.desktop.settings.sign-out")
                }
                DesktopSettingRow(
                    title: "Sign out everywhere",
                    description: "Ends every session on every device, including this one. Use it if you've lost a phone or laptop."
                ) {
                    DesktopOutlineButton(title: "Sign Out Everywhere…") {
                        confirmation = JunoConfirmation(
                            title: "Sign out of every device?",
                            message: "Every browser, phone and native app signed in to this account is signed out immediately, this one included. Nothing else about the account changes.",
                            confirmTitle: "Sign Out Everywhere"
                        ) { signOutEverywhere() }
                    }
                    .disabled(context.services.security == nil)
                }
            } header: {
                DesktopSettingsGroupHeader(title: "Sign-in and security")
            }

            Section {
                DesktopSettingsMacNotifications(saves: context.saves)
                DesktopSettingToggleRow(
                    title: "Budget alerts",
                    description: "An email when you reach 80% of your monthly budget.",
                    status: context.saves.status("emailBudgetAlerts"),
                    isOn: Binding(
                        get: { settings.emailBudgetAlerts },
                        set: { context.save("emailBudgetAlerts", NativeSettingsPatch(emailBudgetAlerts: $0)) }
                    ),
                    identifier: "juno.desktop.settings.budget-alerts"
                )
                DesktopSettingToggleRow(
                    title: "Weekly digest",
                    description: "A recap of your usage every Monday.",
                    status: context.saves.status("emailWeeklyDigest"),
                    isOn: Binding(
                        get: { settings.emailWeeklyDigest },
                        set: { context.save("emailWeeklyDigest", NativeSettingsPatch(emailWeeklyDigest: $0)) }
                    ),
                    identifier: "juno.desktop.settings.weekly-digest"
                )
            } header: {
                DesktopSettingsGroupHeader(title: "Notifications")
            }

            Section {
                DesktopSettingRow(
                    title: "Delete account",
                    description: "Chats, memories, files and your subscription, all at once. Export first if you want a copy.",
                    tone: .destructive
                ) {
                    DesktopOutlineButton(title: "Delete Account…", destructive: true) {
                        sheet = .deleteAccount
                    }
                    .disabled(context.services.accountData == nil)
                    .accessibilityIdentifier("juno.desktop.settings.delete-account")
                }
            }
        }
        .junoConfirmation($confirmation)
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .twoStepSetup: DesktopTwoStepSetupSheet(context: context)
            case .twoStepDisable: DesktopTwoStepDisableSheet(context: context)
            case .password: DesktopPasswordSheet(context: context)
            case .email(let hasPassword): DesktopEmailSheet(context: context, hasPassword: hasPassword)
            case .deleteAccount: DesktopDeleteAccountSheet(context: context)
            }
        }
        .task {
            avatarData = context.services.avatarModel?.imageData
            await context.loadSecurity()
            if context.plan.value == nil { await context.loadPlan() }
        }
    }

    // MARK: Profile

    private var planName: String? {
        context.plan.value.map { DesktopPlanCatalog.plan(id: $0.planID)?.name ?? $0.planName }
    }

    private var profileBlock: some View {
        HStack(spacing: JunoSpace.regular) {
            Button(action: chooseAvatar) {
                JunoAvatar(
                    imageData: avatarData,
                    imageURL: context.profile.imageURL,
                    name: context.displayName ?? context.profile.email,
                    size: DesktopSettingsMetrics.avatarSize
                )
                .overlay {
                    Circle()
                        .fill(Color.black.opacity(0.45))
                        .overlay {
                            if uploadingAvatar {
                                ProgressView().controlSize(.small).tint(.white)
                            } else {
                                JunoIconView(.camera, size: 18).foregroundStyle(.white)
                            }
                        }
                        .opacity(hoveringAvatar || uploadingAvatar ? 1 : 0)
                        .animation(JunoMotion.fast, value: hoveringAvatar)
                }
                // A hairline ring, so the initials' muted disc reads as a
                // picture on the grouped row in light appearance.
                .overlay { Circle().strokeBorder(Color.junoBorder, lineWidth: 1) }
                // The one control for the picture, visible without a hover.
                .overlay(alignment: .bottomTrailing) {
                    if !uploadingAvatar {
                        JunoIconView(.camera, size: 11)
                            .foregroundStyle(Color.junoSecondaryInk)
                            .frame(width: 20, height: 20)
                            .background { Circle().fill(Color.junoCard) }
                            .overlay { Circle().strokeBorder(Color.junoBorder, lineWidth: 1) }
                            .offset(x: 2, y: 2)
                            .opacity(hoveringAvatar ? 0 : 1)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minWidth: 28, minHeight: 28)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(uploadingAvatar || context.services.security == nil)
            .onHover { hoveringAvatar = $0 }
            .help("Change picture")
            .accessibilityLabel("Change profile picture")

            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                HStack(spacing: JunoSpace.snug) {
                    Text(context.displayName ?? "You")
                        .junoType(JunoType.bodyLarge.weight(.semibold))
                        .foregroundStyle(Color.junoForeground)
                        .lineLimit(1)
                }
                // The plan in plain words beside the address, never a chip
                // (owner directive: no status pills).
                HStack(spacing: JunoSpace.tight) {
                    Text(context.profile.email)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    if let planName {
                        Text("·").accessibilityHidden(true)
                        Text("\(planName) plan")
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
            }
            Spacer(minLength: 0)
            DesktopOutlineButton(title: "Change Name") {
                storedSection = DesktopSettingsSection.personalization.rawValue
            }
        }
        .padding(.vertical, JunoSpace.snug)
    }

    private func chooseAvatar() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .webP, .gif]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a JPEG, PNG, WebP or GIF under 5 MB."
        guard panel.runModal() == .OK, let url = panel.url,
            let data = try? Data(contentsOf: url),
            let client = context.services.security
        else { return }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
        uploadingAvatar = true
        Task {
            defer { uploadingAvatar = false }
            do {
                _ = try await client.uploadAvatar(data: data, fileName: url.lastPathComponent, mimeType: mime, for: context.accountID)
                avatarData = data
                context.toasts.post(.success("Profile picture updated."))
            } catch {
                context.toasts.post(.error(NativeFailureMessage.presentable(error)))
            }
        }
    }

    // MARK: Security

    private var status: NativeAccountSecurityStatus? { context.security.value }

    private var twoStepRow: some View {
        let enabled = status?.enabled == true
        let description = enabled
            ? "On. \(status?.recoveryCodesRemaining ?? 0) of 10 recovery codes left."
            : "A code from your authenticator app, on top of your password."
        return LabeledContent {
            DesktopOutlineButton(title: enabled ? "Turn Off…" : "Set Up…") {
                sheet = enabled ? .twoStepDisable : .twoStepSetup
            }
            .disabled(status == nil)
        } label: {
            VStack(alignment: .leading, spacing: JunoSpace.micro) {
                HStack(spacing: JunoSpace.snug) {
                    Text("Two-step verification")
                        .junoType(JunoType.ui.weight(.medium))
                        .foregroundStyle(Color.junoForeground)
                }
                Text(description)
                    .junoType(JunoType.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
            }
            .padding(.vertical, JunoSpace.micro)
            .accessibilityElement(children: .combine)
        }
    }

    private var passwordRow: some View {
        let hasPassword = status?.hasPassword ?? true
        return DesktopSettingRow(
            title: "Password",
            description: hasPassword
                ? "Changing it signs out every other device."
                : "This account signs in with Google or Apple, so it has no password."
        ) {
            if hasPassword {
                DesktopOutlineButton(title: "Change…") { sheet = .password }
                    .disabled(context.services.security == nil)
            }
        }
    }

    private var emailRow: some View {
        DesktopSettingRow(
            title: "Email address",
            description: "The address you sign in with. A link to the new address confirms the change."
        ) {
            DesktopOutlineButton(title: "Change…") { sheet = .email(hasPassword: status?.hasPassword ?? true) }
                .disabled(context.services.security == nil)
        }
    }

    private func signOutEverywhere() {
        guard let client = context.services.security else { return }
        Task {
            do {
                try await client.signOutEverywhere(for: context.accountID)
                await context.signOut?()
            } catch {
                context.toasts.post(.error(NativeFailureMessage.presentable(error)))
            }
        }
    }
}

enum DesktopAccountSheet: Identifiable, Equatable {
    case twoStepSetup
    case twoStepDisable
    case password
    case email(hasPassword: Bool)
    case deleteAccount

    var id: String {
        switch self {
        case .twoStepSetup: "2fa-setup"
        case .twoStepDisable: "2fa-disable"
        case .password: "password"
        case .email: "email"
        case .deleteAccount: "delete"
        }
    }
}

// MARK: - Notifications on this Mac

/// This Mac's notifications (main's section, restyled onto these rows): whether
/// macOS lets Juno show any, and the two switches the push registrar keeps for
/// this Mac only.
struct DesktopSettingsMacNotifications: View {
    let saves: DesktopSaveStates

    @State private var pushes = NativePushRegistrar.shared
    @State private var authorization: UNAuthorizationStatus?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            DesktopSettingRow(title: "Notifications on this Mac", description: rowDescription) {
                permissionControl
            }
            .task { await refreshAuthorization() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refreshAuthorization() } }
            }
            DesktopSettingToggleRow(
                title: "When something needs you",
                description: "Approvals and questions a task or an agent is waiting on.",
                status: saves.status("notifyNeedsYou"),
                isOn: Binding(
                    get: { pushes.preferences.needsYou },
                    set: { pushes.preferences.needsYou = $0; saves.mark("notifyNeedsYou", ok: true) }
                ),
                isEnabled: isAuthorized,
                identifier: "juno.desktop.settings.notify-needs-you"
            )
            DesktopSettingToggleRow(
                title: "Updates",
                description: "Finished tasks, and ideas your agents want to share.",
                status: saves.status("notifyUpdates"),
                isOn: Binding(
                    get: { pushes.preferences.updates },
                    set: { pushes.preferences.updates = $0; saves.mark("notifyUpdates", ok: true) }
                ),
                // Off without a token: an update reaches this Mac only as a push.
                isEnabled: isAuthorized && pushes.tokenHex != nil,
                identifier: "juno.desktop.settings.notify-updates"
            )
        }
    }

    /// Where these switches reach, or why they cannot yet.
    private var rowDescription: String {
        if authorization == .denied {
            return "Off in System Settings. Allow notifications for Alevr there, then come back."
        }
        if pushes.tokenHex != nil {
            return "Sent to this Mac even when Alevr is closed. These switches are for this Mac only."
        }
        return "While Alevr is open, this Mac tells you when an agent needs you. Updates reach your iPhone and Alevr on the web."
    }

    @ViewBuilder
    private var permissionControl: some View {
        switch authorization {
        case .notDetermined?, .provisional?:
            DesktopOutlineButton(title: "Allow") { Task { await requestPermission() } }
                .accessibilityIdentifier("juno.desktop.settings.notifications-allow")
        case .denied?:
            DesktopOutlineButton(title: "Open System Settings") { openNotificationSettings() }
        case .authorized?:
            // A normal state: plain secondary words, no check mark.
            Text(statusLine)
                .junoType(.ui)
                .foregroundStyle(Color.junoSecondaryInk)
        default:
            ProgressView().controlSize(.small)
        }
    }

    private var isAuthorized: Bool {
        switch authorization {
        case .authorized?, .provisional?: true
        default: false
        }
    }

    private var statusLine: String {
        switch authorization {
        case .authorized?: "Allowed"
        case .provisional?: "Delivered quietly"
        case .denied?: "Off in System Settings"
        case .notDetermined?: "Not asked yet"
        default: "Checking…"
        }
    }

    private func refreshAuthorization() async {
        guard !JunoTestHost.isActive else {
            authorization = .authorized
            return
        }
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func requestPermission() async {
        await pushes.requestFullAuthorization()
        await refreshAuthorization()
    }

    private func openNotificationSettings() {
        var address = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        if let bundleID = Bundle.main.bundleIdentifier { address += "?id=\(bundleID)" }
        guard let url = URL(string: address) else { return }
        openURL(url)
    }
}

// MARK: - Sheets

/// A labelled field in a sheet, with its error under it.
private struct DesktopSheetField: View {
    let label: String
    @Binding var text: String
    var placeholder: String = ""
    var hint: String?
    var error: String?
    var secure = false

    var body: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text(label)
                .junoType(JunoType.ui.weight(.medium))
                .foregroundStyle(Color.junoForeground)
            Group {
                if secure {
                    SecureField(label, text: $text, prompt: Text(placeholder))
                } else {
                    TextField(label, text: $text, prompt: Text(placeholder))
                }
            }
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            if let error {
                Text(error)
                    .junoType(JunoType.label.weight(.regular))
                    .foregroundStyle(Color.junoDestructiveInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let hint {
                Text(hint)
                    .junoType(JunoType.label.weight(.regular))
                    .foregroundStyle(Color.junoSecondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Setting up two-step verification: the QR code and key, the first code,
/// then the ten recovery codes, shown once.
struct DesktopTwoStepSetupSheet: View {
    let context: DesktopSettingsContext

    @Environment(\.dismiss) private var dismiss
    @State private var enrolment: NativeTwoStepEnrolment?
    @State private var codes: [String]?
    @State private var code = ""
    @State private var error: String?
    @State private var busy = false
    @State private var copied = false

    var body: some View {
        if let codes {
            DesktopSettingsSheet(
                title: "Save your recovery codes",
                message: "Each one signs you in once if you lose your authenticator app. This is the only time they are shown: they are stored hashed, so nobody, including Alevr, can show them to you again."
            ) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: JunoSpace.snug) {
                    ForEach(codes, id: \.self) { value in
                        Text(value)
                            .junoType(.mono)
                            .foregroundStyle(Color.junoForeground)
                            .textSelection(.enabled)
                    }
                }
                .padding(JunoSpace.regular)
                .background(Color.junoSecondary, in: RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))
            } buttons: {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(codes.joined(separator: "\n"), forType: .string)
                    copied = true
                } label: {
                    Label {
                        Text(copied ? "Copied" : "Copy Codes")
                    } icon: {
                        JunoIconView(copied ? .check : .copy, size: 13)
                    }
                }
                .buttonStyle(.bordered)
                .tint(nil)
                .contentShape(.rect)
                Button("I’ve Saved Them") { dismiss() }
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
            }
        } else {
            DesktopSettingsSheet(
                title: "Set up two-step verification",
                message: "Scan this with an authenticator app, then type the 6-digit code it shows to prove it worked."
            ) {
                if let enrolment {
                    HStack(alignment: .top, spacing: JunoSpace.regular) {
                        if let data = enrolment.qrImage, let image = NSImage(data: data) {
                            Image(nsImage: image)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 160, height: 160)
                                .accessibilityLabel("QR code enrolling \(context.profile.email) in two-step verification")
                        }
                        VStack(alignment: .leading, spacing: JunoSpace.tight) {
                            Text("No camera? Enter this key instead:")
                                .junoType(.ui)
                                .foregroundStyle(Color.junoSecondaryInk)
                            Text(enrolment.secret)
                                .junoType(.mono)
                                .foregroundStyle(Color.junoForeground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    DesktopSheetField(label: "Code from your app", text: $code, placeholder: "123456", error: error)
                } else if let error {
                    DesktopSettingsNote(text: error, tone: .error)
                } else {
                    HStack(spacing: JunoSpace.snug) {
                        ProgressView().controlSize(.small)
                        Text("Preparing your code…")
                            .junoType(.ui)
                            .foregroundStyle(Color.junoSecondaryInk)
                    }
                }
            } buttons: {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
                    .contentShape(.rect)
                Button("Turn On") { confirm() }
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || enrolment == nil || code.trimmingCharacters(in: .whitespaces).count < 6)
            }
            .task { await start() }
        }
    }

    private func start() async {
        guard enrolment == nil, let client = context.services.security else { return }
        do {
            enrolment = try await client.startTwoStep(for: context.accountID)
        } catch {
            self.error = NativeFailureMessage.presentable(error)
        }
    }

    private func confirm() {
        guard let client = context.services.security else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                codes = try await client.confirmTwoStep(code: code, for: context.accountID)
                await context.loadSecurity()
            } catch {
                self.error = NativeFailureMessage.presentable(error)
            }
        }
    }
}

/// Turning two-step verification off, with a current code or a recovery code.
struct DesktopTwoStepDisableSheet: View {
    let context: DesktopSettingsContext

    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        DesktopSettingsSheet(
            title: "Turn off two-step verification?",
            message: "Your password alone will be enough to sign in again. Confirm with a current code, or one of your unused recovery codes."
        ) {
            DesktopSheetField(label: "Code", text: $code, placeholder: "123456", error: error)
        } buttons: {
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(busy)
                .contentShape(.rect)
            Button("Turn Off", role: .destructive) { submit() }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 6)
                .contentShape(.rect)
        }
    }

    private func submit() {
        guard let client = context.services.security else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let locked = try await client.disableTwoStep(code: code, for: context.accountID)
                await context.loadSecurity()
                dismiss()
                context.toasts.post(.success(locked
                    ? "Two-step verification is off. The Admin panel stays locked until you turn it back on."
                    : "Two-step verification is off."))
            } catch {
                self.error = NativeFailureMessage.presentable(error)
            }
        }
    }
}

/// Changing the password. Every device is signed out, this one too.
struct DesktopPasswordSheet: View {
    let context: DesktopSettingsContext

    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var currentError: String?
    @State private var newError: String?
    @State private var busy = false
    @State private var resetNote: String?

    var body: some View {
        DesktopSettingsSheet(
            title: "Change your password",
            message: "Every other signed-in device is signed out when you do this, and so is this one."
        ) {
            DesktopSheetField(label: "Current password", text: $current, error: currentError, secure: true)
            DesktopSheetField(label: "New password", text: $new, hint: "At least 8 characters.", error: newError, secure: true)
            if let resetNote {
                DesktopSettingsNote(text: resetNote)
            }
        } buttons: {
            Button("Email Me a Reset Link") { sendReset() }
                .buttonStyle(.borderless)
                .disabled(busy)
                .contentShape(.rect)
            Spacer(minLength: 0)
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(busy)
                .contentShape(.rect)
            Button("Change Password") { submit() }
                .buttonStyle(.junoProminent)
                .contentShape(.rect)
                .keyboardShortcut(.defaultAction)
                .disabled(busy)
        }
    }

    private func submit() {
        currentError = current.isEmpty ? "Enter your current password." : nil
        newError = new.count < 8 ? "Use at least 8 characters." : nil
        guard currentError == nil, newError == nil, let client = context.services.security else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.changePassword(current: current, new: new, for: context.accountID)
                dismiss()
                context.toasts.post(.success("Password changed. Signing you back in…"))
                await context.signOut?()
            } catch let error as NativeWebRouteError {
                if error.field == "newPassword" { newError = error.message } else { currentError = error.message }
            } catch {
                currentError = "Couldn’t reach the server. Try again."
            }
        }
    }

    private func sendReset() {
        guard let client = context.services.security else { return }
        Task {
            do {
                resetNote = try await client.sendPasswordReset(email: context.profile.email, for: context.accountID)
                    ?? "A password-reset link is on its way."
            } catch {
                resetNote = NativeFailureMessage.presentable(error)
            }
        }
    }
}

/// Changing the sign-in address: a link to the new address confirms it.
struct DesktopEmailSheet: View {
    let context: DesktopSettingsContext
    let hasPassword: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var password = ""
    @State private var emailError: String?
    @State private var passwordError: String?
    @State private var busy = false
    @State private var sentTo: String?

    var body: some View {
        DesktopSettingsSheet(
            title: "Change your email address",
            message: sentTo == nil
                ? "Your current address keeps working until the new one is confirmed."
                : "Nothing has changed yet. Open the link to finish."
        ) {
            if let sentTo {
                Text("If \(sentTo) isn’t already in use here, a confirmation link is on its way to it. The link lasts 24 hours.")
                    .junoType(.ui)
                    .foregroundStyle(Color.junoForeground)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                DesktopSheetField(label: "New email address", text: $address, placeholder: "you@example.com", error: emailError)
                if hasPassword {
                    DesktopSheetField(
                        label: "Current password",
                        text: $password,
                        hint: "Your address is how you recover this account, so changing it needs your password.",
                        error: passwordError,
                        secure: true
                    )
                }
            }
        } buttons: {
            if sentTo != nil {
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .contentShape(.rect)
            } else {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(busy)
                    .contentShape(.rect)
                Button("Send Confirmation Link") { submit() }
                    .buttonStyle(.junoProminent)
                    .contentShape(.rect)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func submit() {
        guard let client = context.services.security else { return }
        emailError = nil
        passwordError = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.changeEmail(to: address, currentPassword: hasPassword ? password : nil, for: context.accountID)
                sentTo = address.trimmingCharacters(in: .whitespacesAndNewlines)
            } catch let error as NativeWebRouteError {
                if error.field == "currentPassword" { passwordError = error.message } else { emailError = error.message }
            } catch {
                emailError = "Couldn’t reach the server. Try again."
            }
        }
    }
}

/// Deleting the account: type the address to confirm.
struct DesktopDeleteAccountSheet: View {
    let context: DesktopSettingsContext

    @Environment(\.dismiss) private var dismiss
    @State private var confirmation = ""
    @State private var busy = false
    @State private var error: String?

    private var matches: Bool {
        !context.profile.email.isEmpty
            && confirmation.trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(context.profile.email) == .orderedSame
    }

    var body: some View {
        DesktopSettingsSheet(
            title: "Delete this account?",
            message: "Your account and everything in it are deleted: conversations, memories, files and your subscription. It happens at once, and nothing can be recovered."
        ) {
            DesktopSheetField(
                label: "Type \(context.profile.email) to confirm",
                text: $confirmation,
                placeholder: context.profile.email,
                error: error
            )
            .accessibilityIdentifier("juno.desktop.settings.delete-confirm")
        } buttons: {
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(busy)
                .contentShape(.rect)
            Button("Delete Permanently", role: .destructive) { delete() }
                .disabled(!matches || busy)
                .contentShape(.rect)
        }
    }

    private func delete() {
        guard let client = context.services.accountData else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await client.deleteAccount(
                    confirmEmail: confirmation,
                    accountEmail: context.profile.email,
                    for: context.accountID
                )
                dismiss()
                // The account is gone; signing out tears down every local copy.
                await context.signOut?()
            } catch {
                self.error = NativeFailureMessage.presentable(error)
            }
        }
    }
}
