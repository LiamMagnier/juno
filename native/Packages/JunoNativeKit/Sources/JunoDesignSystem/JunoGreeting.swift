import Foundation

/// The home greeting, ported verbatim from the website's `TIME_GREETINGS` in
/// `src/components/chat/empty-state.tsx`.
///
/// The buckets and the phrases inside them are the web's, in the web's order, so
/// the phone greets you the same way the site does at the same hour. The port is
/// kept as pure data plus one pure function precisely so it can be tested
/// against the source table without standing up a view.
public enum JunoGreeting {
    /// A half-open hour range `[from, to)` and the phrases it may use.
    public struct Bucket: Equatable, Sendable {
        public let from: Int
        public let to: Int
        public let phrases: [String]
    }

    /// Verbatim from the web. Order matters: lookup takes the first match.
    public static let buckets: [Bucket] = [
        Bucket(from: 0, to: 5, phrases: [
            "Moonlight chat", "Burning the midnight oil", "Late-night thoughts",
            "The world's asleep", "Night owl mode", "Can't sleep?",
        ]),
        Bucket(from: 5, to: 7, phrases: [
            "Rise and shine", "Early bird", "Up before the sun", "Dawn patrol",
        ]),
        Bucket(from: 7, to: 12, phrases: [
            "Good morning", "Morning", "Bright and early", "Fresh start", "Rise and grind",
        ]),
        Bucket(from: 12, to: 14, phrases: [
            "Good afternoon", "Midday check-in", "Lunch-hour thoughts",
        ]),
        Bucket(from: 14, to: 18, phrases: [
            "Good afternoon", "Afternoon", "Hitting your stride", "Halfway there",
        ]),
        Bucket(from: 18, to: 22, phrases: [
            "Good evening", "Winding down", "Evening", "Golden hour",
        ]),
        Bucket(from: 22, to: 24, phrases: [
            "Good evening", "Late shift", "Still going", "Night owl",
        ]),
    ]

    /// The bucket covering `hour`. Falls back to the morning bucket exactly as
    /// the web's `?? TIME_GREETINGS[2]` does, so an out-of-range hour cannot
    /// produce an empty greeting.
    public static func bucket(forHour hour: Int) -> Bucket {
        buckets.first { hour >= $0.from && hour < $0.to } ?? buckets[2]
    }

    /// A phrase for `hour`.
    ///
    /// - Parameter varied: when false, picks deterministically by `hour % count`
    ///   — the web's server-render path, and what makes a screenshot
    ///   reproducible. When true, picks at random, as the web does once mounted,
    ///   so the greeting varies between visits.
    public static func phrase(forHour hour: Int, varied: Bool = true) -> String {
        let bucket = bucket(forHour: hour)
        guard !bucket.phrases.isEmpty else { return "Hello" }
        let index = varied
            ? Int.random(in: 0..<bucket.phrases.count)
            : abs(hour) % bucket.phrases.count
        return bucket.phrases[index]
    }

    /// A phrase for the given moment in the given calendar.
    public static func phrase(
        at date: Date,
        calendar: Calendar = .current,
        varied: Bool = true
    ) -> String {
        phrase(forHour: calendar.component(.hour, from: date), varied: varied)
    }

    /// The first name the greeting addresses, or nil when the account has none.
    /// Matches the web's `user.name?.split(" ")[0]`.
    public static func firstName(from fullName: String?) -> String? {
        guard let first = fullName?.split(separator: " ").first, !first.isEmpty else {
            return nil
        }
        return String(first)
    }
}
