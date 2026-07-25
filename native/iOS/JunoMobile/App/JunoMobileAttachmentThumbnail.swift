import ImageIO
import SwiftUI
import UIKit

/// Decodes image bytes straight to a thumbnail, off the main actor.
///
/// `UIImage(data:)` in a view body is what this replaces. It decodes the *whole*
/// image on whatever thread asks — the main one, while the composer is being
/// drawn — so attaching a 12-megapixel photo dropped frames on the row that
/// exists to say the photo arrived. ImageIO decodes at the size actually needed
/// and never materialises the full bitmap.
enum JunoImageDownsampler {
    /// The composer chip's 30pt square, with headroom for a 3× screen.
    static let chipThumbnailSize: CGFloat = 120
    /// The camera panel's 52pt library button, likewise.
    static let controlThumbnailSize: CGFloat = 180

    static func thumbnail(from data: Data, maxPixelSize: CGFloat) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                // Applies the EXIF rotation, so a portrait photo is not shown
                // on its side in the one place it is shown small.
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ]
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                CGImageSourceGetCount(source) > 0,
                let image = CGImageSourceCreateThumbnailAtIndex(
                    source, 0, options as CFDictionary
                )
            else { return nil }
            return UIImage(cgImage: image)
        }.value
    }
}

/// An attachment's preview image: a downsampled thumbnail, or the document glyph
/// for anything that is not an image.
struct JunoAttachmentThumbnail: View {
    let data: Data?
    var size: CGFloat = 30
    var cornerRadius: CGFloat = 6
    var maxPixelSize: CGFloat = JunoImageDownsampler.chipThumbnailSize

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            } else if data == nil {
                Image(systemName: "doc")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: size, height: size)
            } else {
                // The decode is a few milliseconds; a spinner here would flash
                // and be gone. A placeholder tile keeps the row from reflowing.
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: size, height: size)
            }
        }
        .task(id: data) {
            guard let data else {
                image = nil
                return
            }
            image = await JunoImageDownsampler.thumbnail(from: data, maxPixelSize: maxPixelSize)
        }
    }
}
