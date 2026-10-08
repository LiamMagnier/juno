import JunoAuth
import JunoChatKit
import JunoSync
import SwiftUI

/// The profile page (`/profile`) on the iPhone: the shared
/// ``NativeProfileView`` fed by `GET /api/profile/activity`, pushed from
/// Settings › Account. Edit opens the username field, as the web's Edit does.
struct JunoMobileProfileView: View {
  let session: NativeAuthenticatedSession?
  let requestSender: (any NativeAuthenticatedRequestSending)?
  var avatarData: Data?

  @State private var model: NativeProfileModel?
  @State private var editingUsername = false

  var body: some View {
    Group {
      if let model, let session {
        NativeProfileView(
          model: model,
          identity: NativeProfileIdentity(
            name: session.profile.name,
            fallbackHandle: NativeProfileIdentity.derivedHandle(
              email: session.profile.email, name: session.profile.name),
            imageData: avatarData,
            imageURL: session.profile.imageURL
          ),
          onEdit: { editingUsername = true }
        )
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $editingUsername) {
          JunoMobileUsernameView(session: session, requestSender: requestSender) {
            Task { await model.load() }
          }
        }
      } else {
        ContentUnavailableView(
          "Profile unavailable", systemImage: "person.crop.circle",
          description: Text("Sign in again to see your activity."))
      }
    }
    .onAppear {
      if model == nil, let session, let requestSender {
        model = NativeProfileModel(
          client: NativeProfileClient(sender: requestSender), accountID: session.profile.id)
      }
    }
  }
}

/// Settings › Account › Username (`account-username.tsx`): the @handle on the
/// profile, checked as you type and saved with one button.
struct JunoMobileUsernameView: View {
  let session: NativeAuthenticatedSession?
  let requestSender: (any NativeAuthenticatedRequestSending)?
  var onSaved: (() -> Void)?

  @State private var model: NativeUsernameModel?
  @State private var saved: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    Form {
      if let model {
        Section {
          NativeUsernameFieldRows(model: model) { name in
            saved = name
            onSaved?()
          }
        } header: {
          Text(NativeUsernameCopy.description(username: model.username, fallback: model.handle))
            .textCase(nil)
        } footer: {
          Text("Your username is the @handle on your profile. 3 to 30 characters.")
        }
        if let saved {
          Section {
            Label("Your username is now @\(saved).", systemImage: "checkmark")
              .foregroundStyle(.secondary)
          }
        }
      } else {
        Text("Usernames are unavailable while signed out.")
          .foregroundStyle(.secondary)
      }
    }
    .junoGroupedPage()
    .navigationTitle("Username")
    .navigationBarTitleDisplayMode(.inline)
    .scrollDismissesKeyboard(.interactively)
    .task {
      guard model == nil, let session, let requestSender else { return }
      let created = NativeUsernameModel(
        client: NativeUsernameClient(sender: requestSender), accountID: session.profile.id)
      model = created
      await created.load()
      created.beginEditing()
    }
    .accessibilityIdentifier("juno.mobile.username")
  }
}
