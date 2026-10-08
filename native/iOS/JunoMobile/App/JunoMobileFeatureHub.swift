import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import JunoWorkKit
import Observation
import SwiftUI

#if DEBUG
  import JunoPreviewSupport
#endif

/// The account-scoped services the newer iPhone screens share — the inbox,
/// announcements, server search, account security, Skills and Routines —
/// published once from the shell through the environment, so each screen
/// reaches the authenticated transport without the shell threading another
/// parameter through every view between them.
///
/// It is deliberately small: a transport, the signed-in account, and the two
/// models that must outlive any one screen (the inbox count is polled while
/// the app is open; the automations list is shared by its list and detail).
@MainActor
@Observable
final class JunoMobileFeatureHub {
  let sender: (any NativeAuthenticatedRequestSending)?
  private(set) var accountID: AccountID?

  let notifications: NativeNotificationsModel?
  let skills: NativeSkillLibraryModel?
  let routines: NativeWorkAutomationModel?

  /// The announcement waiting to open, once per id per device.
  var announcement: NativeAnnouncement?
  /// A screen opened straight from a launch argument, for screenshots.
  var previewRoute: JunoMobileFeatureRoute?

  @ObservationIgnored private let ledger = NativeAnnouncementLedger()
  @ObservationIgnored private var announcementsFetchedFor: AccountID?

  init(sender: (any NativeAuthenticatedRequestSending)?) {
    self.sender = sender
    notifications = sender.map { NativeNotificationsModel(client: NativeNotificationsClient(sender: $0)) }
    skills = sender.map { NativeSkillLibraryModel(client: NativeSkillsClient(sender: $0)) }
    routines = sender.map { NativeWorkAutomationModel(client: NativeWorkAutomationClient(sender: $0)) }
  }

  var searchClient: NativeUnifiedSearchClient? { sender.map(NativeUnifiedSearchClient.init(sender:)) }
  var securityClient: NativeAccountSecurityClient? { sender.map(NativeAccountSecurityClient.init(sender:)) }
  var announcementsClient: NativeAnnouncementsClient? { sender.map(NativeAnnouncementsClient.init(sender:)) }

  // MARK: Lifecycle

  func start(for accountID: AccountID?) async {
    guard accountID != self.accountID else { return }
    stop()
    self.accountID = accountID
    guard let accountID else { return }
    notifications?.start(for: accountID)
    Task { await self.routines?.start(for: accountID) }
    Task { await self.skills?.start(for: accountID) }
    await fetchAnnouncement(for: accountID)
  }

  func stop() {
    notifications?.stop()
    routines?.stop()
    skills?.stop()
    announcement = nil
    announcementsFetchedFor = nil
    accountID = nil
  }

  // MARK: Announcements

  private func fetchAnnouncement(for accountID: AccountID) async {
    guard announcementsFetchedFor != accountID, let client = announcementsClient else { return }
    announcementsFetchedFor = accountID
    guard let current = try? await client.current(for: accountID),
      self.accountID == accountID,
      ledger.shouldShow(current)
    else { return }
    #if DEBUG
      // The preview world opens on whatever screen a screenshot asked for; an
      // announcement over every one of them would be in every picture.
      if JunoPreviewEnvironment.isActive, previewRoute != .announcement { return }
    #endif
    announcement = current
  }

  /// Closing it by any route dismisses it, here and on the server.
  func dismissAnnouncement(_ item: NativeAnnouncement) {
    ledger.markDismissed(item.id)
    if announcement?.id == item.id { announcement = nil }
    guard let client = announcementsClient, let accountID else { return }
    Task { try? await client.dismiss(id: item.id, for: accountID) }
  }
}

/// The screens a launch argument can open directly in the preview world.
enum JunoMobileFeatureRoute: String, Identifiable, CaseIterable {
  case notifications
  case announcement
  case skills
  case routines
  case security

  var id: String { rawValue }
}

private struct JunoMobileFeatureHubKey: EnvironmentKey {
  static let defaultValue: JunoMobileFeatureHub? = nil
}

extension EnvironmentValues {
  var junoFeatureHub: JunoMobileFeatureHub? {
    get { self[JunoMobileFeatureHubKey.self] }
    set { self[JunoMobileFeatureHubKey.self] = newValue }
  }
}

