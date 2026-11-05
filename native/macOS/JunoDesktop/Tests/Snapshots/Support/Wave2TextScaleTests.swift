import Testing

@testable import JunoDesktop

/// The snapshot matrix's .xxl must be the text size the app ships, not a
/// copy that drifts: Wave2SnapshotVariant.xxlTextScale is 1.25 (spec §3.5,
/// 20px over 16px) and DesktopTextSize.xxl is what the Settings row applies.
struct Wave2TextScaleTests {
    @Test func xxlMatchesTheAppsTextSize() {
        #expect(Wave2SnapshotVariant.xxlTextScale == DesktopTextSize.xxl.scale)
    }
}
