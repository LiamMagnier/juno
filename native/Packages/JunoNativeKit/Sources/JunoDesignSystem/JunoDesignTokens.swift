import SwiftUI

public enum JunoColorTokenError: Error, Equatable, Sendable {
    case componentOutOfRange
}

/// Platform-neutral color components used to keep the brand palette testable.
public struct JunoColorToken: Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let opacity: Double

    public init(red: Double, green: Double, blue: Double, opacity: Double = 1) throws {
        guard [red, green, blue, opacity].allSatisfy({ (0...1).contains($0) }) else {
            throw JunoColorTokenError.componentOutOfRange
        }
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    private init(uncheckedRed red: Double, green: Double, blue: Double, opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

    public static let coral = JunoColorToken(
        uncheckedRed: 0.93,
        green: 0.36,
        blue: 0.27
    )
    public static let warmWhite = JunoColorToken(
        uncheckedRed: 0.98,
        green: 0.97,
        blue: 0.95
    )
    public static let warmBlack = JunoColorToken(
        uncheckedRed: 0.08,
        green: 0.075,
        blue: 0.07
    )
}

public extension Color {
    init(juno token: JunoColorToken) {
        self.init(
            red: token.red,
            green: token.green,
            blue: token.blue,
            opacity: token.opacity
        )
    }
}

public enum JunoSpacing {
    public static let compact: Double = 6
    public static let control: Double = 10
    public static let content: Double = 16
    public static let section: Double = 24
    public static let spacious: Double = 32
}

public enum JunoCornerRadius {
    public static let control: Double = 10
    public static let panel: Double = 16
    public static let floating: Double = 22
}

public struct JunoAccessibilityPreferences: Equatable, Sendable {
    public var reduceMotion: Bool
    public var reduceTransparency: Bool
    public var increaseContrast: Bool

    public init(
        reduceMotion: Bool = false,
        reduceTransparency: Bool = false,
        increaseContrast: Bool = false
    ) {
        self.reduceMotion = reduceMotion
        self.reduceTransparency = reduceTransparency
        self.increaseContrast = increaseContrast
    }

    public func animationDuration(_ proposed: TimeInterval) -> TimeInterval {
        reduceMotion ? 0 : max(0, proposed)
    }

    public var usesOpaqueTransientSurfaces: Bool {
        reduceTransparency
    }
}
