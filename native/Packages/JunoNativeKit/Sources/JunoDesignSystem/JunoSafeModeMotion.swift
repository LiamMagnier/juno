import SwiftUI

public extension View {
    /// Safe mode's "custom motion off" (docs/rea/designs/reliability-and-native.md
    /// §3.3): while `reduced` is true, everything below reads Reduce Motion as
    /// on, so every animation already written against it takes its reduced
    /// variant — the travel tier cross-fades, ambient loops stop. Nothing new
    /// to honour at each call site.
    ///
    /// Always applied, never `if`-wrapped, so turning safe mode off in place
    /// does not rebuild the view tree under it.
    func junoSafeModeMotion(reduced: Bool) -> some View {
        transformEnvironment(\._accessibilityReduceMotion) { reduceMotion in
            reduceMotion = reduceMotion || reduced
        }
    }
}
