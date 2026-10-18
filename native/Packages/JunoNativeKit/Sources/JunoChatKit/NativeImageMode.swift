import Foundation

/// The composer's "Create image" switch (G04): which picture model it selects,
/// and the chat model it gives back when it is turned off.
///
/// Image mode is not a second send path. Selecting an image model already
/// sends the turn through `/api/generate` and opens the media tray; the switch
/// is a way to get there without knowing which picture model to pick, and a
/// way back to the chat model the reader had.
///
/// A value type, kept by the composer's view state: the last chat model is
/// noted on every selection change (``observe(selectedModelID:catalog:)``), so
/// turning the mode off restores it whether the image model came from the
/// switch or from the model picker.
public struct NativeImageMode: Equatable, Sendable {
    /// The chat model selected before the image model, to restore on exit.
    public private(set) var lastChatModelID: String?

    public init(lastChatModelID: String? = nil) {
        self.lastChatModelID = lastChatModelID
    }

    // MARK: Which models

    /// A picture model the composer may switch to now: published as an image
    /// model, sendable for this account (the server folds the plan, coming
    /// soon and health into `availability`), and neither superseded nor on
    /// its way out.
    public static func isUsableImageModel(_ model: NativeChatModelOption) -> Bool {
        model.modality == "image"
            && model.isAvailable
            && !model.isLegacy
            && model.lifecycle != "deprecated"
    }

    public static func isImageModel(_ model: NativeChatModelOption?) -> Bool {
        model?.modality == "image"
    }

    public static func usableImageModels(in catalog: [NativeChatModelOption]) -> [NativeChatModelOption] {
        catalog.filter(isUsableImageModel)
    }

    /// The picture model "Create image" selects: the one the reader last made
    /// a picture with while it is still usable, else the best by
    /// ``rank(_:)``. Nil when the account has no usable image model, which is
    /// also when the switch is hidden.
    public static func defaultImageModel(
        catalog: [NativeChatModelOption],
        lastUsedID: String?
    ) -> NativeChatModelOption? {
        let usable = usableImageModels(in: catalog)
        if let lastUsedID, let last = usable.first(where: { $0.id == lastUsedID }) { return last }
        return rank(usable).first
    }

    /// Best first, the web's `byScore` for the balanced preference
    /// (`src/lib/router/image-route.ts`): quality − 1.2 × cost tier, then the
    /// newer release, then the id.
    public static func rank(_ models: [NativeChatModelOption]) -> [NativeChatModelOption] {
        models.sorted { lhs, rhs in
            let left = score(lhs)
            let right = score(rhs)
            if left != right { return left > right }
            let leftRelease = lhs.released ?? ""
            let rightRelease = rhs.released ?? ""
            if leftRelease != rightRelease { return leftRelease > rightRelease }
            return lhs.id < rhs.id
        }
    }

    static func score(_ model: NativeChatModelOption) -> Double {
        quality(of: model) - 1.2 * Double(costTier(of: model))
    }

    /// The web's `FAMILY_QUALITY`, read through the model id.
    ///
    /// The native manifest does not publish a model's family, so it is
    /// recognised from the id the families share (`gpt-image-2.5-flare` is
    /// `gpt-image-fast`, `gemini-3-pro-image` is `gemini-image-pro`). Order
    /// matters: the specific spellings are tested before the general ones. A
    /// model none of these name is middling (5.5), as an unlisted family is
    /// on the web.
    public static func quality(of model: NativeChatModelOption) -> Double {
        let id = model.id.lowercased()
        func has(_ fragment: String) -> Bool { id.contains(fragment) }
        if has("gpt-image") {
            if has("mini") { return 5 }
            if has("flare") || has("fast") { return 8 }
            return 9
        }
        if has("pro-image") || has("image-pro") || has("banana-pro") { return 9 }
        if has("lite-image") || has("image-lite") { return 5 }
        if has("nano-banana") || has("flash-image") || has("image-flash") { return 8 }
        if has("imagine-image") {
            if has("imagine-image-2") { return 7 }
            if has("quality") { return 5.5 }
            return 5
        }
        if has("muse-image") { return 6.5 }
        if has("glm-image") { return 6 }
        if has("image-01") { return 6 }
        return 5.5
    }

    /// The model's cost tier, 1–3, from the manifest's price class (which the
    /// server derives from the same `cost` the web ranks by). A model without
    /// pricing is taken as standard.
    public static func costTier(of model: NativeChatModelOption) -> Int {
        switch model.pricing?.priceClass {
        case "economy": 1
        case "premium": 3
        default: 2
        }
    }

    // MARK: Entering and leaving

    /// Notes a selection: a chat model becomes the one to give back.
    public mutating func observe(selectedModelID: String, catalog: [NativeChatModelOption]) {
        guard let model = catalog.first(where: { $0.id == selectedModelID }), model.modality == "chat" else { return }
        lastChatModelID = model.id
    }

    /// Turning the switch on: remembers the current chat model and returns the
    /// picture model to select, or nil when there is none.
    public mutating func enter(
        currentModelID: String,
        catalog: [NativeChatModelOption],
        lastUsedImageModelID: String?
    ) -> String? {
        observe(selectedModelID: currentModelID, catalog: catalog)
        return Self.defaultImageModel(catalog: catalog, lastUsedID: lastUsedImageModelID)?.id
    }

    /// Turning the switch off: the chat model to restore — the one noted, while
    /// it can still be sent to, else the first sendable chat model (Auto leads
    /// the manifest). Nil when the catalogue has none, which leaves the
    /// selection alone.
    public func exit(catalog: [NativeChatModelOption]) -> String? {
        let chat = catalog.filter { $0.modality == "chat" && $0.isAvailable }
        if let lastChatModelID, chat.contains(where: { $0.id == lastChatModelID }) { return lastChatModelID }
        return chat.first?.id
    }
}
