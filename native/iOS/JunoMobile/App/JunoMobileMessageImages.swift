import JunoChatKit
import JunoDesignSystem
import SwiftUI
import UIKit

/// The pictures on a message: the reader's photos on a question, the
/// generated picture on an answer.
///
/// One picture fills the width the bubble allows; two or more tile in a
/// two-up grid. Every tile keeps the server's aspect ratio *before* the bytes
/// arrive, so the transcript does not jump when they do. Tapping opens the
/// viewer; the transition zooms out of the tile on iOS 18+.
struct JunoMobileMessageImages: View {
  let attachments: [NativeChatAttachment]
  let loader: NativeChatImageLoader
  /// Trailing for the reader's own message, leading for Juno's.
  var alignment: HorizontalAlignment = .leading
  var maxWidth: CGFloat = 288

  @State private var viewing: NativeChatAttachment?
  @Namespace private var zoom

  var body: some View {
    let images = attachments.filter(\.isImage)
    Group {
      if images.count == 1, let image = images[0] as NativeChatAttachment? {
        tile(image, width: maxWidth)
      } else if !images.isEmpty {
        let column = (maxWidth - JunoSpace.tight) / 2
        LazyVGrid(
          columns: [GridItem(.fixed(column), spacing: JunoSpace.tight), GridItem(.fixed(column))],
          spacing: JunoSpace.tight
        ) {
          ForEach(images) { image in
            tile(image, width: column, square: true)
          }
        }
        .frame(width: maxWidth)
      }
    }
    .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
    .fullScreenCover(item: $viewing) { image in
      JunoMobileImageViewer(
        attachments: images,
        initial: image,
        loader: loader
      )
      .modifier(JunoMobileZoomTransitionSource(id: image.id, namespace: zoom))
    }
  }

  private func tile(_ image: NativeChatAttachment, width: CGFloat, square: Bool = false) -> some View {
    let ratio = square ? 1 : (image.aspectRatio ?? 4 / 3)
    let height = min(width / ratio, square ? width : 360)
    return Button {
      viewing = image
    } label: {
      JunoMobileAttachmentImage(attachment: image, loader: loader)
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous)
            .strokeBorder(Color.junoHairline, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: JunoRadius.card, style: .continuous))
    }
    .buttonStyle(.junoPress)
    .modifier(JunoMobileZoomTransitionAnchor(id: image.id, namespace: zoom))
    .accessibilityLabel(image.fileName)
    .accessibilityHint("Opens the image")
    .accessibilityIdentifier("juno.mobile.message-image")
  }
}

/// One image, from the loader's cache, with a placeholder the right shape.
struct JunoMobileAttachmentImage: View {
  let attachment: NativeChatAttachment
  let loader: NativeChatImageLoader
  var contentMode: ContentMode = .fill

  var body: some View {
    ZStack {
      Color.junoMuted
      switch loader.state(for: attachment.id) {
      case .loaded(let data):
        if let image = UIImage(data: data) {
          Image(uiImage: image)
            .resizable()
            .aspectRatio(contentMode: contentMode)
            .transition(.opacity)
        } else {
          broken
        }
      case .loading:
        ProgressView()
          .controlSize(.small)
          .tint(Color.junoMutedForeground)
      case .failed:
        broken
      }
    }
    .task(id: attachment.id) { await loader.load(attachment.id) }
  }

  private var broken: some View {
    VStack(spacing: JunoSpace.tight) {
      Image(systemName: "photo.badge.exclamationmark")
        .junoFont(size: 22, relativeTo: .title2)
      Text("Couldn't load")
        .junoFont(size: 11, relativeTo: .caption2)
    }
    .foregroundStyle(Color.junoMutedForeground)
  }
}

// MARK: - Zoom transition

/// `.navigationTransition(.zoom)` / `.matchedTransitionSource`, gated so the
/// deployment target keeps compiling. Both halves are no-ops below iOS 18.
struct JunoMobileZoomTransitionAnchor: ViewModifier {
  let id: String
  let namespace: Namespace.ID

  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.matchedTransitionSource(id: id, in: namespace)
    } else {
      content
    }
  }
}

struct JunoMobileZoomTransitionSource: ViewModifier {
  let id: String
  let namespace: Namespace.ID

  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.navigationTransition(.zoom(sourceID: id, in: namespace))
    } else {
      content
    }
  }
}

// MARK: - Viewer

/// The lightbox: pinch to zoom, drag down to dismiss, swipe between the
/// message's pictures, share.
struct JunoMobileImageViewer: View {
  let attachments: [NativeChatAttachment]
  let initial: NativeChatAttachment
  let loader: NativeChatImageLoader

  @State private var current: String
  @State private var dragOffset: CGSize = .zero
  @State private var chromeHidden = false
  @State private var saved = false
  @State private var copyHaptic = JunoMobileHapticTrigger()
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(attachments: [NativeChatAttachment], initial: NativeChatAttachment, loader: NativeChatImageLoader) {
    self.attachments = attachments
    self.initial = initial
    self.loader = loader
    _current = State(initialValue: initial.id)
  }

  private var dismissProgress: CGFloat {
    min(1, max(0, dragOffset.height / 240))
  }

