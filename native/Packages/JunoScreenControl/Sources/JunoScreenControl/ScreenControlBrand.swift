import Foundation

/// The product name in every sentence screen control shows a person.
///
/// The repository's codename never reaches a screen. The presence caption,
/// the floor's reasons on an approval card, a grant sheet's title, the lock's
/// sentences and every refusal relayed to a reader say this instead: the
/// Swift twin of the web's `PRODUCT_NAME`.
///
/// Local to this package on purpose. JunoScreenControl depends on nothing
/// else in the repository (see `Package.swift`), so it cannot import the
/// design system's brand; `ScreenControlBrandTests` fails on a user-facing
/// string literal under `Sources` that spells the codename, so a new sentence
/// cannot quietly go back to it.
public enum ScreenControlBrand {
    /// "Alevr".
    public static let productName = "Alevr"
}
