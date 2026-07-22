import SwiftUI

/// Display helpers for workspace-relative paths.
///
/// Middle-truncating a whole path is the worst of both worlds: on a path like
/// `native/Packages/.../MutationOutboxDrainerConfiguration.swift` it eats the
/// filename and leaves `native/Packages/…figuration.swift`, which identifies
/// nothing. Split instead, so the filename is always readable and only the
/// directory is allowed to truncate.
enum PathDisplay {
    static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The parent directory, or `nil` for a file at the workspace root.
    static func directory(_ path: String) -> String? {
        let components = path.split(separator: "/")
        guard components.count > 1 else { return nil }
        return components.dropLast().joined(separator: "/")
    }

    /// "3 files" / "1 file".
    static func fileCount(_ count: Int) -> String {
        count == 1 ? "1 file" : "\(count) files"
    }
}

/// Juno Code visual language: deep graphite surfaces in dark mode, near-white
/// in light mode, SF Pro type, and the Juno terracotta accent used sparingly
/// for primary actions and running state only.
public enum JunoCodeTheme {
    // MARK: - Accent

    /// Juno terracotta, aligned with the shared brand token (0.93, 0.36, 0.27).
    public static let accent = Color(red: 0.93, green: 0.36, blue: 0.27)

    // MARK: - Surfaces

    /// Window background: deep graphite / near-white.
    public static let background = adaptive(
        light: Color(red: 0.985, green: 0.985, blue: 0.98),
        dark: Color(red: 0.115, green: 0.115, blue: 0.125)
    )

    /// Raised panels (inspector, cards).
    public static let surface = adaptive(
        light: Color.white,
        dark: Color(red: 0.155, green: 0.155, blue: 0.17)
    )

    /// Subtle inset wells (terminal, diff background).
    public static let well = adaptive(
        light: Color(red: 0.965, green: 0.965, blue: 0.96),
        dark: Color(red: 0.09, green: 0.09, blue: 0.10)
    )

    /// Hairline separators; used sparingly.
    public static let separator = adaptive(
        light: Color.black.opacity(0.08),
        dark: Color.white.opacity(0.10)
    )

    // MARK: - Status

    public static let success = adaptive(
        light: Color(red: 0.13, green: 0.55, blue: 0.28),
        dark: Color(red: 0.36, green: 0.78, blue: 0.5)
    )
    public static let failure = adaptive(
        light: Color(red: 0.78, green: 0.16, blue: 0.16),
        dark: Color(red: 0.95, green: 0.42, blue: 0.4)
    )
    public static let caution = adaptive(
        light: Color(red: 0.72, green: 0.5, blue: 0.05),
        dark: Color(red: 0.95, green: 0.72, blue: 0.3)
    )

    // MARK: - Diff

    public static let diffAddedBackground = adaptive(
        light: Color(red: 0.87, green: 0.96, blue: 0.88),
        dark: Color(red: 0.12, green: 0.24, blue: 0.15)
    )
    public static let diffRemovedBackground = adaptive(
        light: Color(red: 0.99, green: 0.9, blue: 0.9),
        dark: Color(red: 0.28, green: 0.13, blue: 0.13)
    )

    // MARK: - Spacing grid

    public enum Spacing {
        public static let hairline: CGFloat = 2
        public static let tight: CGFloat = 4
        public static let compact: CGFloat = 8
        public static let control: CGFloat = 12
        public static let content: CGFloat = 16
        public static let section: CGFloat = 24
        public static let spacious: CGFloat = 32
    }

    public enum Radius {
        public static let control: CGFloat = 7
        public static let card: CGFloat = 10
        public static let panel: CGFloat = 14
    }

    // MARK: - Helpers

    private static func adaptive(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(isDark ? dark : light)
        })
    }
}

public extension Font {
    static let junoMono = Font.system(size: 12, design: .monospaced)
    static let junoMonoSmall = Font.system(size: 11, design: .monospaced)
}
