import CoreGraphics
import ImageIO
import JunoCore
import JunoDesignSystem
import JunoSync
import SwiftUI
import UniformTypeIdentifiers

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Region-based image editing — the Swift half of
/// `src/components/chat/image-edit-overlay.tsx`.
///
/// Drag a marquee over the image, describe the change, submit. The mask PNG is
/// rendered on-device at the image's **natural** size — transparent inside the
/// region, opaque black outside, which is the `images.edit` convention every
/// masking provider follows — and the request runs through the same
/// `/api/generate` stream a fresh generation does.
///
/// **Why the region is normalised.** The marquee is drawn in view points, and the
/// mask has to be in image pixels. Carrying the selection as 0…1 fractions is
/// what keeps the visible rectangle, the coordinates on the wire and the mask
/// bitmap agreeing on a Retina Mac, a phone in landscape and a 4096px source.
///
/// **What the model can actually do is not assumed.** `imageEdit` comes from the
/// manifest: a `mask` model gets the bitmap, a `prompt` model gets the region as
/// guidance and is told so on screen, and a model that cannot edit at all does
/// not get a canvas to drag on.
@MainActor
public struct NativeImageEditView: View {
    private let attachmentID: String
    private let fileName: String
    private let accountID: AccountID
    private let attachments: NativeAttachmentAPIClient
    private let models: [NativeChatModelOption]
    private let submit: (NativeMediaGenerationRequest) -> Void
    private let close: () -> Void

    @State private var source: NativeSourceImage?
    @State private var loadFailure: String?
    @State private var region: NativeImageRegion?
    @State private var dragOrigin: CGPoint?
    @State private var instructions = ""
    @State private var modelID: String = ""

    /// A drag under 2% in either dimension reads as a mis-tap and clears the
    /// selection rather than committing a sliver the model would ignore.
    private static let minimumRegion: Double = 0.02

    public init(
        attachmentID: String,
        fileName: String,
        accountID: AccountID,
        attachments: NativeAttachmentAPIClient,
        models: [NativeChatModelOption],
        submit: @escaping (NativeMediaGenerationRequest) -> Void,
        close: @escaping () -> Void
    ) {
        self.attachmentID = attachmentID
        self.fileName = fileName
        self.accountID = accountID
        self.attachments = attachments
        self.models = models
        self.submit = submit
        self.close = close
    }

    /// Image models the account can run that can edit at all.
    private var editors: [NativeChatModelOption] {
        models.filter { $0.modality == "image" && $0.availability == "available"
            && $0.imageEditSupport != .none }
    }

    private var editor: NativeChatModelOption? {
        editors.first { $0.id == modelID } ?? editors.first
    }

    private var support: NativeImageEditSupport { editor?.imageEditSupport ?? .none }

