import Foundation

/// The product's name in every sentence screen control says: the caption
/// under the menu bar, the floor sentences on approval cards, the grant
/// sheet's title, and the refusals the model relays to the reader.
///
/// The Swift twin of the web's `PRODUCT_NAME`. The repository's codename is
/// never shown to people; `BrandStringTests` fails when it reappears in a
/// string literal in this module or in Work's automation module. Bundle ids,
/// notification identifiers and file names keep their lowercase prefix: they
/// are identifiers, not words anyone reads.
public enum ScreenControlBrand {
    /// "Alevr".
    public static let productName = "Alevr"
}