extension View {
  /// Publishes the hub to everything below and owns its two presentations:
  /// the launch announcement and, in DEBUG, a screen opened by argument.
  func junoMobileFeatures(
    sender: (any NativeAuthenticatedRequestSending)?,
    accountID: AccountID?
  ) -> some View {
    modifier(JunoMobileFeatureHubModifier(sender: sender, accountID: accountID))
  }
}

private struct JunoMobileFeatureHubModifier: ViewModifier {
  let sender: (any NativeAuthenticatedRequestSending)?
  let accountID: AccountID?

  @State private var hub: JunoMobileFeatureHub?
  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content
      .environment(\.junoFeatureHub, hub)
      .task(id: accountID) {
        let current = hub ?? JunoMobileFeatureHub(sender: sender)
        if hub == nil { hub = current }
        #if DEBUG
          if JunoPreviewEnvironment.isActive,
            let raw = Self.previewArgument,
            let route = JunoMobileFeatureRoute(rawValue: raw)
          {
            current.previewRoute = route
          }
        #endif
        await current.start(for: accountID)
      }
      .onChange(of: scenePhase) { _, phase in
        hub?.notifications?.isVisible = phase == .active
      }
      .sheet(item: announcementBinding) { item in
        JunoMobileAnnouncementSheet(announcement: item) {
          hub?.dismissAnnouncement(item)
        }
      }
      #if DEBUG
        .sheet(item: previewBinding) { route in
          if let hub {
            JunoMobileFeaturePreviewScreen(route: route, hub: hub)
              .environment(\.junoFeatureHub, hub)
          }
        }
      #endif
  }

  private var announcementBinding: Binding<NativeAnnouncement?> {
    Binding(
      get: { hub?.announcement },
      set: { value in
        // A swipe down is a close like any other: it dismisses.
        if value == nil, let item = hub?.announcement { hub?.dismissAnnouncement(item) }
      }
    )
  }

  #if DEBUG
    private var previewBinding: Binding<JunoMobileFeatureRoute?> {
      Binding(
        get: {
          guard let route = hub?.previewRoute, route != .announcement else { return nil }
          return route
        },
        set: { hub?.previewRoute = $0 }
      )
    }

    /// `--juno-preview-route notifications|announcement|skills|routines|security`.
    static var previewArgument: String? {
      let arguments = CommandLine.arguments
      guard let index = arguments.firstIndex(of: "--juno-preview-route"), index + 1 < arguments.count
      else { return nil }
      return arguments[index + 1]
    }
  #endif
}

#if DEBUG
  /// A feature screen in its own stack, as the preview world opens it.
  private struct JunoMobileFeaturePreviewScreen: View {
    let route: JunoMobileFeatureRoute
    let hub: JunoMobileFeatureHub

    var body: some View {
      NavigationStack {
        switch route {
        case .notifications:
          JunoMobileNotificationsView()
        case .skills:
          JunoMobileSkillsView()
        case .routines:
          JunoMobileRoutinesView()
        case .security:
          JunoMobileAccountSecurityView(email: "maya@example.com")
        case .announcement:
          EmptyView()
        }
      }
    }
  }
#endif

/// Skills and Routines, as two rows at the top of Customize: the places the
/// web keeps beside Apps. Hidden when the shell has no transport.
struct JunoMobileCustomizeLinks: View {
  @Environment(\.junoFeatureHub) private var hub

  var body: some View {
    if hub?.sender != nil {
      JunoCard(padding: 0) {
        VStack(spacing: 0) {
          link("Skills", systemImage: "wand.and.sparkles", id: "skills") { JunoMobileSkillsView() }
          Divider().padding(.leading, JunoSpace.region + JunoSpace.regular)
          link("Routines", systemImage: "clock.arrow.circlepath", id: "routines") { JunoMobileRoutinesView() }
        }
      }
    }
  }

  private func link<Destination: View>(
    _ title: String,
    systemImage: String,
    id: String,
    @ViewBuilder destination: @escaping () -> Destination
  ) -> some View {
    NavigationLink {
      destination()
    } label: {
      HStack(spacing: JunoSpace.cozy) {
        Image(systemName: systemImage)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(minWidth: 24)
          .accessibilityHidden(true)
        Text(title)
          .foregroundStyle(Color.primary)
        Spacer(minLength: 0)
        Image(systemName: "chevron.forward")
          .font(.footnote)
          .foregroundStyle(Color.junoTertiaryInk)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, JunoSpace.regular)
      .frame(minHeight: 48)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("juno.mobile.customize.\(id)")
  }
}
