import Foundation

// How far Juno Code works on its own before it hands the run back: the stop
// check's level and bounds, the soft step limit, run and goal budgets and the
// check-in cadence (CODE_AGENT_SPEC §1.6, D-018).
//
// Nothing here widens a permission. These settings decide whether the agent
// keeps *working* inside what the reader's rules already allow; every action it
// takes still goes through `PermissionCoordinator`.

/// When the runtime reviews the agent's own diff before a run may end.
public enum ReviewPolicy: String, Codable, CaseIterable, Sendable {
    /// Never.
    case off
    /// The agent reads its diff with `git_diff`; no reviewer sub-agent.
    case diff
    /// The reviewer sub-agent runs over the threshold, the diff read below it.
    case auto
    /// The reviewer sub-agent runs whenever files changed.
    case always
}

/// Which surfaces the runtime asks to see after a UI change (§4.6).
public struct AutoVerify: Hashable, Codable, Sendable {
    public var web: Bool
    public var mac: Bool
    public var ios: Bool

    public init(web: Bool = true, mac: Bool = false, ios: Bool = false) {
        self.web = web
        self.mac = mac
        self.ios = ios
    }

    public func isOn(for surface: UIVerificationSurface) -> Bool {
        switch surface {
        case .web: web
        case .mac: mac
        case .ios: ios
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let standard = AutoVerify()
        web = (try? container.decodeIfPresent(Bool.self, forKey: .web)) ?? standard.web
        mac = (try? container.decodeIfPresent(Bool.self, forKey: .mac)) ?? standard.mac
        ios = (try? container.decodeIfPresent(Bool.self, forKey: .ios)) ?? standard.ios
    }

    private enum CodingKeys: String, CodingKey {
        case web, mac, ios
    }
}

/// The autonomy a session runs with, every default filled in.
public struct AutonomySettings: Hashable, Codable, Sendable {
    /// `off` reports and never enforces (the behaviour before the stop
    /// check); `standard` sends the agent back while work is unfinished or
    /// unchecked. Goal mode adds the judge on top of either.
    public enum Level: String, Codable, CaseIterable, Sendable {
        case off
        case standard
    }

    public var level: Level
    /// Stop-check continuations one run may have without a goal. With a goal,
    /// the goal's budget governs instead.
    public var maxAutoContinues: Int
    /// Whether the runtime runs recipe checks itself, and only checks every
    /// command of which the reader's rules or task grants already allow.
    public var runChecksAutomatically: Bool
    public var reviewBeforeFinish: ReviewPolicy
    /// `auto` runs the reviewer above this many changed lines, or on 3+ files.
    public var reviewThresholdLines: Int
    /// Model steps before a tools-off wrap-up turn ends the run as
    /// `stepLimit`. Soft: Keep going grants another block.
    public var stepLimit: Int
    /// Per run without a goal.
    public var runBudget: Budget
    /// The default budget a new goal starts with.
    public var goalBudget: Budget
    /// How long background work may keep a goal waiting before a check-in.
    public var checkInMinutes: Int
    public var autoVerify: AutoVerify
    /// Resume goals that Juno quit in the middle of when it next opens. Off by
    /// default (D-025): the reader presses Resume.
    public var resumeInterruptedGoalsOnLaunch: Bool

    public init(
        level: Level = .standard,
        maxAutoContinues: Int = 3,
        runChecksAutomatically: Bool = true,
        reviewBeforeFinish: ReviewPolicy = .auto,
        reviewThresholdLines: Int = 40,
        stepLimit: Int = 200,
        runBudget: Budget = Budget(minutes: 60),
        goalBudget: Budget = Budget(minutes: 240, turns: 60, costUSD: 20),
        checkInMinutes: Int = 30,
        autoVerify: AutoVerify = AutoVerify(),
        resumeInterruptedGoalsOnLaunch: Bool = false
    ) {
        self.level = level
        self.maxAutoContinues = Self.clamped(maxAutoContinues, Self.maxAutoContinuesRange)
        self.runChecksAutomatically = runChecksAutomatically
        self.reviewBeforeFinish = reviewBeforeFinish
        self.reviewThresholdLines = Self.clamped(reviewThresholdLines, Self.reviewThresholdRange)
        self.stepLimit = Self.clamped(stepLimit, Self.stepLimitRange)
        self.runBudget = Self.sanitized(runBudget)
        self.goalBudget = Self.sanitized(goalBudget)
        self.checkInMinutes = Self.clamped(checkInMinutes, Self.checkInRange)
        self.autoVerify = autoVerify
        self.resumeInterruptedGoalsOnLaunch = resumeInterruptedGoalsOnLaunch
    }

    /// The defaults in §1.6: on, three continuations, review over 40 lines,
    /// 200 steps, an hour per run and four hours, 60 turns and $20 per goal.
    public static let standard = AutonomySettings()

    public static let maxAutoContinuesRange = 0...12
    public static let stepLimitRange = 10...1_000
    public static let reviewThresholdRange = 1...100_000
    public static let checkInRange = 5...1_440

