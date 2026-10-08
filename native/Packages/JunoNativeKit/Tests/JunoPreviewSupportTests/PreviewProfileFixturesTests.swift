#if DEBUG
import Foundation
import Testing
@testable import JunoChatKit
@testable import JunoPreviewSupport

/// The profile fixtures decode through the real clients' decoders.
@Suite struct PreviewProfileFixturesTests {
    @Test func theYearOfActivityDecodes() throws {
        let activity = try NativeProfileActivity.decode(Data(PreviewProfileFixtures.activityJSON().utf8))
        #expect(activity.days.count > 150)
        #expect(activity.models.count == 6)
        #expect(activity.peakDay?.tokens == 4_200_000)
        let empty = try NativeProfileActivity.decode(Data(PreviewProfileFixtures.emptyActivityJSON().utf8))
        #expect(empty.isEmpty)
    }
}
#endif
