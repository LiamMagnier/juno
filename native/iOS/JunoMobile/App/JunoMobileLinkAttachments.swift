import JunoCodeRemote
import JunoDesignSystem
import SwiftUI
import UIKit

// The "+" on Code's composers (owner, Oct 11, after Codex): camera, photos
// and files, through Chat's own surfaces (`JunoMobileAttachmentCoordinator`
// and `junoAttachmentSurfaces`), into the next message for the Mac.

/// The "+": the attach menu, as Chat's composer offers it.
struct JunoMobileLinkAttachMenu: View {
  let coordinator: JunoMobileAttachmentCoordinator
  var enabled = true
  /// Said under the rows when attaching is not possible here.
  var note: String? = nil
  /// Puts the keyboard away before a panel arrives.
  var willPresent: () -> Void = {}

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Menu {
      Section {
        Button { present(.camera) } label: { JunoIconLabel("attachments.camera", icon: .photos) }
        Button { present(.photos) } label: { JunoIconLabel("attachments.photos", icon: .photos) }
        Button { present(.files) } label: { JunoIconLabel("attachments.files", icon: .files) }
      } footer: {
        if let note { Text(note) }
      }
      .disabled(!enabled)
    } label: {
      JunoIconView(.plus, size: 20)
        .foregroundStyle(Color.primary)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .tint(Color.primary)
    .accessibilityLabel("Add photos and files")
    .accessibilityIdentifier("juno.mobile.link-attach")
  }

  private func present(_ surface: JunoAttachmentSurface) {
    if surface.dismissesKeyboard { willPresent() }
    coordinator.present(surface, reduceMotion: reduceMotion)
  }
}

extension CodeLinkDraftAttachment {
  init(_ file: JunoPickedFile) {
    self.init(name: file.fileName, mediaType: file.mimeType, data: file.data)
  }
}

/// The next message's files, over the field: a thumbnail or the file's
/// glyph and name, each with its ×.
struct JunoMobileLinkAttachmentStrip: View {
  @Bindable var model: CodeLinkRemoteModel

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: JunoSpace.snug) {
        ForEach(model.draftAttachments) { file in
          chip(file)
        }
      }
      .padding(.horizontal, JunoSpace.regular)
      .padding(.top, JunoSpace.cozy)
    }
    .scrollIndicators(.hidden)
    .accessibilityIdentifier("juno.mobile.link-attachments")
  }

  private func chip(_ file: CodeLinkDraftAttachment) -> some View {
    HStack(spacing: JunoSpace.snug) {
      if file.isImage, let image = UIImage(data: file.data) {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .frame(width: 36, height: 36)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      } else {
        JunoIconView(.file, size: 16)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(width: 36, height: 36)
          .background(Color.junoMuted, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      }
      if !file.isImage {
        Text(file.name)
          .font(.footnote)
          .foregroundStyle(Color.junoSecondaryInk)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: 120, alignment: .leading)
      }
      Button {
        model.removeAttachment(file.id)
      } label: {
        JunoIconView(.close, size: 10)
          .foregroundStyle(Color.junoSecondaryInk)
          .frame(width: 28, height: 36)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Remove \(file.name)")
    }
    .padding(.leading, JunoSpace.hairline)
  }
}
