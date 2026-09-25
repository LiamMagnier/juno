import Foundation
import JunoCore
import Observation

/// The inbox, as two reads with two rhythms (`use-notifications.ts`).
///
/// **The dot is a count, polled** every thirty seconds while a window is
/// visible — the rhythm the Needs-you fold keeps — and re-read at once when
/// something says it moved: the app coming back, the task list or the agents
/// changing, a row marked read here.
///
/// **The list is read only when the popover opens**, and again on every
/// open. It is never polled: a list nobody is looking at is a request whose
/// answer is thrown away.
///
/// **No announcements from here.** A run that stops for a person is already
/// announced by the Needs-you signals; saying it twice teaches people to
/// ignore both. Failures the reader caused by pressing something (Show
/// earlier, Mark all as read) are handed to ``onFailure`` for a toast.
///
/// Shared by both apps; only the Mac wires it today.
@MainActor
@Observable
public final class NativeNotificationsModel {
    public enum ListState: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    /// The dot's tone: the accent while something unread is pressing, muted
    /// while it is only news, nothing when all is read.
    public enum DotTone: Equatable, Sendable {
        case accent
        case muted
    }

    public static let pageSize = 20
    private static let pollInterval = Duration.seconds(30)

    /// Nil until the first count lands.
    public private(set) var count: NativeNotificationsCount?
    /// Nil until the first page lands.
    public private(set) var items: [NativeNotification]?
    public private(set) var listState: ListState = .idle
    public private(set) var nextBefore: String?
    public private(set) var isLoadingEarlier = false

    /// Whether any window is on screen. The poll skips while nothing is.
    public var isVisible = true {
        didSet {
            if isVisible, !oldValue { refreshCount() }
        }
    }

    /// A pressed action that did not land: a title and a detail, for the
    /// window's toast host.
    @ObservationIgnored public var onFailure: (@MainActor (String, String?) -> Void)?

    private let client: NativeNotificationsClient
    private var accountID: AccountID?
    private var pollTask: Task<Void, Never>?
    /// Bumped by every read and every optimistic write, so a count that left
    /// before a row was marked read cannot land after it and bring the dot
    /// back.
    private var countSeq = 0
    /// A fresh first page supersedes an earlier page still in flight.
    private var listSeq = 0

    public init(client: NativeNotificationsClient) {
        self.client = client
    }

    public var hasEarlier: Bool { nextBefore != nil }

    public var dotTone: DotTone? { Self.dotTone(count) }

    /// "3 unread", for the row's accessibility value and help; nil at zero.
    public var unreadDetail: String? { Self.unreadDetail(count) }

