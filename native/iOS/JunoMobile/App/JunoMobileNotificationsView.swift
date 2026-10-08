import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

// MARK: - The bell

/// The inbox's way in: a bell in the drawer's header. It opens the inbox as a
/// sheet of its own, so the drawer underneath keeps its place.
///
/// One signal and never a number: the plain bell when everything is read,
/// `bell.badge` in the ink colour while something is unread. The count rides
/// the accessibility value, where a glyph cannot say it.
struct JunoMobileInboxBell: View {
  @Environment(\.junoFeatureHub) private var hub
  @State private var isPresented = false

  var body: some View {
    if let model = hub?.notifications {
      Button {
        isPresented = true
      } label: {
        // One mark, read or unread: the count rides the accessibility
        // value, never a badge dot.
        JunoIconView(.bell, size: 19)
          .foregroundStyle(Color.primary)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Notifications")
      .accessibilityValue(model.unreadDetail ?? "")
      .accessibilityIdentifier("juno.mobile.notifications")
      .sheet(isPresented: $isPresented) {
        NavigationStack {
          JunoMobileNotificationsView(close: { isPresented = false })
        }
        .tint(Color.junoAccent)
      }
    }
  }
}

// MARK: - The inbox

/// The inbox (`notifications-popover.tsx`): unread first, then what has been
/// read; opening a row marks it read and, when it points somewhere, goes
/// there — the chat a task ran in, an Orbit agent, a task's thread. Nothing is
/// answered in place: an approval is decided on its card, beside the
/// transcript it is about.
///
/// The list is read again every time the screen opens, so it is never older
/// than the moment it was opened.
struct JunoMobileNotificationsView: View {
  /// Closes the sheet the inbox is in, before a row navigates.
  var close: (() -> Void)? = nil

  @Environment(\.junoFeatureHub) private var hub
  @Environment(\.dismiss) private var dismiss

  private var model: NativeNotificationsModel? { hub?.notifications }

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        ContentUnavailableView {
          Label("Notifications are unavailable", icon: .bell, size: 44)
        }
      }
    }
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let model, (model.count?.unreadCount ?? 0) > 0 || (model.items ?? []).contains(where: \.isUnread) {
        ToolbarItem(placement: .topBarLeading) {
          Menu {
            Button { model.markAllRead() } label: { Label("Mark All as Read", icon: .circleCheck) }
              .accessibilityIdentifier("juno.mobile.notifications.mark-all")
          } label: {
            JunoIconView(.ellipsis, size: 18)
              .accessibilityLabel("More")
          }
        }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Done") { finish() }
      }
    }
    .onAppear { model?.load() }
  }

  @ViewBuilder
  private func content(_ model: NativeNotificationsModel) -> some View {
    if let items = model.items {
      if items.isEmpty {
        ContentUnavailableView {
          Label("Nothing new", icon: .bell, size: 44)
        } description: {
          Text("Alevr tells you here when a task finishes, needs you, or an Orbit agent has something to share.")
        }
      } else {
        list(model, items)
      }
    } else if model.listState == .failed {
      ContentUnavailableView {
        Label("Couldn’t load notifications", icon: .wifiOff, size: 44)
      } description: {
        Text("Check your connection and try again.")
      } actions: {
        Button("Try Again") { model.load() }
      .contentShape(.rect)
      }
    } else {
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Loading notifications")
    }
  }

  private func list(_ model: NativeNotificationsModel, _ items: [NativeNotification]) -> some View {
    let unread = items.filter(\.isUnread)
    let read = items.filter { !$0.isUnread }
    return List {
      if !unread.isEmpty {
        Section("Unread") {
          ForEach(unread) { row($0, model: model) }
        }
      }
      if !read.isEmpty {
        Section(unread.isEmpty ? "" : "Earlier") {
          ForEach(read) { row($0, model: model) }
        }
      }
      if model.hasEarlier {
        Section {
          Button {
            model.loadEarlier()
          } label: {
            HStack {
              Text("Show Earlier")
              Spacer()
              if model.isLoadingEarlier { ProgressView() }
            }
            .contentShape(.rect)
          }
          .disabled(model.isLoadingEarlier)
          .accessibilityIdentifier("juno.mobile.notifications.earlier")
        }
      }
    }
    .listStyle(.insetGrouped)
    .refreshable { model.load() }
  }

  private func row(_ notification: NativeNotification, model: NativeNotificationsModel) -> some View {
    Button {
      open(notification, model: model)
    } label: {
      JunoMobileNotificationRow(notification: notification)
    }
    .buttonStyle(.plain)
    .accessibilityHint(notification.href == nil ? "Marks it read" : "Opens it")
      .contentShape(.rect)
  }

  /// Read at once; then, when it goes somewhere, the sheet closes and the
  /// shell navigates through the same launch request a push tap uses.
  private func open(_ notification: NativeNotification, model: NativeNotificationsModel) {
    model.markRead(notification.id)
    guard let href = notification.href, let route = JunoNotificationRoute(path: href) else { return }
    finish()
    JunoMobileLaunchRequests.shared.request(JunoMobileLaunchRequests.request(for: route))
  }

  private func finish() {
    if let close { close() } else { dismiss() }
  }
}

/// One notification: who it is from, what happened and when. An unread title
/// is in the ink at the medium weight; a read one steps down to the secondary
/// ink, so the difference survives without colour. A row asking for a
/// decision says so in words, in the attention colour, with no container.
struct JunoMobileNotificationRow: View {
  let notification: NativeNotification
  var now: Date = Date()

