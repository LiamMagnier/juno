import AppKit
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI

// MARK: - The sidebar row

/// Notifications, as a row in the column's navigation block (register #62):
/// right after New chat, the web's New chat · Search · Notifications — the
/// Mac's Search is the button pinned above the list.
///
/// **An action, not a destination.** It opens something over the page
/// rather than going somewhere, so it is never tagged and never selected;
/// there is no notifications page.
///
/// **One signal, and never a number.** An 8pt dot at rest: the accent while
/// something unread is asking for a decision, the secondary ink while it is
/// only news, nothing when all is read. The number rides the accessibility
/// value and the help, where a dot cannot say it.
struct DesktopNotificationsRow: View {
    let model: NativeNotificationsModel
    /// Where a row's link goes: main's route, handed to this window.
    var follow: (JunoNotificationRoute) -> Void = { DesktopWorkbenchRegistry.shared.requestRoute($0) }
    /// Whether the popover is up. The window holds it, so ⌘K's "Open
    /// notifications" opens the same popover from the same row.
    @Binding var isOpen: Bool

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            Label {
                HStack(spacing: JunoSpace.tight) {
                    Text("Notifications")
                    Spacer(minLength: JunoSpace.hairline)
                    if let tone = model.dotTone {
                        DesktopUnreadDot(pressing: tone == .accent)
                    }
                }
            } icon: {
                JunoSymbol(.notifications)
                    .foregroundStyle(Color.junoSidebarInk)
            }
            .foregroundStyle(Color.junoSidebarInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(model.unreadDetail.map { "Notifications · \($0)" } ?? "Notifications")
        .accessibilityLabel("Notifications")
        .accessibilityValue(model.unreadDetail ?? "")
        .accessibilityIdentifier("juno.desktop.sidebar.notifications")
        .popover(isPresented: $isOpen, arrowEdge: .trailing) {
            DesktopNotificationsPopover(model: model) { notification in
                open(notification)
            }
            .frame(width: DesktopNotificationsPopover.width, height: DesktopNotificationsPopover.height(for: model))
        }
    }

    /// A row pressed: read at once, then — when it goes somewhere — followed,
    /// and the popover closes. A row with nowhere to go only marks read.
    private func open(_ notification: NativeNotification) {
        model.markRead(notification.id)
        guard let href = notification.href, let route = JunoNotificationRoute(path: href) else { return }
        isOpen = false
        follow(route)
    }
}

/// The inbox's one trailing signal: an 8pt dot, the accent while pressing and
/// the secondary ink while it is news (the web's `NeedsYouDot`).
struct DesktopUnreadDot: View {
    let pressing: Bool

