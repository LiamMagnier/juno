import JunoAuth
import JunoDesignSystem
import SwiftUI

/// Signed out: a short welcome the first time, then sign-in.
///
/// The old screen was a bare `ScrollView` with two fields and a system
/// `.borderedProminent` — functional, and the least designed screen in the
/// app, on the one occasion every new reader is guaranteed to see it. This is
/// the front door: the mark, a headline in the editorial serif, a raised card
/// holding the credentials, and the browser sign-in beneath it.
///
/// The welcome pages run once. `@AppStorage` rather than an account setting
/// because they are about the *device* meeting the product — a returning
/// reader on a new phone sees them again, which is right — and because there
/// is no account yet to store anything on.
struct JunoMobileSignInView: View {
  let authModel: NativeAuthModel

  @AppStorage("juno.mobile.onboarding.seen") private var welcomeSeen = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Group {
      if welcomeSeen || skipsWelcome {
        JunoMobileSignInForm(authModel: authModel)
          .transition(.opacity)
      } else {
        JunoMobileWelcome {
          withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            welcomeSeen = true
          }
        }
        .transition(.opacity)
      }
    }
    .junoScreenCanvas()
    .tint(Color.junoAccent)
  }

  /// UI tests and the preview harness reach the form directly; the welcome
  /// would otherwise stand between every launch of a fresh simulator and the
  /// screen they came for.
  private var skipsWelcome: Bool {
    #if DEBUG
      return CommandLine.arguments.contains("--juno-skip-welcome")
        || ProcessInfo.processInfo.environment["JUNO_SKIP_WELCOME"] == "1"
        || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    #else
      return false
    #endif
  }
}

// MARK: - Welcome

/// Three pages: what Juno is, what it will ask for, and the way in.
private struct JunoMobileWelcome: View {
  let finish: () -> Void

  @State private var page = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private struct Page: Identifiable {
    let id: Int
    let icon: JunoIcon
    let title: LocalizedStringKey
    let body: LocalizedStringKey
  }

  private let pages: [Page] = [
    Page(
      id: 0, icon: .home,
      title: "One assistant, every model.",
      body: "Chat, research, voice, and code — with the best model picked for each ask, or the one you choose."
    ),
    Page(
      id: 1, icon: .mic,
      title: "It asks before it listens.",
      body: "The microphone is only used for voice conversations and dictation, and the camera only when you show Juno something. Nothing runs in the background without telling you."
    ),
    Page(
      id: 2, icon: .code,
      title: "Your Mac, from your pocket.",
      body: "Pair Juno Code on your Mac and steer sessions, review diffs and approve changes from here."
    ),
  ]

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        Button("Skip", action: finish)
          .junoFont(size: 15, relativeTo: .subheadline, weight: .medium)
          .foregroundStyle(Color.junoMutedForeground)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
          .accessibilityIdentifier("juno.mobile.welcome-skip")
      }
      .padding(.horizontal, JunoSpace.regular)

      TabView(selection: $page) {
        ForEach(pages) { item in
          VStack(spacing: JunoSpace.section) {
            Spacer(minLength: 0)
            ZStack {
              Circle()
                .fill(Color.junoAccent.opacity(0.12))
                .frame(width: 132, height: 132)
              Circle()
                .fill(Color.junoSurface)
                .frame(width: 96, height: 96)
                .shadow(color: Color.junoCardShadow, radius: 10, y: 3)
              JunoIconView(item.icon, size: 40)
                .foregroundStyle(Color.junoAccent)
            }
            .accessibilityHidden(true)
            VStack(spacing: JunoSpace.cozy) {
              Text(item.title)
                .junoPageHeading()
                .multilineTextAlignment(.center)
              Text(item.body)
                .junoBody()
                .junoSecondaryInk()
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, JunoSpace.region)
            Spacer(minLength: 0)
          }
          .tag(item.id)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))

      HStack(spacing: JunoSpace.snug) {
        ForEach(pages) { item in
          Capsule()
            .fill(item.id == page ? Color.junoAccent : Color.junoBorder)
            .frame(width: item.id == page ? 22 : 7, height: 7)
        }
      }
      .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: page)
      .padding(.bottom, JunoSpace.section)
      .accessibilityHidden(true)

      Button {
        if page < pages.count - 1 {
          withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
            page += 1
          }
        } else {
          finish()
        }
      } label: {
        Text(page < pages.count - 1 ? "Continue" : "Get started")
          .fontWeight(.semibold)
          .frame(maxWidth: .infinity)
          .frame(minHeight: 30)
      }
      .junoProminentAction()
      .controlSize(.large)
      .padding(.horizontal, JunoSpace.section)
      .padding(.bottom, JunoSpace.section)
      .accessibilityIdentifier("juno.mobile.welcome-continue")
      .contentShape(.rect)
    }
    .frame(maxWidth: 520)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityIdentifier("juno.mobile.welcome")
  }
}

