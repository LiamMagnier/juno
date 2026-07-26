import Foundation
import Testing
@testable import JunoDesktop

/// The Usage screen's arithmetic.
///
/// The contribution grid is the kind of code that is only ever "verified" by
/// looking at it and deciding it seems plausible — but a grid that drops quiet
/// days, or starts a column on the wrong weekday, is wrong in a way that still
/// looks like a calendar. These assert the two things a reader cannot check by
/// eye: that every day in the window gets exactly one cell, and that the cells
/// land on the weekday the date actually falls on.
struct DesktopUsageActivityGridTests {
    private static let dayMs = 86_400_000.0

    /// 1 Jan 2026 is a Thursday; 4 Jan 2026 is a Sunday.
    private static let thursday1Jan2026 = Date(
        timeIntervalSince1970: 1_767_225_600
    ).timeIntervalSince1970 * 1000

    // MARK: - Coverage

    @Test
    func everyDayInTheWindowGetsExactlyOneCell() {
        let start = Self.thursday1Jan2026
        let cells = DesktopUsageActivityCell.grid(
            startMs: start,
            endMs: start + 29 * Self.dayMs,
            days: []
        )
        let real = cells.filter { !$0.isPadding }
        #expect(real.count == 30)
        #expect(Set(real.map(\.dayMs)).count == 30)
    }

    /// The server only sends days that had activity. A grid that simply laid the
    /// returned rows out side by side would compress a fortnight of silence into
    /// nothing and shift every later cell onto the wrong weekday.
    @Test
    func quietDaysAreFilledInBetweenActiveOnes() {
        let start = Self.thursday1Jan2026
        let cells = DesktopUsageActivityCell.grid(
            startMs: start,
            endMs: start + 9 * Self.dayMs,
            days: [
                DesktopUsageDay(dayMs: start, requests: 4, totalTokens: 400),
                DesktopUsageDay(dayMs: start + 9 * Self.dayMs, requests: 7, totalTokens: 700),
            ]
        )
        let real = cells.filter { !$0.isPadding }
        #expect(real.count == 10)
        #expect(real.first?.requests == 4)
        #expect(real.last?.requests == 7)
        #expect(real.dropFirst().dropLast().allSatisfy { $0.requests == 0 })
    }

    // MARK: - Weekday alignment

    /// Columns are Sunday-first, so the number of leading pad cells is exactly
    /// the start date's weekday index. 1 Jan 2026 is a Thursday → 4 pads.
    @Test
    func theGridPadsToTheFirstSunday() {
        let cells = DesktopUsageActivityCell.grid(
            startMs: Self.thursday1Jan2026,
            endMs: Self.thursday1Jan2026 + 6 * Self.dayMs,
            days: []
        )
        #expect(cells.prefix(while: \.isPadding).count == 4)
        #expect(cells.count % 7 == 0 || cells.count == 11)
    }

    @Test
    func aWindowStartingOnASundayNeedsNoPadding() {
        // 4 Jan 2026, a Sunday.
        let sunday = Self.thursday1Jan2026 + 3 * Self.dayMs
        let cells = DesktopUsageActivityCell.grid(
            startMs: sunday,
            endMs: sunday + 6 * Self.dayMs,
            days: []
        )
        #expect(cells.allSatisfy { !$0.isPadding })
        #expect(cells.count == 7)
    }

    // MARK: - Guards