    private var canSubmit: Bool {
        !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && editor != nil
            && (region == nil || source != nil)
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            canvas
            Divider()
            controls
        }
        .frame(minWidth: 380, minHeight: 520)
        .background(Color.junoCanvas)
        .task(id: attachmentID) { await load() }
        .onAppear {
            if modelID.isEmpty { modelID = editors.first?.id ?? "" }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: JunoSpace.cozy) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Image editor")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)
                Text(fileName)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Text(region == nil ? "Whole image" : "Selected area")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.junoMutedForeground)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.junoMutedForeground)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close image editor")
        }
        .padding(.horizontal, JunoSpace.regular)
        .padding(.vertical, JunoSpace.cozy)
    }

    // MARK: - Canvas

    @ViewBuilder
    private var canvas: some View {
        ZStack {
            if let source {
                imageCanvas(source)
            } else if let loadFailure {
                unavailable(loadFailure, symbol: "photo.badge.exclamationmark")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Preparing image")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(JunoSpace.regular)
        .background(Color.junoMuted.opacity(0.35))
    }

    /// The frame adopts the image's exact aspect ratio, which is what makes the
    /// visible pixels, the marquee's coordinates and the generated mask agree.
    private func imageCanvas(_ source: NativeSourceImage) -> some View {
        Image(decorative: source.cgImage, scale: 1)
            .resizable()
            .aspectRatio(source.aspectRatio, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous))
            .overlay {
                GeometryReader { proxy in
                    ZStack {
                        if let region {
                            marquee(region, in: proxy.size)
                        } else if support != .none {
                            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                .strokeBorder(
                                    Color.white.opacity(0.7),
                                    style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                                )
                                .padding(6)
                                .allowsHitTesting(false)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(dragGesture(in: proxy.size))
                }
            }
            .accessibilityLabel("Image canvas")
            .accessibilityValue(
                region.map {
                    "Selection \(Int(($0.width * 100).rounded())) by \(Int(($0.height * 100).rounded())) percent"
                } ?? "No selection; changes apply to the whole image"
            )
    }

    private func dragGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                guard support != .none, size.width > 0, size.height > 0 else { return }
                let start = normalized(value.startLocation, in: size)
                let origin = dragOrigin ?? CGPoint(x: start.x, y: start.y)
                dragOrigin = origin
                let current = normalized(value.location, in: size)
                region = NativeImageRegion(
                    x: min(origin.x, current.x),
                    y: min(origin.y, current.y),
                    width: abs(current.x - origin.x),
                    height: abs(current.y - origin.y)
                )
            }
            .onEnded { _ in
                dragOrigin = nil
                if let current = region,
                    current.width < Self.minimumRegion || current.height < Self.minimumRegion
                {
                    region = nil
                }
            }
    }

    private func normalized(_ point: CGPoint, in size: CGSize) -> (x: Double, y: Double) {
        (
            min(1, max(0, point.x / size.width)),
            min(1, max(0, point.y / size.height))
        )
    }

    /// The selection: a bright outline, and everything outside it dimmed. The
    /// dimming is what makes the selection readable on a busy photograph — an
    /// outline alone disappears into detail.
    private func marquee(_ region: NativeImageRegion, in size: CGSize) -> some View {
        let rect = CGRect(
            x: region.x * size.width,
            y: region.y * size.height,
            width: region.width * size.width,
            height: region.height * size.height
        )
        return ZStack {
            Color.black.opacity(0.55)
                .reverseMask {
                    Rectangle().path(in: rect)
                }
            Rectangle()
                .path(in: rect)
                .stroke(Color.white.opacity(0.9), lineWidth: 1)
            Text("\(Int((region.width * 100).rounded()))% × \(Int((region.height * 100).rounded()))")
                .font(.system(size: 10, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.black.opacity(0.72)))
                .position(x: rect.midX, y: max(12, rect.minY - 12))
        }
        .allowsHitTesting(false)
    }

    private func unavailable(_ message: String, symbol: String) -> some View {
        VStack(spacing: JunoSpace.snug) {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(Color.junoMutedForeground)
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(Color.junoMutedForeground)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: JunoSpace.cozy) {
            areaPicker
            if support == .none { unsupportedNote }
            if support == .prompt, let editor { guidanceNote(editor) }
            instructionsField
            actions
        }
        .padding(JunoSpace.regular)
    }

    private var areaPicker: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("Edit area")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.junoMutedForeground)
            // Two states, and the second is not a *mode* — it reports whether a
            // selection exists. Making "Select area" a toggle would leave the app
            // claiming a selection the reader has not drawn yet.
            HStack(spacing: JunoSpace.snug) {
                Button { region = nil } label: {
                    Label("Whole image", systemImage: "photo")
                        .font(.system(size: 12, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                                .fill(region == nil ? Color.junoSurface : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .foregroundStyle(region == nil ? Color.primary : Color.junoMutedForeground)

                Label(
                    region == nil ? "Drag on the image" : "Selected area",
                    systemImage: "crop"
                )
                .font(.system(size: 12, weight: .medium))
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .foregroundStyle(region == nil ? Color.junoMutedForeground : Color.primary)
                .background(
                    RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                        .fill(region == nil ? Color.clear : Color.junoSurface)
                )
            }
            .padding(3)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(Color.junoMuted.opacity(0.6))
            )
            Text(
                region.map {
                    "Selection: \(Int(($0.width * 100).rounded()))% × \(Int(($0.height * 100).rounded()))%."
                } ?? "Applies to the whole image."
            )
            .font(.system(size: 11))
            .foregroundStyle(Color.junoMutedForeground)
        }
    }

    private var unsupportedNote: some View {
        Label(
            editors.isEmpty
                ? "No image model on this account can edit an existing image."
                : "This model can't edit images. Pick one that can.",
            systemImage: "exclamationmark.triangle"
        )
        .font(.system(size: 12))
        .foregroundStyle(Color.junoDanger)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func guidanceNote(_ editor: NativeChatModelOption) -> some View {
        Label(
            "\(editor.displayName) uses the selected area as guidance, so nearby detail may also change.",
            systemImage: "info.circle"
        )
        .font(.system(size: 11))
        .foregroundStyle(Color.junoMutedForeground)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var instructionsField: some View {
        VStack(alignment: .leading, spacing: JunoSpace.tight) {
            Text("Instructions")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.junoMutedForeground)
            TextField(
                region == nil
                    ? "Describe how the image should change…"
                    : "Describe what should change inside the selection…",
                text: $instructions,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .lineLimit(3...6)
            .font(.system(size: 13))
            .disabled(support == .none)
            .padding(JunoSpace.snug)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .fill(Color.junoSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: JunoRadius.panel, style: .continuous)
                    .strokeBorder(Color.junoHairline)
            )
        }
    }

    private var actions: some View {
        HStack(spacing: JunoSpace.snug) {
            if editors.count > 1 {
                Picker("Model", selection: $modelID) {
                    ForEach(editors) { option in
                        Text(option.displayName).tag(option.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
            } else if let editor {
                Text(editor.displayName)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.junoMutedForeground)
            }
            Spacer(minLength: 0)
            Button("Cancel", action: close)
                .buttonStyle(.plain)
                .foregroundStyle(Color.junoMutedForeground)
            Button(action: generate) {
                Text("Generate edit")
                    .font(.system(size: 13, weight: .semibold))
                    .padding(.horizontal, JunoSpace.regular)
                    .frame(height: 32)
                    .background(
                        Capsule().fill(canSubmit ? Color.junoAccent : Color.junoMuted)
                    )
                    .foregroundStyle(canSubmit ? Color.junoOnAccent : Color.junoMutedForeground)
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
        }
    }

    // MARK: - Work

    private func load() async {
        source = nil
        loadFailure = nil
        region = nil
        do {
            let (data, _) = try await attachments.imageData(
                attachmentID: attachmentID, for: accountID
            )
            guard let decoded = NativeSourceImage(data: data) else {
                loadFailure = "Juno couldn't read this image."
                return
            }
            source = decoded
        } catch {
            loadFailure = NativeFailureMessage.presentable(error)
        }
    }

    private func generate() {
        guard canSubmit, let editor else { return }
        var mask: String?
        // Only a masking model gets the bitmap. A `prompt` model takes the region
        // as guidance and ignores a mask, and an 8 MB PNG sent to be ignored is
        // not free for anyone.
        if let region, support == .mask, let source {
            mask = NativeImageMask.pngDataURL(region: region, pixelSize: source.pixelSize)
        }
        submit(
            NativeMediaGenerationRequest(
                conversationID: nil,
                prompt: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
                modelID: editor.id,
                modality: .image,
                edit: NativeMediaGenerationRequest.Edit(
                    attachmentID: attachmentID,
                    region: region.map {
                        NativeMediaGenerationRequest.Region(
                            x: $0.x, y: $0.y, width: $0.width, height: $0.height
                        )
                    },
                    maskDataURL: mask
                )
            )
        )
        close()
    }
}

/// A selection on the image, in 0…1 fractions from the top-left.
public struct NativeImageRegion: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// The decoded source image, kept as a `CGImage` so both platforms draw it the
/// same way and the pixel size is available for the mask.
struct NativeSourceImage {
    let cgImage: CGImage
    let pixelSize: CGSize

    var aspectRatio: CGFloat { pixelSize.height > 0 ? pixelSize.width / pixelSize.height : 1 }

    init?(data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        cgImage = image
        pixelSize = CGSize(width: image.width, height: image.height)
    }
}

/// Renders the edit mask.
public enum NativeImageMask {

    /// A PNG data URL at the image's natural size: **opaque black outside** the
    /// region, **transparent inside** it.
    ///
    /// That polarity is the `images.edit` convention — the transparent pixels are
    /// the ones the model is allowed to repaint — and it is the single easiest
    /// thing to get backwards, which is why it is stated here and pinned by a
    /// test rather than left to the reader of the drawing code.
    ///
    /// Returns nil rather than a blank mask if the bitmap cannot be made: a mask
    /// of the wrong shape would silently edit the wrong part of the picture, and
    /// no mask at all edits the whole image, which is at least what the request
    /// then says.
    public static func pngDataURL(region: NativeImageRegion, pixelSize: CGSize) -> String? {
        let width = Int(pixelSize.width.rounded())
        let height = Int(pixelSize.height.rounded())
        guard width > 0, height > 0 else { return nil }

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        // CoreGraphics' origin is bottom-left and the region's is top-left, so
        // the rectangle is flipped vertically here. Getting this wrong mirrors
        // the edit to the opposite half of the image — which still produces a
        // plausible picture, and is therefore easy to ship.
        let hole = CGRect(
            x: (region.x * Double(width)).rounded(),
            y: ((1 - region.y - region.height) * Double(height)).rounded(),
            width: max(1, (region.width * Double(width)).rounded()),
            height: max(1, (region.height * Double(height)).rounded())
        )
        context.clear(hole)

        guard let image = context.makeImage() else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }

        return "data:image/png;base64," + (output as Data).base64EncodedString()
    }
}

private extension View {
    /// Punches `mask` out of this view. `.mask` keeps what is inside the shape;
    /// the dimming overlay needs the opposite, and SwiftUI has no `.inverseMask`.
    func reverseMask<Mask: View>(@ViewBuilder _ mask: () -> Mask) -> some View {
        self.mask {
            ZStack {
                Rectangle()
                mask().blendMode(.destinationOut)
            }
            .compositingGroup()
        }
    }
}
