import Combine
import Foundation

/// The clock events that move a calendar-relative label onto a different day.
///
/// `NativeConversationGrouping` measures every bucket boundary from an injected
/// `now`, so a view that reads the clock once keeps labelling yesterday's rows
/// "Today" until something tells it to read the clock again. This is that
/// something: the day rolling over under a Mac left open overnight, plus the two
/// jumps that move the boundary without a day elapsing — the clock being set (or
/// corrected on wake) and the time zone changing under
/// `Calendar.autoupdatingCurrent`.
///
/// Notifications rather than a midnight timer: Foundation already owns the
/// scheduling, and the same subscription covers the sleep-through-midnight and
/// travel cases a single `startOfDay` timer would have to re-arm around.
enum JunoMacDayChange {
    static let notificationNames: [Notification.Name] = [
        .NSCalendarDayChanged,
        .NSSystemClockDidChange,
        .NSSystemTimeZoneDidChange,
    ]

    /// The process-wide signal, built once: a view's `onReceive` is handed the
    /// same publisher on every body evaluation rather than a new one to
    /// subscribe to. Main-actor bound because that is where its only consumers
    /// — SwiftUI bodies — read it, and `AnyPublisher` is not `Sendable`.
    @MainActor static let signal = publisher()

    /// Emits a freshly read `Date` on the main run loop whenever one of those
    /// events lands. `NSCalendarDayChanged` is not guaranteed to be posted on
    /// the main thread, so the hop is required before the value reaches
    /// `@State`.
    ///
    /// `center` is injectable so tests can post the signals without touching the
    /// process-wide notification center.
    static func publisher(center: NotificationCenter = .default) -> AnyPublisher<Date, Never> {
        Publishers.MergeMany(notificationNames.map { center.publisher(for: $0) })
            .receive(on: RunLoop.main)
            .map { _ in Date() }
            .eraseToAnyPublisher()
    }
}