    /// Whether the stop check enforces anything at all.
    public var enforces: Bool { level == .standard }

    public init(from decoder: Decoder) throws {
        let overrides = try Overrides(from: decoder)
        var settings = AutonomySettings.standard
        settings.apply(overrides, mayLoosen: true)
        self = settings
    }

    public func encode(to encoder: Encoder) throws {
        try Overrides(self).encode(to: encoder)
    }

    // MARK: - Layering

    /// What one settings file says about autonomy. Every field is optional,
    /// so a file says only what it means to change; a budget a file sets
    /// replaces the whole budget, and a ceiling it leaves out is unlimited.
    public struct Overrides: Hashable, Codable, Sendable {
        public var level: Level?
        public var maxAutoContinues: Int?
        public var runChecksAutomatically: Bool?
        public var reviewBeforeFinish: ReviewPolicy?
        public var reviewThresholdLines: Int?
        public var stepLimit: Int?
        public var runBudget: Budget?
        public var goalBudget: Budget?
        public var checkInMinutes: Int?
        public var autoVerify: AutoVerify?
        public var resumeInterruptedGoalsOnLaunch: Bool?

        public init(
            level: Level? = nil,
            maxAutoContinues: Int? = nil,
            runChecksAutomatically: Bool? = nil,
            reviewBeforeFinish: ReviewPolicy? = nil,
            reviewThresholdLines: Int? = nil,
            stepLimit: Int? = nil,
            runBudget: Budget? = nil,
            goalBudget: Budget? = nil,
            checkInMinutes: Int? = nil,
            autoVerify: AutoVerify? = nil,
            resumeInterruptedGoalsOnLaunch: Bool? = nil
        ) {
            self.level = level
            self.maxAutoContinues = maxAutoContinues
            self.runChecksAutomatically = runChecksAutomatically
            self.reviewBeforeFinish = reviewBeforeFinish
            self.reviewThresholdLines = reviewThresholdLines
            self.stepLimit = stepLimit
            self.runBudget = runBudget
            self.goalBudget = goalBudget
            self.checkInMinutes = checkInMinutes
            self.autoVerify = autoVerify
            self.resumeInterruptedGoalsOnLaunch = resumeInterruptedGoalsOnLaunch
        }

        /// Every value of `settings`, written out.
        public init(_ settings: AutonomySettings) {
            self.init(
                level: settings.level,
                maxAutoContinues: settings.maxAutoContinues,
                runChecksAutomatically: settings.runChecksAutomatically,
                reviewBeforeFinish: settings.reviewBeforeFinish,
                reviewThresholdLines: settings.reviewThresholdLines,
                stepLimit: settings.stepLimit,
                runBudget: settings.runBudget,
                goalBudget: settings.goalBudget,
                checkInMinutes: settings.checkInMinutes,
                autoVerify: settings.autoVerify,
                resumeInterruptedGoalsOnLaunch: settings.resumeInterruptedGoalsOnLaunch
            )
        }

        /// Unknown or malformed values are ignored one by one, so a typo in
        /// one key never empties the rest of the file's autonomy section.
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            level = try? container.decodeIfPresent(Level.self, forKey: .level)
            maxAutoContinues = try? container.decodeIfPresent(Int.self, forKey: .maxAutoContinues)
            runChecksAutomatically = try? container.decodeIfPresent(Bool.self, forKey: .runChecksAutomatically)
            reviewBeforeFinish = try? container.decodeIfPresent(ReviewPolicy.self, forKey: .reviewBeforeFinish)
            reviewThresholdLines = try? container.decodeIfPresent(Int.self, forKey: .reviewThresholdLines)
            stepLimit = try? container.decodeIfPresent(Int.self, forKey: .stepLimit)
            runBudget = try? container.decodeIfPresent(Budget.self, forKey: .runBudget)
            goalBudget = try? container.decodeIfPresent(Budget.self, forKey: .goalBudget)
            checkInMinutes = try? container.decodeIfPresent(Int.self, forKey: .checkInMinutes)
            autoVerify = try? container.decodeIfPresent(AutoVerify.self, forKey: .autoVerify)
            resumeInterruptedGoalsOnLaunch = try? container.decodeIfPresent(
                Bool.self,
                forKey: .resumeInterruptedGoalsOnLaunch
            )
        }

        private enum CodingKeys: String, CodingKey {
            case level, maxAutoContinues, runChecksAutomatically, reviewBeforeFinish
            case reviewThresholdLines, stepLimit, runBudget, goalBudget, checkInMinutes
            case autoVerify, resumeInterruptedGoalsOnLaunch
        }

        /// Whether applying these to the defaults asks for more than a file
        /// that may only narrow is allowed: more continuations, steps or
        /// budget, more surfaces checked, or resuming on launch.
        public var raisesAnything: Bool {
            var narrowed = AutonomySettings.standard
            narrowed.apply(self, mayLoosen: false)
            var applied = AutonomySettings.standard
            applied.apply(self, mayLoosen: true)
            return narrowed != applied
        }
    }