    // MARK: - Lifecycle

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else {
            refreshCount()
            return
        }
        stop()
        self.accountID = accountID
        refreshCount()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pollInterval)
                guard !Task.isCancelled, let self, self.accountID == accountID else { return }
                if self.isVisible { self.refreshCount() }
            }
        }
    }

    /// Sign-out: forgets everything read for the account.
    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        accountID = nil
        count = nil
        items = nil
        listState = .idle
        nextBefore = nil
        isLoadingEarlier = false
        countSeq += 1
        listSeq += 1
    }

    // MARK: - Reads

    /// Re-reads the dot. The last good count stays on a failed read: a
    /// dropped request is not evidence that everything was read.
    public func refreshCount() {
        guard let accountID else { return }
        countSeq += 1
        let mine = countSeq
        Task { [weak self] in
            guard let self else { return }
            guard let value = try? await client.count(for: accountID) else { return }
            guard mine == countSeq, self.accountID == accountID else { return }
            count = value
        }
    }

    /// Reads the first page again; the popover calls it on every open. Rows
    /// already on screen stay while it does.
    public func load() {
        guard let accountID else { return }
        listSeq += 1
        let mine = listSeq
        listState = .loading
        isLoadingEarlier = false
        Task { [weak self] in
            guard let self else { return }
            let page = try? await client.page(limit: Self.pageSize, for: accountID)
            guard mine == listSeq, self.accountID == accountID else { return }
            guard let page else {
                listState = .failed
                return
            }
            items = page.notifications
            nextBefore = page.nextBefore
            listState = .ready
            countSeq += 1
            count = Self.countFromPage(previous: count, page: page)
        }
    }

    public func loadEarlier() {
        guard let accountID, let before = nextBefore, !isLoadingEarlier else { return }
        let mine = listSeq
        isLoadingEarlier = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await client.page(limit: Self.pageSize, before: before, for: accountID)
                guard mine == listSeq, self.accountID == accountID else { return }
                isLoadingEarlier = false
                items = Self.appendPage(items ?? [], page.notifications)
                nextBefore = page.nextBefore
            } catch {
                guard mine == listSeq, self.accountID == accountID else { return }
                isLoadingEarlier = false
                onFailure?("Couldn’t load earlier notifications.", NativeFailureMessage.presentable(error))
            }
        }
    }

    // MARK: - Writes

    /// Read at once, confirmed after. A row opened is a row read; if the
    /// write does not stick the row goes back to unread and the dot is asked
    /// again.
    public func markRead(_ id: String) {
        guard let accountID, let row = items?.first(where: { $0.id == id }), row.isUnread else { return }
        items = items.map { Self.withRead($0, id: id, at: Date()) }
        countSeq += 1
        count = Self.countAfterRead(count)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await client.markRead(id: id, for: accountID)
            } catch {
                guard self.accountID == accountID else { return }
                items = items.map { Self.withUnread($0, id: id) }
                refreshCount()
            }
        }
    }

    public func markAllRead() {
        guard let accountID else { return }
        let before = items
        items = items.map { Self.withAllRead($0, at: Date()) }
        countSeq += 1
        count = NativeNotificationsCount(unreadCount: 0, urgent: false)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await client.markAllRead(for: accountID)
            } catch {
                guard self.accountID == accountID else { return }
                items = before
                refreshCount()
                onFailure?("Couldn’t mark your notifications as read.", NativeFailureMessage.presentable(error))
            }
        }
    }

    // MARK: - The inbox's small decisions (`inbox-model.ts`)

    public nonisolated static func dotTone(_ count: NativeNotificationsCount?) -> DotTone? {
        guard let count, count.unreadCount > 0 else { return nil }
        return count.urgent ? .accent : .muted
    }

    public nonisolated static func unreadDetail(_ count: NativeNotificationsCount?) -> String? {
        guard let count, count.unreadCount > 0 else { return nil }
        return "\(count.unreadCount) unread"
    }

    nonisolated static func withRead(_ items: [NativeNotification], id: String, at date: Date) -> [NativeNotification] {
        guard items.contains(where: { $0.id == id && $0.isUnread }) else { return items }
        return items.map { row in
            var row = row
            if row.id == id, row.isUnread { row.readAt = date }
            return row
        }
    }

    nonisolated static func withUnread(_ items: [NativeNotification], id: String) -> [NativeNotification] {
        items.map { row in
            var row = row
            if row.id == id { row.readAt = nil }
            return row
        }
    }

    nonisolated static func withAllRead(_ items: [NativeNotification], at date: Date) -> [NativeNotification] {
        guard items.contains(where: \.isUnread) else { return items }
        return items.map { row in
            var row = row
            if row.isUnread { row.readAt = date }
            return row
        }
    }

    /// The count once one unread row has been read here, ahead of the server.
    nonisolated static func countAfterRead(_ count: NativeNotificationsCount?) -> NativeNotificationsCount? {
        guard let count else { return nil }
        let unread = max(0, count.unreadCount - 1)
        return NativeNotificationsCount(unreadCount: unread, urgent: unread > 0 && count.urgent)
    }

    /// The count a fresh page implies. Its total replaces the dot's number;
    /// whether any of it is pressing is known only for the rows on the page,
    /// so an accent the last count carried is kept rather than dropped on a
    /// guess.
    nonisolated static func countFromPage(
        previous: NativeNotificationsCount?,
        page: NativeNotificationsPage
    ) -> NativeNotificationsCount {
        let unread = max(0, page.unreadCount)
        let pressingHere = page.notifications.contains { $0.isUnread && $0.isPressing }
        return NativeNotificationsCount(
            unreadCount: unread,
            urgent: unread > 0 && (pressingHere || (previous?.urgent ?? false))
        )
    }

    /// An earlier page appended, with any row already shown left out.
    nonisolated static func appendPage(
        _ items: [NativeNotification],
        _ earlier: [NativeNotification]
    ) -> [NativeNotification] {
        let seen = Set(items.map(\.id))
        return items + earlier.filter { !seen.contains($0.id) }
    }

    /// `formatAgo`: "just now", "12 min ago", "3 h ago", then the weekday,
    /// then "12 Oct" — the web's words for when a notification arrived.
    public nonisolated static func ago(_ date: Date, now: Date = Date(), locale: Locale = .current) -> String {
        let minutes = Int((now.timeIntervalSince(date) / 60).rounded())
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "\(hours) h ago" }
        let days = Int((Double(hours) / 24).rounded())
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated).locale(locale)) }
        return date.formatted(.dateTime.day().month(.abbreviated).locale(locale))
    }

    /// Seeds a state without a network: previews, snapshots and tests only.
    public func preview(count: NativeNotificationsCount?, items: [NativeNotification]?, state: ListState, nextBefore: String? = nil) {
        self.count = count
        self.items = items
        self.listState = state
        self.nextBefore = nextBefore
    }
}