    var body: some View {
        Circle()
            .fill(pressing ? Color.junoAccent : Color.junoSecondaryInk)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

// MARK: - The popover

/// The inbox (`notifications-popover.tsx`): every row is a door to something
/// that already exists — the chat a task ran in, the agent with news — so
/// nothing here is answered in place. An approval is decided on its card,
/// where the transcript it is about is on screen.
///
/// Opaque rows on the popover's own material, no glass of our own (§0.1).
/// The list is read again on every open, so it is never older than the
/// moment it was opened; rows already on screen stay while it is.
struct DesktopNotificationsPopover: View {
    static let width: CGFloat = 384
    /// The list's height: the web's `max-h-[36rem]`, within a window's reach.
    static let height: CGFloat = 480
    /// An empty or failed inbox is one panel under the header; the popover
    /// closes up round it rather than hanging a blank half-page below.
    static let compactHeight: CGFloat = 272

    /// Explicit either way (the crash rules): the list and its loading rows
    /// take the full height, an empty or failed inbox the compact one.
    @MainActor
    static func height(for model: NativeNotificationsModel) -> CGFloat {
        if let items = model.items { return items.isEmpty ? compactHeight : height }
        return model.listState == .failed ? compactHeight : height
    }

    let model: NativeNotificationsModel
    let open: (NativeNotification) -> Void
    /// A pinned "now" for snapshots. Nil ticks with the clock.
    var now: Date? = nil
    /// Snapshots draw a seeded state and must not read the network.
    var loadsOnAppear = true

    @FocusState private var focusedRow: String?

    private var unread: Int {
        model.count?.unreadCount ?? model.items?.filter(\.isUnread).count ?? 0
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        // Focus lands on the list, never on "Mark all as read": a second
        // Return from the keyboard that opened it must not clear the inbox.
        .defaultFocus($focusedRow, model.items?.first?.id)
        .onAppear { if loadsOnAppear { model.load() } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Notifications")
    }

    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
            Text("Notifications")
                .junoFont(size: 15, relativeTo: .headline, weight: .medium)
                .foregroundStyle(Color.junoForeground)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            if unread > 0 {
                Button("Mark all as read") { model.markAllRead() }
                    .buttonStyle(.borderless)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .frame(minHeight: 28)
                    .contentShape(.rect)
            }
        }
        .padding(.leading, JunoSpace.regular)
        .padding(.trailing, JunoSpace.cozy)
        .frame(height: 48)
    }

    @ViewBuilder
    private var content: some View {
        if let items = model.items {
            if items.isEmpty {
                JunoEmptyState(
                    title: "Nothing new",
                    message: "Juno tells you here when a task finishes, needs you, or an agent has something to share.",
                    icon: .notifications,
                    size: .panel,
                    tone: .empty
                )
                .padding([.horizontal, .bottom], JunoSpace.tight)
            } else {
                list(items)
            }
        } else if model.listState == .failed {
            JunoEmptyState(
                title: "Couldn’t load notifications",
                message: "Check your connection and try again.",
                icon: .notifications,
                actionLabel: "Try again",
                action: { model.load() },
                size: .panel,
                tone: .error
            )
            .padding([.horizontal, .bottom], JunoSpace.tight)
        } else {
            DesktopNotificationsLoadingRows()
                .padding([.horizontal, .bottom], JunoSpace.tight)
        }
    }

    private func list(_ items: [NativeNotification]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(items) { notification in
                    DesktopNotificationRowView(notification: notification, now: now) {
                        open(notification)
                    }
                    .focused($focusedRow, equals: notification.id)
                }
                if model.hasEarlier {
                    Button {
                        model.loadEarlier()
                    } label: {
                        HStack(spacing: JunoSpace.tight) {
                            if model.isLoadingEarlier {
                                ProgressView().controlSize(.mini)
                            }
                            Text("Show earlier")
                        }
                        .frame(maxWidth: .infinity, minHeight: 28)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .junoFont(size: 13, relativeTo: .callout)
                    .foregroundStyle(Color.junoSecondaryInk)
                    .disabled(model.isLoadingEarlier)
                    .padding(.top, JunoSpace.hairline)
                }
            }
            .padding([.horizontal, .bottom], JunoSpace.tight)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

// MARK: - A row

/// One notification (`notification-row.tsx`): who it is from, what happened,
/// when, and whether it has been read.
///
/// **The leading mark says who** — the agent's face at rest, or Juno's mark
/// for Juno's own news — so the list reads as people before it reads as
/// events. It is the popover's signature detail, and the only mark a row
/// has: no per-kind glyph.
///
/// Text on the popover until the pointer lands, then the hover fill at the
/// control radius. Read rows step their title down to the secondary ink, so an
/// unread row outranks a read one even for a reader who cannot see the dot.
struct DesktopNotificationRowView: View {
    let notification: NativeNotification
    var now: Date? = nil
    let open: () -> Void

    @State private var isHovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: JunoSpace.close) {
                mark
                    .frame(width: 20, height: 20)
                VStack(alignment: .leading, spacing: JunoSpace.micro) {
                    Text(notification.title)
                        .junoFont(size: 14, relativeTo: .body)
                        .foregroundStyle(notification.isUnread ? Color.junoForeground : Color.junoSecondaryInk)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(secondLine)
                        .junoFont(size: 11, relativeTo: .caption)
                        .foregroundStyle(Color.junoSecondaryInk)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if notification.isUnread {
                    DesktopUnreadDot(pressing: notification.isPressing)
                        // Centred on the title's line.
                        .padding(.top, 6)
                }
            }
            .padding(.vertical, JunoSpace.snug)
            .padding(.horizontal, JunoSpace.close)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous)
                    .fill(isHovering ? Color.junoHover : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
                isHovering = hovering
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: (notification.isUnread ? "Unread: " : "") + notification.title))
        .accessibilityValue(Text(verbatim: secondLine))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(notification.href == nil ? "Marks it read" : "Opens it")
    }

    private var secondLine: String {
        let when = NativeNotificationsModel.ago(notification.createdAt, now: now ?? Date())
        return notification.body.isEmpty ? when : "\(when) · \(notification.body)"
    }

    /// The face at rest (`idle`): a notification is a moment that has passed,
    /// not the agent's live state, and an idle face never loops.
    @ViewBuilder
    private var mark: some View {
        if let agent = notification.agent {
            JunoAgentFace(
                avatar: JunoAgentAvatar(
                    shape: agent.avatarShape, tone: agent.avatarTone,
                    eyes: agent.avatarEyes, mark: agent.avatarMark, seed: agent.id
                ),
                state: .idle,
                size: JunoAgentFaceSize.xs
            )
        } else {
            JunoMark(size: 16)
                .foregroundStyle(Color.junoForeground)
        }
    }
}

// MARK: - Loading

/// Three rows of uneven length on the rows' own pitch, so nothing moves when
/// the rows arrive.
struct DesktopNotificationsLoadingRows: View {
    private static let widths: [CGFloat] = [0.64, 0.78, 0.52]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Self.widths.enumerated()), id: \.offset) { _, fraction in
                HStack(alignment: .top, spacing: JunoSpace.close) {
                    JunoSkeleton(height: 20, width: 20, cornerRadius: 10)
                    VStack(alignment: .leading, spacing: JunoSpace.snug) {
                        GeometryReader { proxy in
                            JunoSkeleton(height: 12, width: proxy.size.width * fraction, cornerRadius: 6)
                        }
                        .frame(height: 12)
                        JunoSkeleton(height: 10, cornerRadius: 5)
                            .padding(.trailing, JunoSpace.regular)
                    }
                    .padding(.top, JunoSpace.hairline)
                }
                .padding(.vertical, JunoSpace.snug)
                .padding(.horizontal, JunoSpace.close)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading notifications")
    }
}
