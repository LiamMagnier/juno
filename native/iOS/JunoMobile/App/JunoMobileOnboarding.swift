import JunoAuth
import JunoDesignSystem
import SwiftUI

/// Signed out: a short welcome the first time, then sign-in.
///
/// The front door is the one screen every new reader is guaranteed to see, so
/// it is the one public surface on the phone that carries brand imagery (brief
/// rule 5): Juno's painted landscape, the mark, and the display face at a
/// confident size. The product screens behind it stay clean.
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
          withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) {
            welcomeSeen = true
          }
        }
        .transition(.opacity)
      }
    }
    // The website's paper: the faint dot grid behind the front door, as the
    // web's onboarding and access panel set it.
    .background {
      ZStack {
        Color.junoCanvas
        JunoDotGrid(spacing: JunoSpace.section)
          .opacity(0.45)
      }
      .ignoresSafeArea()
    }
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

// MARK: - Shared pieces

/// The landscape, lifted into place on entrance and faded into the canvas at
/// its foot so the content below sits on the ground, not on the picture.
private struct JunoMobileFrontDoorArt: View {
  var drift: CGFloat
  /// Where the fade to canvas begins, as a fraction of the art's height.
  var fadeFrom: CGFloat = 0.62

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var rise: CGFloat = 0

  var body: some View {
    JunoMobileLandscape(drift: drift, rise: rise)
      .mask {
        LinearGradient(
          stops: [
            .init(color: .black, location: 0),
            .init(color: .black, location: fadeFrom),
            .init(color: .clear, location: 1),
          ],
          startPoint: .top, endPoint: .bottom
        )
      }
      .onAppear {
        guard rise == 0 else { return }
        if reduceMotion {
          rise = 1
        } else {
          withAnimation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion)) { rise = 1 }
        }
      }
  }
}

/// The mark and the wordmark, set small at the top of the art.
private struct JunoMobileWordmark: View {
  var body: some View {
    JunoLogo(height: 26)
      .foregroundStyle(Color.junoForeground)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Alevr")
      .accessibilityAddTraits(.isHeader)
  }
}

// MARK: - Welcome

/// Three pages: what Juno is, what it will ask for, and the Mac connection.
///
/// The words page; the landscape stays and drifts. Paging moves each range at
/// its own speed, so a swipe reads as walking along a ridge rather than as
/// three slides.
private struct JunoMobileWelcome: View {
  let finish: () -> Void

  @State private var page = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private struct Page: Identifiable {
    let id: Int
    let eyebrow: LocalizedStringKey
    let title: LocalizedStringKey
    let body: LocalizedStringKey
  }

  private let pages: [Page] = [
    Page(
      id: 0,
      eyebrow: "Chat, research, voice and code",
      title: "One assistant.\nEvery model.",
      body: "Alevr picks the right model for each question, or uses the one you choose."
    ),
    Page(
      id: 1,
      eyebrow: "Privacy",
      title: "It asks before\nit listens.",
      body: "The microphone is used only for voice and dictation, the camera only when you show Alevr something. Nothing runs in the background without telling you."
    ),
    Page(
      id: 2,
      eyebrow: "Alevr Code",
      title: "Your Mac,\nin your pocket.",
      body: "Pair Alevr Code on your Mac to steer sessions, review diffs and approve changes from here."
    ),
  ]

  private var isLast: Bool { page == pages.count - 1 }