  var body: some View {
    HStack(alignment: .top, spacing: JunoSpace.cozy) {
      mark
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(notification.title)
          .font(.body.weight(notification.isUnread ? .medium : .regular))
          .foregroundStyle(notification.isUnread ? Color.primary : Color.junoSecondaryInk)
          .lineLimit(2)
        if !notification.body.isEmpty {
          Text(notification.body)
            .font(.subheadline)
            .foregroundStyle(Color.junoSecondaryInk)
            .lineLimit(3)
        }
        HStack(spacing: JunoSpace.snug) {
          Text(NativeNotificationsModel.ago(notification.createdAt, now: now))
          if notification.isUnread, notification.isPressing {
            Label("Needs you", icon: .error, size: 13)
              .foregroundStyle(Color.junoWarningInk)
          }
        }
        .font(.footnote)
        .foregroundStyle(Color.junoSecondaryInk)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if notification.href != nil {
        JunoIconView(.chevronRight, size: 13)
          .foregroundStyle(Color.junoTertiaryInk)
          .padding(.top, 4)
          .accessibilityHidden(true)
      }
    }
    .padding(.vertical, 4)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text(verbatim: (notification.isUnread ? "Unread: " : "") + notification.title))
  }

  /// The agent's face at rest, or the Alevr mark for the product's own news.
  @ViewBuilder
  private var mark: some View {
    if let agent = notification.agent {
      JunoAgentFace(
        avatar: JunoAgentAvatar(
          shape: agent.avatarShape, tone: agent.avatarTone,
          eyes: agent.avatarEyes, mark: agent.avatarMark, seed: agent.id
        ),
        state: .idle,
        size: JunoAgentFaceSize.sm
      )
    } else {
      JunoMark(size: 20)
        .foregroundStyle(Color.primary)
    }
  }
}

// MARK: - Announcements

/// An announcement (`announcement-popup.tsx`) as a sheet: the picture, an
/// optional model name, the title and description, then the links. Closing
/// it by any route dismisses it for good on this device and on the server.
struct JunoMobileAnnouncementSheet: View {
  let announcement: NativeAnnouncement
  let close: () -> Void

  @Environment(\.openURL) private var openURL

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: JunoSpace.regular) {
          visual
            .aspectRatio(16 / 9, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.field, style: .continuous))

          VStack(alignment: .leading, spacing: JunoSpace.snug) {
            if let model = announcement.modelName, !model.isEmpty {
              Text(model)
                .font(.subheadline)
                .foregroundStyle(Color.junoSecondaryInk)
            }
            Text(announcement.title)
              .font(.title2.weight(.semibold))
              .foregroundStyle(Color.primary)
              .accessibilityAddTraits(.isHeader)
            Text(announcement.description)
              .font(.body)
              .foregroundStyle(Color.junoSecondaryInk)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: JunoSpace.snug) {
            if announcement.hasCallToAction, let label = announcement.ctaLabel {
              Button {
                follow(announcement.ctaHref)
              } label: {
                Text(label).frame(maxWidth: .infinity, minHeight: 44)
              }
              .buttonStyle(.glassProminent)
              .contentShape(.rect)
            }
            if let news = announcement.newsHref, !news.isEmpty {
              Button {
                follow(news)
              } label: {
                Text(announcement.newsLabel?.isEmpty == false ? announcement.newsLabel! : "Read More")
                  .frame(maxWidth: .infinity, minHeight: 44)
              }
              .buttonStyle(.glass)
              .contentShape(.rect)
            }
          }
          .padding(.top, JunoSpace.snug)
        }
        .padding(JunoSpace.regular)
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Not Now", action: close)
            .accessibilityIdentifier("juno.mobile.announcement.close")
        }
      }
    }
    .presentationDetents([.large])
    .tint(Color.junoAccent)
  }

  @ViewBuilder
  private var visual: some View {
    ZStack {
      Color.junoSecondary
      if let image = resolved(announcement.imageURL) {
        AsyncImage(url: image) { phase in
          if case .success(let picture) = phase {
            if image.path.contains("/provider-logos/") {
              picture.resizable().scaledToFit().padding(JunoSpace.expanse)
            } else {
              picture.resizable().scaledToFill()
            }
          } else {
            Color.junoSecondary
          }
        }
      } else if let provider = announcement.provider {
        JunoProviderMark(providerID: provider, providerName: provider, size: 56)
      } else {
        JunoMark(size: 44)
          .foregroundStyle(Color.junoSecondaryInk)
      }
    }
    .accessibilityHidden(true)
  }

  /// A relative path is the web's own asset.
  private func resolved(_ url: URL?) -> URL? {
    guard let url else { return nil }
    if url.scheme == nil { return URL(string: JunoBackend.productionURLString + url.absoluteString) }
    return url
  }

  /// In-app paths a notification could open go through the shell; every
  /// other link opens in the browser.
  private func follow(_ href: String?) {
    close()
    guard let href, !href.isEmpty else { return }
    if href.hasPrefix("/"), let route = JunoNotificationRoute(path: href) {
      JunoMobileLaunchRequests.shared.request(JunoMobileLaunchRequests.request(for: route))
    } else if href.hasPrefix("/") {
      if let url = URL(string: JunoBackend.productionURLString + href) { openURL(url) }
    } else if let url = URL(string: href), url.scheme == "https" {
      openURL(url)
    }
  }
}
