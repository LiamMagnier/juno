import CoreSpotlight
import Foundation
import JunoChatKit
import UniformTypeIdentifiers

/// Conversation titles in Spotlight, so a chat can be found from the Home
/// Screen search without opening the app.
///
/// Titles only, never message text: the transcript is encrypted at rest for a
/// reason, and Spotlight's index is not that store. Rebuilt in full on every
/// sync generation — a few hundred small items — and cleared on sign-out.
enum JunoMobileSpotlight {
  static let domain = "juno.conversations"
  static let activityType = "com.liammagnier.JunoMobile.conversation"

  static func index(_ conversations: [NativeConversation]) async {
    guard CSSearchableIndex.isIndexingAvailable() else { return }
    let items = conversations
      .filter { !$0.isArchived && !$0.isPending }
      .map { conversation -> CSSearchableItem in
        let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)
        attributes.title = conversation.title
        attributes.contentDescription = "Chat in Juno"
        attributes.contentModificationDate = conversation.lastMessageAt
        attributes.relatedUniqueIdentifier = conversation.id
        let item = CSSearchableItem(
          uniqueIdentifier: conversation.id,
          domainIdentifier: domain,
          attributeSet: attributes
        )
        item.expirationDate = .distantFuture
        return item
      }
    let index = CSSearchableIndex.default()
    try? await index.deleteSearchableItems(withDomainIdentifiers: [domain])
    guard !items.isEmpty else { return }
    try? await index.indexSearchableItems(items)
  }

  static func clear() async {
    try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain])
  }
}