    @Test
    func anInvertedOrEmptyRangeProducesNoCells() {
        #expect(DesktopUsageActivityCell.grid(startMs: 0, endMs: 0, days: []).isEmpty)
        #expect(
            DesktopUsageActivityCell.grid(
                startMs: Self.thursday1Jan2026,
                endMs: Self.thursday1Jan2026 - Self.dayMs,
                days: []
            ).isEmpty
        )
    }

    /// A malformed range must not be allowed to allocate an unbounded grid.
    @Test
    func anAbsurdlyLongRangeIsRefusedRatherThanAllocated() {
        #expect(
            DesktopUsageActivityCell.grid(
                startMs: Self.thursday1Jan2026,
                endMs: Self.thursday1Jan2026 + 5_000 * Self.dayMs,
                days: []
            ).isEmpty
        )
    }

    // MARK: - Levels

    @Test
    func aDayWithNoRequestsIsAlwaysLevelZero() {
        #expect(DesktopUsageActivityCell.level(for: 0, thresholds: (1, 2, 3)) == 0)
    }

    @Test
    func busierDaysRankHigherThanQuietOnes() {
        let thresholds = DesktopUsageActivityCell.quartiles(of: [1, 2, 4, 8, 16, 32])
        let quiet = DesktopUsageActivityCell.level(for: 1, thresholds: thresholds)
        let busy = DesktopUsageActivityCell.level(for: 32, thresholds: thresholds)
        #expect(quiet >= 1)
        #expect(busy == 4)
        #expect(busy > quiet)
    }

    /// An account with one active day still has to render that day as active
    /// rather than as an empty cell.
    @Test
    func aSingleActiveDayStillReadsAsActive() {
        let thresholds = DesktopUsageActivityCell.quartiles(of: [5])
        #expect(DesktopUsageActivityCell.level(for: 5, thresholds: thresholds) >= 1)
    }
}

struct DesktopUsageFormatTests {
    /// Pinned so the decimal separator does not depend on the machine's region.
    private static let en = Locale(identifier: "en_US")

    /// Three significant figures at every magnitude, which is what keeps the
    /// headline from changing width as the account grows.
    @Test
    func tokensAreAbbreviatedToThreeSignificantFigures() {
        #expect(DesktopUsageFormat.tokens(2_600_000_000, locale: Self.en) == "2.60B")
        #expect(DesktopUsageFormat.tokens(174_540_000, locale: Self.en) == "175M")
        #expect(DesktopUsageFormat.tokens(52_710, locale: Self.en) == "52.7K")
    }

    /// Below a thousand the exact number is the useful one — abbreviating it
    /// would turn "412 tokens" into "0.41K".
    @Test
    func smallCountsAreLeftExact() {
        #expect(DesktopUsageFormat.tokens(412, locale: Self.en) == "412")
        #expect(DesktopUsageFormat.tokens(0, locale: Self.en) == "0")
    }

    /// The reader's region decides the separator; this is the reason the
    /// parameter exists at all.
    @Test
    func theSeparatorFollowsTheLocale() {
        #expect(
            DesktopUsageFormat.tokens(2_600_000_000, locale: Locale(identifier: "fr_FR")) == "2,60B"
        )
    }
}

struct DesktopUsageSurfaceTests {
    /// A `kind` this build does not know about must still appear: it
    /// contributed to the totals shown above it.
    @Test
    func anUnknownSurfaceKeepsItsOwnName() {
        let surface = DesktopUsageSurfaceTotals(
            surface: "embedding",
            requests: 3,
            totalTokens: 30,
            costMicroUsd: 1
        )
        #expect(surface.displayName == "Embedding")
    }

    @Test
    func theKnownSurfacesUseTheProductsOwnNames() {
        func name(_ kind: String) -> String {
            DesktopUsageSurfaceTotals(surface: kind, requests: 1, totalTokens: 1, costMicroUsd: 1)
                .displayName
        }
        #expect(name("chat") == "Chat")
        #expect(name("code") == "Code")
        #expect(name("task") == "Tasks")
    }
}

struct DesktopUsageModelIdentityTests {
    /// A model that has since been retired from the account manifest still has
    /// real spend against it, so it renders as itself rather than disappearing.
    @Test
    func anUnknownModelFallsBackToItsIdentifier() {
        let identity = DesktopUsageModelIdentity(id: "anthropic:claude-opus-3", catalog: [])
        #expect(identity.providerID == "anthropic")
        #expect(identity.displayName == "claude-opus-3")
    }

    @Test
    func anIdentifierWithNoProviderPrefixIsShownWhole() {
        let identity = DesktopUsageModelIdentity(id: "mystery-model", catalog: [])
        #expect(identity.displayName == "mystery-model")
        #expect(identity.providerID.isEmpty)
    }
}
