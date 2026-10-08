#if DEBUG
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit

/// Canned answers for the profile, the @username and the Mac's billing
/// extras, in the routes' exact shapes. Invented and plausible: a year of
/// activity drawn from a fixed seed so every launch paints the same grid.
public enum PreviewProfileFixtures {
    /// The body for a request these screens make, or nil for anyone else's.
    public static func body(for request: NativeBearerRequest, empty: Bool = false) -> Data? {
        switch (request.method, request.path) {
        case (.get, NativeProfileClient.activityPath):
            return Data((empty ? emptyActivityJSON() : activityJSON()).utf8)
        case (.get, NativeUsernameClient.path):
            if let name = request.queryItems.first(where: { $0.name == "check" })?.value {
                let normalized = NativeUsernameRules.normalize(name)
                if ["maya", "alevr", "admin"].contains(normalized) {
                    return Data(#"{"username":"\#(normalized)","available":false,"problem":"taken","message":"That username is taken."}"#.utf8)
                }
                return Data(#"{"username":"\#(normalized)","available":true}"#.utf8)
            }
            return Data(#"{"username":"maya.lindqvist","handle":"maya.lindqvist"}"#.utf8)
        case (.patch, NativeUsernameClient.path):
            let object = request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let name = (object?["username"] as? String) ?? "maya.lindqvist"
            return Data(#"{"ok":true,"username":"\#(name)","handle":"\#(name)"}"#.utf8)
        case (.get, NativeBillingClient.cancelPath):
            return Data(#"{"source":"stripe","active":true,"cancelAtPeriodEnd":false,"recap":{"reference":"AL-7Q2M-K4","name":"Maya Lindqvist","email":"maya@example.com","planName":"Plus","interval":null,"endsAt":"\#(iso(days: 26))"}}"#.utf8)
        case (.post, NativeBillingClient.cancelPath):
            return Data(#"{"ok":true,"cancelAtPeriodEnd":true,"emailed":true}"#.utf8)
        case (.get, NativeBillingClient.creditsPath):
            return Data(#"{"availableEur":7.4,"nextExpiryMs":\#(Int(Date().addingTimeInterval(300 * 86_400).timeIntervalSince1970 * 1000)),"canBuy":true,"plan":"PLUS","packs":[{"id":"5","htEur":5,"creditEur":5},{"id":"20","htEur":20,"creditEur":21}]}"#.utf8)
        case (.get, NativeBillingClient.referralsPath):
            return Data(#"{"code":"MAYA7Q","link":"https://alevr.com/r/MAYA7Q","rewarded":2,"pending":1,"rewardEur":5,"maxRewards":10}"#.utf8)
        default:
            return nil
        }
    }

    private static func iso(days: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(days * 86_400))
    }

    /// A year of days, quieter at weekends, with a few long gaps and one
    /// enormous day, so every heat step and the quartile scale show.
    public static func activityJSON(now: Date = Date()) -> String {
        let zone = TimeZone.current
        let today = NativeProfileDays.today(in: zone, now: now)
        var seed: UInt64 = 0x5EED_A1E7
        func next() -> Double {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(seed >> 33) / Double(1 << 31)
        }
        var days: [(String, Int)] = []
        for back in stride(from: 370, through: 0, by: -1) {
            let date = NativeProfileDays.addDays(today, -back)
            let weekend = NativeProfileDays.weekdayMondayFirst(date) >= 5
            let roll = next()
            let gap = (120...134).contains(back) || (40...44).contains(back)
            if gap || roll < (weekend ? 0.62 : 0.18) { continue }
            let base = weekend ? 60_000.0 : 380_000.0
            var tokens = Int(base * (0.2 + 3.2 * next() * next()))
            if back == 23 { tokens = 4_200_000 }
            days.append((date, tokens))
        }
        let peak = days.max { $0.1 < $1.1 } ?? (today, 0)
        let lifetime = days.reduce(0) { $0 + $1.1 } + 61_400_000
        let streak = NativeProfileMath.streaks(days.map(\.0), today: today)
        let dayRows = days.map { #"{"date":"\#($0.0)","tokens":\#($0.1)}"# }.joined(separator: ",")
        let shares: [(String, String, String?, Double, Int)] = [
            ("anthropic:claude-opus-5-5", "Claude Opus 5.5", "anthropic", 0.41, 1_204),
            ("openai:gpt-5.5", "GPT-5.5", "openai", 0.22, 688),
            ("google:gemini-3-pro", "Gemini 3 Pro", "google", 0.16, 402),
            ("anthropic:claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", 0.11, 1_911),
            ("deepseek:deepseek-v4", "DeepSeek V4", "deepseek", 0.06, 140),
            ("other", "3 other models", nil, 0.04, 77),
        ]
        let modelRows = shares.map { row in
            let provider = row.2.map { "\"\($0)\"" } ?? "null"
            return #"{"model":"\#(row.0)","label":"\#(row.1)","provider":\#(provider),"tokens":\#(Int(Double(lifetime) * row.3)),"requests":\#(row.4),"share":\#(row.3)}"#
        }.joined(separator: ",")
        return """
        {"username":"maya.lindqvist","handle":"maya.lindqvist","timeZone":"\(zone.identifier)","today":"\(today)",\
        "memberSince":"\(iso(days: -400))","lifetimeTokens":\(lifetime),\
        "peakDay":{"date":"\(peak.0)","tokens":\(peak.1)},"longestTask":{"ms":5880000,"kind":"research"},\
        "streak":{"current":\(streak.current),"longest":\(streak.longest)},"activeDays":\(days.count),\
        "days":[\(dayRows)],"models":[\(modelRows)],"modelCount":8}
        """
    }

    public static func emptyActivityJSON(now: Date = Date()) -> String {
        let zone = TimeZone.current
        let today = NativeProfileDays.today(in: zone, now: now)
        return #"{"username":null,"handle":"maya","timeZone":"\#(zone.identifier)","today":"\#(today)","memberSince":null,"lifetimeTokens":0,"peakDay":null,"longestTask":null,"streak":{"current":0,"longest":0},"activeDays":0,"days":[],"models":[],"modelCount":0}"#
    }
}
#endif