  private var currentAttachment: NativeChatAttachment? {
    attachments.first { $0.id == current }
  }

  private var currentData: Data? {
    guard let currentAttachment, case .loaded(let data) = loader.state(for: currentAttachment.id) else {
      return nil
    }
    return data
  }

  var body: some View {
    ZStack {
      Color.black
        .opacity(1 - dismissProgress * 0.7)
        .ignoresSafeArea()

      TabView(selection: $current) {
        ForEach(attachments) { attachment in
          JunoMobileZoomableImage(attachment: attachment, loader: loader) {
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
              chromeHidden.toggle()
            }
          }
          .tag(attachment.id)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: attachments.count > 1 ? .automatic : .never))
      .offset(dragOffset)
      .scaleEffect(1 - dismissProgress * 0.15)
      .simultaneousGesture(
        DragGesture(minimumDistance: 12)
          .onChanged { value in
            // Only a mostly-vertical pull dismisses; a horizontal one pages.
            guard abs(value.translation.height) > abs(value.translation.width) else { return }
            dragOffset = value.translation
          }
          .onEnded { value in
            if value.translation.height > 120 || value.predictedEndTranslation.height > 260 {
              dismiss()
            } else {
              withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
                dragOffset = .zero
              }
            }
          }
      )

      if !chromeHidden {
        chrome
          .transition(.opacity)
      }
    }
    .statusBarHidden(chromeHidden)
    .preferredColorScheme(.dark)
    .junoHaptic(JunoMobileHaptic.copy, trigger: copyHaptic)
    .accessibilityIdentifier("juno.mobile.image-viewer")
  }

  private var chrome: some View {
    VStack {
      HStack {
        Button {
          dismiss()
        } label: {
          JunoIconView(.close, size: 16)
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(.black.opacity(0.35), in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("juno.mobile.image-viewer-close")
        Spacer()
        if let currentAttachment {
          Text(currentAttachment.fileName)
            .junoFont(size: 13, relativeTo: .footnote, weight: .medium)
            .foregroundStyle(.white.opacity(0.85))
            .lineLimit(1)
        }
        Spacer()
        if let data = currentData, let image = UIImage(data: data) {
          ShareLink(
            item: Image(uiImage: image),
            preview: SharePreview(currentAttachment?.fileName ?? "Image", image: Image(uiImage: image))
          ) {
            JunoIconView(.share, size: 16)
              .foregroundStyle(.white)
              .frame(width: 44, height: 44)
              .background(.black.opacity(0.35), in: Circle())
              .contentShape(Circle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Share image")
          .accessibilityIdentifier("juno.mobile.image-viewer-share")
        } else {
          Color.clear.frame(width: 44, height: 44)
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.snug)
      Spacer()
      if let data = currentData, let image = UIImage(data: data) {
        HStack(spacing: JunoSpace.regular) {
          Button {
            UIPasteboard.general.image = image
            copyHaptic.fire()
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          Button {
            UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
            copyHaptic.fire()
            withAnimation(JunoMotion.reduced(JunoMotion.fast, when: reduceMotion, tier: .tint)) {
              saved = true
            }
          } label: {
            Label(saved ? "Saved" : "Save", systemImage: saved ? "checkmark" : "square.and.arrow.down")
              .contentTransition(.symbolEffect(.replace))
          }
          .disabled(saved)
        }
        .junoFont(size: 14, relativeTo: .subheadline, weight: .medium)
        .foregroundStyle(.white)
        .padding(.horizontal, JunoSpace.regular)
        .frame(minHeight: 44)
        .background(.black.opacity(0.35), in: Capsule())
        .padding(.bottom, JunoSpace.regular)
      }
    }
  }
}

/// A pinch-zoomable, pannable image. Double-tap toggles 2.5×.
private struct JunoMobileZoomableImage: View {
  let attachment: NativeChatAttachment
  let loader: NativeChatImageLoader
  let onTap: () -> Void

  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var lastOffset: CGSize = .zero
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        Color.clear
        JunoMobileAttachmentImage(attachment: attachment, loader: loader, contentMode: .fit)
          .scaleEffect(scale)
          .offset(offset)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .contentShape(Rectangle())
      .gesture(
        MagnifyGesture()
          .onChanged { value in
            scale = max(1, min(6, lastScale * value.magnification))
          }
          .onEnded { _ in
            lastScale = scale
            if scale <= 1.02 { reset() }
          }
          .simultaneously(
            with: DragGesture(minimumDistance: 4)
              .onChanged { value in
                guard scale > 1 else { return }
                offset = CGSize(
                  width: lastOffset.width + value.translation.width,
                  height: lastOffset.height + value.translation.height
                )
              }
              .onEnded { _ in lastOffset = offset }
          )
      )
      .onTapGesture(count: 2) {
        withAnimation(JunoMotion.reduced(JunoMotion.standard, when: reduceMotion)) {
          if scale > 1 {
            reset()
          } else {
            scale = 2.5
            lastScale = 2.5
          }
        }
      }
      .onTapGesture(count: 1, perform: onTap)
    }
    .accessibilityLabel(attachment.fileName)
  }

  private func reset() {
    scale = 1
    lastScale = 1
    offset = .zero
    lastOffset = .zero
  }
}