// MARK: - Sign in

private struct JunoMobileSignInForm: View {
  let authModel: NativeAuthModel

  @State private var email = ""
  @State private var password = ""
  @FocusState private var focusedField: Field?

  private enum Field: Hashable { case email, password }

  private var isBusy: Bool { authModel.phase == .signingIn }
  private var canSubmitPassword: Bool {
    !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !password.isEmpty
      && !isBusy
  }

  private func submitPassword() {
    guard canSubmitPassword else { return }
    let submittedPassword = password
    // Hand the plaintext over and drop it from view state immediately.
    password = ""
    Task { await authModel.signIn(email: email, password: submittedPassword) }
  }

  var body: some View {
    ScrollView {
      VStack(spacing: JunoSpace.section) {
        VStack(spacing: JunoSpace.cozy) {
          JunoMark(size: 56)
            .padding(.top, JunoSpace.region)
          Text("auth.welcome.title")
            .junoPageHeading()
            .multilineTextAlignment(.center)
          Text("auth.welcome.description")
            .junoBody()
            .junoSecondaryInk()
            .multilineTextAlignment(.center)
        }

        if let error = authModel.lastErrorDescription {
          JunoInlineError(message: error)
            .accessibilityIdentifier("juno.mobile.auth-error")
        }

        if authModel.phase != .unavailable {
          card

          HStack(spacing: JunoSpace.cozy) {
            Rectangle().fill(Color.junoHairline).frame(height: 1)
            Text("auth.divider.or")
              .junoCaption()
            Rectangle().fill(Color.junoHairline).frame(height: 1)
          }
          .accessibilityHidden(true)

          Button {
            Task { await authModel.signIn() }
          } label: {
            Label {
              Text("auth.sign-in")
            } icon: {
              JunoIconView(.external, size: 15)
            }
            .fontWeight(.medium)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 30)
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .disabled(isBusy)
          .accessibilityIdentifier("juno.mobile.sign-in")
          .contentShape(.rect)

          Text("auth.password.disclaimer")
            .junoCaption()
            .multilineTextAlignment(.center)
            .padding(.top, JunoSpace.hairline)
        }
      }
      .padding(.horizontal, JunoSpace.section)
      .padding(.bottom, JunoSpace.region)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .scrollBounceBehavior(.basedOnSize)
    .scrollDismissesKeyboard(.interactively)
  }

  /// The credentials, on the language's raised card, in its inset fields.
  private var card: some View {
    VStack(spacing: JunoSpace.cozy) {
      field {
        TextField("auth.email.placeholder", text: $email)
          .textContentType(.username)
          .keyboardType(.emailAddress)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($focusedField, equals: .email)
          .submitLabel(.next)
          .onSubmit { focusedField = .password }
          .accessibilityIdentifier("juno.mobile.email")
      }
      field {
        SecureField("auth.password.label", text: $password)
          .textContentType(.password)
          .focused($focusedField, equals: .password)
          .submitLabel(.go)
          .onSubmit(submitPassword)
          .accessibilityIdentifier("juno.mobile.password")
      }

      Button(action: submitPassword) {
        Group {
          if isBusy {
            ProgressView()
              .tint(Color.junoOnAccent)
          } else {
            Text("auth.sign-in.password")
              .fontWeight(.semibold)
          }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 30)
      }
      .junoProminentAction()
      .controlSize(.large)
      .disabled(!canSubmitPassword)
      .accessibilityIdentifier("juno.mobile.sign-in.password")
      .contentShape(.rect)
      .padding(.top, JunoSpace.hairline)
    }
    .padding(JunoSpace.regular)
    .junoCard(cornerRadius: JunoRadius.card)
    .disabled(isBusy)
  }

  private func field<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
      .junoFont(size: 16, relativeTo: .body)
      .padding(.horizontal, JunoSpace.cozy)
      .frame(minHeight: 46)
      .background(
        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
          .fill(Color.junoCanvas)
      )
      .overlay(
        RoundedRectangle(cornerRadius: JunoRadius.well, style: .continuous)
          .strokeBorder(Color.junoBorder, lineWidth: 1)
      )
  }
}
