import SwiftUI

/// A small, deliberate type hierarchy built on the system font (SF Pro) and
/// Dynamic Type. Screens use at most a title, a section header and body text so
/// the reading surface stays calm; weights carry the hierarchy, not size jumps.
public extension View {
    /// A screen's primary title.
    func junoScreenTitle() -> some View {
        font(.largeTitle.weight(.bold))
    }

    /// A grouped-section header: quiet, uppercase-free, secondary.
    func junoSectionHeader() -> some View {
        font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    /// A row or card title.
    func junoRowTitle() -> some View {
        font(.body.weight(.medium))
    }

    /// Supporting metadata (timestamps, counts, provenance).
    func junoMetadata() -> some View {
        font(.caption)
            .foregroundStyle(.secondary)
    }
}
