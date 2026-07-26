import JunoChatKit

/// The Usage screen's data layer now lives in `JunoNativeKit`, as
/// `NativeUsageBreakdown` and friends — the phone shows the same numbers, read
/// from the same two routes, and a contribution grid that laid its days out
/// differently on each platform would be two bugs waiting to disagree.
///
/// These aliases keep the Mac's own names, because on this screen "Desktop…" is
/// what every call site and every test already says, and renaming 800 lines of
/// view code to prove the types moved would be a diff about nothing.
typealias DesktopUsageBreakdown = NativeUsageBreakdown
typealias DesktopUsageTotals = NativeUsageTotals
typealias DesktopUsageSurfaceTotals = NativeUsageSurfaceTotals
typealias DesktopUsageModelTotals = NativeUsageModelTotals
typealias DesktopUsageDay = NativeUsageDay
typealias DesktopUsagePace = NativeUsagePace
typealias DesktopUsageActivityCell = NativeUsageActivityCell
typealias DesktopUsageFormat = NativeUsageFormat
typealias DesktopUsagePlan = NativeUsagePlan
typealias DesktopUsageRange = NativeUsageRange
