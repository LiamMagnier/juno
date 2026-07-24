import JunoDesignSystem
import Photos
import SwiftUI
import UniformTypeIdentifiers

/// The photo step: a grid of your most recent shots, rising over the chat, with
/// **All Photos** to hand off to the full system picker.
///
/// **Why not just the system picker.** `PHPickerViewController` is a whole
/// modal for what is usually one tap on a photo taken minutes ago — you open it,
/// wait for the library, scroll to the top, tap, tap Add. The recents grid puts
/// the common case one tap away and keeps the full library one tap behind it,
/// which is the shape the reference this follows uses.
///
/// **The cost, stated plainly.** Reading recents needs photo-library
/// authorization; the system picker needs none, because the system hands over
/// only what was chosen. So the grid asks, and every refusal has somewhere to
/// go: denied, restricted and limited-selection all still offer All Photos,
/// which works regardless. Nothing here is a dead end.
struct JunoMobilePhotoTray: View {
    let selectionLimit: Int
    let onPick: ([JunoPickedFile]) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var glass
    @State private var library = JunoPhotoLibrary()
    @State private var showingFullPicker = false
    @State private var loadingAssetID: String?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 3)

    /// Just over half the screen: enough for three rows of recents, and low
    /// enough that the conversation above stays legible.
    private var trayHeight: CGFloat { UIScreen.main.bounds.height * 0.56 }

    var body: some View {
        // A bottom card inside a clear cover rather than a `.sheet`. The button
        // that presents this already owns one presentation for the panel and
        // one for the camera and files; adding a third sheet modifier is how
        // presentations start getting dropped. Drawn this way it is one
        // presentation, and it still reads as a tray rising over the chat —
        // which is the point, because the conversation stays visible above it.
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.18)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { dismiss() }
                .accessibilityLabel("attachments.photos.close")
                .accessibilityAddTraits(.isButton)

            JunoGlass(spacing: 16) {
                VStack(spacing: 0) {
                    grabber
                    content
                    allPhotosButton
                }
                .frame(height: trayHeight)
                .frame(maxWidth: .infinity)
                .junoGlass(
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: 28, topTrailingRadius: 28, style: .continuous
                    )
                )
                .junoGlassID("juno.photo-tray", in: glass)
            }
            .transition(.move(edge: .bottom))
        }
        .ignoresSafeArea(edges: .bottom)
        .task { await library.load(limit: 60) }
        .fullScreenCover(isPresented: $showingFullPicker) {
            JunoMobilePhotoPicker(selectionLimit: selectionLimit) { files in
                onPick(files)
                dismiss()
            }
            .ignoresSafeArea()
        }
        .accessibilityIdentifier("juno.mobile.photo-tray")
    }

    private var grabber: some View {
        Capsule()
            .fill(Color.primary.opacity(0.22))
            .frame(width: 38, height: 5)
            .padding(.top, 8)
            .padding(.bottom, 10)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var content: some View {
        switch library.state {
        case .loading:
            // No spinner: the fetch is a local database read and lands in
            // milliseconds. A spinner here would flash and be gone.
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready(let assets) where assets.isEmpty:
            message("attachments.photos.empty")
        case .ready(let assets):
            grid(assets)
        case .denied:
            message("attachments.photos.denied")
        case .restricted:
            message("attachments.photos.restricted")
        }
    }

    private func message(_ key: LocalizedStringKey) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text(key)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func grid(_ assets: [JunoPhotoAsset]) -> some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(assets) { asset in
                    JunoPhotoCell(
                        asset: asset,
                        library: library,
                        isLoading: loadingAssetID == asset.id,
                        action: { pick(asset) }
                    )
                }
            }
            .padding(.horizontal, 3)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
    }

    private var allPhotosButton: some View {
        Button {
            showingFullPicker = true
        } label: {
            Text("attachments.photos.all")
                .font(.system(size: 17, weight: .semibold))
                .padding(.horizontal, 12)
                .frame(height: 22)
        }
        // The system's own glass button, not a hand-rolled capsule: it gets the
        // press flex, the light scatter and the shape for free, and it stays
        // right when the platform changes them.
        .modifier(JunoGlassButtonStyle())
        .padding(.top, 10)
        .padding(.bottom, 22)
        .accessibilityIdentifier("juno.mobile.photo-tray-all")
    }

    private func pick(_ asset: JunoPhotoAsset) {
        guard loadingAssetID == nil else { return }
        loadingAssetID = asset.id
        Task {
            let file = await library.file(for: asset)
            loadingAssetID = nil
            guard let file else { return }
            onPick([file])
            dismiss()
        }
    }
}

