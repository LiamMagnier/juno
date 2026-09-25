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

/// A ledger model identifier, resolved against the signed-in manifest.
///
/// The ledger stores the canonical `provider:model` identifier at the moment of
/// the request, so it can name a model the account can no longer select. Such a
/// row keeps its identifier rather than being renamed or dropped — the spend was
/// real and hiding it would make the totals stop adding up. (Moved here from the
/// Usage page, which Plan & usage replaced in Phase 3.)
struct DesktopUsageModelIdentity {
    let providerID: String
    let providerName: String
    let displayName: String

    init(id: String, catalog: [NativeChatModelOption]) {
        if let known = catalog.first(where: { $0.id == id }) {
            providerID = known.providerID
            providerName = known.providerName
            displayName = known.displayName
            return
        }
        let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
        let provider = parts.count == 2 ? parts[0] : ""
        providerID = provider
        providerName = provider.isEmpty ? "Model" : provider.capitalized
        displayName = parts.count == 2 ? parts[1] : id
    }
}