    /// Applies one file's overrides.
    ///
    /// - Parameter mayLoosen: false for a project file the reader has not
    ///   approved. Such a file may lower what a run may spend — fewer
    ///   continuations and steps, smaller budgets, fewer surfaces, no
    ///   automatic checks — but never raise it: a cloned repository must not
    ///   be able to make the agent work for longer on the reader's account.
    ///   The level and the review policy are quality knobs that spend no more
    ///   than the bounds allow, and any file may set them.
    public mutating func apply(_ overrides: Overrides, mayLoosen: Bool) {
        if let value = overrides.level { level = value }
        if let value = overrides.reviewBeforeFinish { reviewBeforeFinish = value }
        if let value = overrides.reviewThresholdLines {
            reviewThresholdLines = Self.clamped(value, Self.reviewThresholdRange)
        }
        if let value = overrides.maxAutoContinues {
            let clamped = Self.clamped(value, Self.maxAutoContinuesRange)
            maxAutoContinues = mayLoosen ? clamped : min(maxAutoContinues, clamped)
        }
        if let value = overrides.stepLimit {
            let clamped = Self.clamped(value, Self.stepLimitRange)
            stepLimit = mayLoosen ? clamped : min(stepLimit, clamped)
        }
        if let value = overrides.runChecksAutomatically, mayLoosen || !value {
            runChecksAutomatically = value
        }
        if let value = overrides.runBudget {
            let sanitized = Self.sanitized(value)
            runBudget = mayLoosen ? sanitized : runBudget.narrowed(by: sanitized)
        }
        if let value = overrides.goalBudget {
            let sanitized = Self.sanitized(value)
            goalBudget = mayLoosen ? sanitized : goalBudget.narrowed(by: sanitized)
        }
        if let value = overrides.checkInMinutes {
            let clamped = Self.clamped(value, Self.checkInRange)
            // A shorter interval is more check-in turns.
            checkInMinutes = mayLoosen ? clamped : max(checkInMinutes, clamped)
        }
        if let value = overrides.autoVerify {
            autoVerify = mayLoosen
                ? value
                : AutoVerify(
                    web: autoVerify.web && value.web,
                    mac: autoVerify.mac && value.mac,
                    ios: autoVerify.ios && value.ios
                )
        }
        if let value = overrides.resumeInterruptedGoalsOnLaunch, mayLoosen || !value {
            resumeInterruptedGoalsOnLaunch = value
        }
    }

    private static func clamped(_ value: Int, _ range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }

    /// A budget with every ceiling at least meaningful: a zero-minute budget
    /// would end every run before its first step.
    static func sanitized(_ budget: Budget) -> Budget {
        Budget(
            minutes: budget.minutes.map { max($0, 1) },
            turns: budget.turns.map { max($0, 1) },
            tokens: budget.tokens.map { max($0, 1_000) },
            costUSD: budget.costUSD.map { max($0, 0.01) }
        )
    }
}

public extension Budget {
    /// Each ceiling the lower of the two, a missing one counting as unlimited.
    func narrowed(by other: Budget) -> Budget {
        func lower<T: Comparable>(_ lhs: T?, _ rhs: T?) -> T? {
            switch (lhs, rhs) {
            case let (left?, right?): min(left, right)
            case let (left?, nil): left
            case let (nil, right?): right
            case (nil, nil): nil
            }
        }
        return Budget(
            minutes: lower(minutes, other.minutes),
            turns: lower(turns, other.turns),
            tokens: lower(tokens, other.tokens),
            costUSD: lower(costUSD, other.costUSD)
        )
    }

    /// The same ceilings raised by `other`: what Keep going grants. An
    /// unlimited ceiling stays unlimited.
    func adding(_ other: Budget) -> Budget {
        Budget(
            minutes: minutes.map { $0 + (other.minutes ?? 0) },
            turns: turns.map { $0 + (other.turns ?? 0) },
            tokens: tokens.map { $0 + (other.tokens ?? 0) },
            costUSD: costUSD.map { $0 + (other.costUSD ?? 0) }
        )
    }

    /// "60 minutes", "60 minutes, 40 turns and $20". Nil when unlimited.
    var sentence: String? {
        var parts: [String] = []
        if let minutes { parts.append("\(minutes) minute\(minutes == 1 ? "" : "s")") }
        if let turns { parts.append("\(turns) turn\(turns == 1 ? "" : "s")") }
        if let tokens { parts.append("\(tokens.formatted()) tokens") }
        if let costUSD { parts.append(Self.dollars(costUSD)) }
        guard let last = parts.popLast() else { return nil }
        return parts.isEmpty ? last : parts.joined(separator: ", ") + " and " + last
    }

    /// "$20", "$1.12".
    static func dollars(_ amount: Double) -> String {
        amount.rounded() == amount && amount >= 1
            ? "$\(Int(amount))"
            : String(format: "$%.2f", amount)
    }
}