  var body: some View {
    ZStack(alignment: .top) {
      JunoMobileFrontDoorArt(drift: CGFloat(page), fadeFrom: 0.55)
        .containerRelativeFrame(.vertical) { height, _ in height * 0.7 }
        .frame(maxWidth: .infinity)
        .clipped()
        .ignoresSafeArea(edges: .top)
        .animation(JunoMotion.reduced(JunoMotion.emphasized, when: reduceMotion), value: page)

      VStack(spacing: 0) {
        HStack {
          JunoMobileWordmark()
          Spacer()
          if !isLast {
            Button("Skip", action: finish)
              .font(.subheadline.weight(.medium))
              .foregroundStyle(Color.junoForeground.opacity(0.7))
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(.rect)
              .accessibilityIdentifier("juno.mobile.welcome-skip")
              .transition(.opacity)
          }
        }
        .padding(.horizontal, JunoSpace.section)
        .junoMobileRise(delay: 0.1)

        Spacer(minLength: 0)

        TabView(selection: $page) {
          ForEach(pages) { item in
            VStack(alignment: .leading, spacing: JunoSpace.cozy) {
              Text(item.eyebrow)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.junoAccentInk)
              Text(item.title)
                .junoMobileDisplay(40)
                .minimumScaleFactor(0.7)
                .fixedSize(horizontal: false, vertical: true)
              Text(item.body)
                .font(.body)
                .foregroundStyle(Color.junoSecondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .padding(.horizontal, JunoSpace.section)
            .tag(item.id)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        // Room for the copy at every text size: the accessibility sizes get
        // the page's height back from the painting above it.
        .frame(maxHeight: dynamicTypeSize.isAccessibilitySize ? 520 : 300)
        .junoMobileRise(delay: 0.35, distance: 14)

        HStack(spacing: JunoSpace.section) {
          HStack(spacing: JunoSpace.tight) {
            ForEach(pages) { item in
              Capsule()
                .fill(item.id == page ? Color.junoForeground : Color.junoForeground.opacity(0.18))
                .frame(width: item.id == page ? 20 : 6, height: 6)
            }
          }
          .animation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion), value: page)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("Page \(page + 1) of \(pages.count)")

          Button {
            if isLast {
              finish()
            } else {
              withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                page += 1
              }
            }
          } label: {
            HStack(spacing: JunoSpace.snug) {
              Text(isLast ? "Get started" : "Continue")
                .contentTransition(.opacity)
              JunoSymbol(.arrowRight)
                .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
          }
          .junoMobileFrontDoorButton()
          .sensoryFeedback(.selection, trigger: page)
          .accessibilityIdentifier("juno.mobile.welcome-continue")
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.top, JunoSpace.region)
        .padding(.bottom, JunoSpace.regular)
        .junoMobileRise(delay: 0.5)
      }
      .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityIdentifier("juno.mobile.welcome")
  }
}

// MARK: - Sign in

private struct JunoMobileSignInForm: View {
  let authModel: NativeAuthModel

  @State private var email = ""
  @State private var password = ""
  @State private var submitCount = 0
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
    submitCount += 1
    Task { await authModel.signIn(email: email, password: submittedPassword) }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ZStack(alignment: .topLeading) {
          JunoMobileFrontDoorArt(drift: 0.4, fadeFrom: 0.5)
            .frame(height: 340)
            .frame(maxWidth: .infinity)
            .clipped()
          JunoMobileWordmark()
            .padding(.horizontal, JunoSpace.section)
            .padding(.top, 64)
            .junoMobileRise(delay: 0.1)
        }
        .padding(.bottom, -36)

        VStack(alignment: .leading, spacing: JunoSpace.snug) {
          Text("auth.welcome.title")
            .junoMobileDisplay(38)
            .fixedSize(horizontal: false, vertical: true)
          Text("auth.welcome.description")
            .font(.body)
            .foregroundStyle(Color.junoSecondaryInk)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, JunoSpace.section)
        .junoMobileRise(delay: 0.25)

        VStack(spacing: JunoSpace.regular) {
          if let error = authModel.lastErrorDescription {
            JunoInlineError(message: error)
              .accessibilityIdentifier("juno.mobile.auth-error")
              .transition(.opacity.combined(with: .move(edge: .top)))
          }

          if authModel.phase != .unavailable {
            credentials

            Button(action: submitPassword) {
              ZStack {
                Text("auth.sign-in.password").opacity(isBusy ? 0 : 1)
                if isBusy {
                  ProgressView().tint(JunoMobilePalette.onInk)
                }
              }
              .frame(maxWidth: .infinity)
            }
            .junoMobileFrontDoorButton()
            .disabled(!canSubmitPassword)
            .sensoryFeedback(.impact(weight: .light), trigger: submitCount)
            .accessibilityIdentifier("juno.mobile.sign-in.password")

            HStack(spacing: JunoSpace.cozy) {
              Rectangle().fill(Color.junoHairline).frame(height: 1)
              Text("auth.divider.or")
                .font(.footnote)
                .foregroundStyle(Color.junoTertiaryInk)
              Rectangle().fill(Color.junoHairline).frame(height: 1)
            }
            .accessibilityHidden(true)

            Button {
              Task { await authModel.signIn() }
            } label: {
              HStack(spacing: JunoSpace.snug) {
                JunoIconView(.external, size: 15)
                Text("auth.sign-in")
              }
              .frame(maxWidth: .infinity)
            }
            .junoMobileFrontDoorButton(prominent: false)
            .disabled(isBusy)
            .accessibilityIdentifier("juno.mobile.sign-in")

            Text("auth.password.disclaimer")
              .font(.footnote)
              .foregroundStyle(Color.junoTertiaryInk)
              .multilineTextAlignment(.center)
              .frame(maxWidth: .infinity)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, JunoSpace.hairline)
          }
        }
        .padding(.horizontal, JunoSpace.section)
        .padding(.top, JunoSpace.region)
        .padding(.bottom, JunoSpace.region)
        .junoMobileRise(delay: 0.4, distance: 14)
        .animation(JunoMotion.standard, value: authModel.lastErrorDescription)
      }
      .frame(maxWidth: 520)
      .frame(maxWidth: .infinity)
    }
    .ignoresSafeArea(edges: .top)
    .scrollBounceBehavior(.basedOnSize)
    .scrollDismissesKeyboard(.interactively)
    .disabled(isBusy)
  }

  /// Email and password as one inset group: two rows and a hairline, like the
  /// system's own sign-in sheets, rather than two separately boxed fields.
  private var credentials: some View {
    VStack(spacing: 0) {
      row(icon: .message) {
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
      Rectangle()
        .fill(Color.junoHairline)
        .frame(height: 0.75)
        .padding(.leading, 50)
      row(icon: .lock) {
        SecureField("auth.password.label", text: $password)
          .textContentType(.password)
          .focused($focusedField, equals: .password)
          .submitLabel(.go)
          .onSubmit(submitPassword)
          .accessibilityIdentifier("juno.mobile.password")
      }
    }
    .junoMobileRaised(cornerRadius: 18)
  }

  private func row<Content: View>(icon: JunoIcon, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: JunoSpace.cozy) {
      JunoIconView(icon, size: 18)
        .foregroundStyle(Color.junoTertiaryInk)
        .frame(width: 22)
        .accessibilityHidden(true)
      content()
        .font(.body)
    }
    .padding(.horizontal, JunoSpace.regular)
    .frame(minHeight: 54)
  }
}
