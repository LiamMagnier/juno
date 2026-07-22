import SwiftUI
import JunoDesignSystem

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

/// Juno Code's semantic colour roles.
///
/// Every value here now **derives from `JunoDesignSystem`** rather than
/// restating it. Code previously carried its own graphite palette, its own
/// 7/10/14 radius scale and its own 2/4/8/12/16 spacing scale, all a few points
/// off Chat's. Two products in one window cannot each have their own idea of
/// what a card looks like, so the private scales are gone and the colours are
/// aliases. New code should reach for `JunoSpace`, `JunoRadius` and the shared
/// `Color.juno…` tokens directly; this type remains for the roles that are
/// genuinely Code-specific.
public enum JunoCodeTheme {
    // MARK: - Accent

    /// Juno coral, from the shared brand token.
    public static let accent = Color.junoAccent

    // MARK: - Surfaces

    /// Window background: the shared reading canvas.
    public static let background = Color.junoCanvasWarm

    /// Raised panels (inspector cards, transcript cards).
    public static let surface = Color.junoRaised

    /// Inset wells for machine output (terminal, diff).
    public static let well = Color.junoTerminal

    /// Hairline separators; used sparingly.
    public static let separator = Color.junoSeparator

    // MARK: - Status

    public static let success = Color.junoSuccess
    public static let failure = Color.junoDanger
    public static let caution = Color.junoCaution

    // MARK: - Diff

    public static let diffAddedBackground = Color.junoDiffAdded
    public static let diffRemovedBackground = Color.junoDiffRemoved

    // MARK: - Scale bridges

    /// Bridges onto `JunoSpace`. Kept so the surfaces not yet migrated keep
    /// compiling; the values are the shared ones, not Code's old ones.
    public enum Spacing {
        public static let hairline = JunoSpace.hairline
        public static let tight = JunoSpace.hairline
        public static let compact = JunoSpace.snug
        public static let control = JunoSpace.cozy
        public static let content = JunoSpace.regular
        public static let section = JunoSpace.section
        public static let spacious = JunoSpace.region
    }

    /// Bridges onto `JunoRadius`.
    public enum Radius {
        public static let control = JunoRadius.control
        public static let card = JunoRadius.row
        public static let panel = JunoRadius.panel
    }
}

public extension Font {
    /// Deprecated spelling of ``Font/junoCode``; kept so unmigrated call sites
    /// still resolve to the shared monospaced scale.
    static let junoMono = Font.junoCode
    /// Deprecated spelling of ``Font/junoCodeSmall``.
    static let junoMonoSmall = Font.junoCodeSmall
}