/// One photo in the grid. The thumbnail is requested per cell and cancelled when
/// the cell scrolls away, so a 60-photo grid never holds 60 full images.
private struct JunoPhotoCell: View {
    let asset: JunoPhotoAsset
    let library: JunoPhotoLibrary
    let isLoading: Bool
    let action: () -> Void

    @State private var thumbnail: Image?

    var body: some View {
        Button(action: action) {
            ZStack {
                Rectangle().fill(Color.primary.opacity(0.06))
                if let thumbnail {
                    thumbnail
                        .resizable()
                        .scaledToFill()
                }
                if isLoading {
                    Rectangle().fill(.black.opacity(0.35))
                    ProgressView().tint(.white)
                }
            }
            .aspectRatio(1, contentMode: .fill)
            .clipped()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("attachments.photos.item")
        .task { thumbnail = await library.thumbnail(for: asset, size: 240) }
    }
}

/// A photo in the library, identified by its local id.
struct JunoPhotoAsset: Identifiable, Equatable {
    let id: String
    let asset: PHAsset

    static func == (lhs: JunoPhotoAsset, rhs: JunoPhotoAsset) -> Bool { lhs.id == rhs.id }
}

/// Reads the photo library: authorization, the recents fetch, thumbnails, and
/// the full-size bytes for the one photo that gets chosen.
@MainActor
@Observable
final class JunoPhotoLibrary {
    enum State: Equatable {
        case loading
        case ready([JunoPhotoAsset])
        case denied
        case restricted
    }

    private(set) var state: State = .loading
    private let imageManager = PHCachingImageManager()

    /// Requests *read* access only. `.readWrite` would ask for permission to
    /// modify the library, which this never does.
    func load(limit: Int) async {
        let status = await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { continuation.resume(returning: $0) }
        }
        switch status {
        case .authorized, .limited:
            state = .ready(fetchRecents(limit: limit))
        case .denied:
            state = .denied
        case .restricted:
            state = .restricted
        case .notDetermined:
            state = .denied
        @unknown default:
            state = .denied
        }
    }

    private func fetchRecents(limit: Int) -> [JunoPhotoAsset] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = limit
        options.predicate = NSPredicate(
            format: "mediaType == %d", PHAssetMediaType.image.rawValue
        )
        let result = PHAsset.fetchAssets(with: options)
        var assets: [JunoPhotoAsset] = []
        result.enumerateObjects { asset, _, _ in
            assets.append(JunoPhotoAsset(id: asset.localIdentifier, asset: asset))
        }
        return assets
    }

    func thumbnail(for asset: JunoPhotoAsset, size: CGFloat) async -> Image? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let target = CGSize(width: size, height: size)
        let image: UIImage? = await withCheckedContinuation { continuation in
            var resumed = false
            imageManager.requestImage(
                for: asset.asset, targetSize: target, contentMode: .aspectFill, options: options
            ) { image, info in
                // `.opportunistic` calls back twice — a fast degraded image then
                // the real one. The continuation may only be resumed once, so the
                // degraded pass is ignored unless it is also the last.
                let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                guard !resumed, !degraded || image == nil else { return }
                resumed = true
                continuation.resume(returning: image)
            }
        }
        return image.map(Image.init(uiImage:))
    }

    /// The chosen photo's original bytes, ready for the composer.
    func file(for asset: JunoPhotoAsset) async -> JunoPickedFile? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        let result: (Data, String)? = await withCheckedContinuation { continuation in
            imageManager.requestImageDataAndOrientation(
                for: asset.asset, options: options
            ) { data, identifier, _, _ in
                guard let data else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: (data, identifier ?? "public.jpeg"))
            }
        }
        guard let (data, identifier) = result else { return nil }
        let type = UTType(identifier) ?? .jpeg
        return JunoPickedFile(
            data: data,
            fileName: "photo-\(UUID().uuidString.prefix(8)).\(type.preferredFilenameExtension ?? "jpg")",
            // HEIC arrives here on any recent iPhone; the attachment model
            // transcodes it before upload, so the server never has to decode it.
            mimeType: type.preferredMIMEType ?? "image/jpeg",
            isImage: true
        )
    }
}
