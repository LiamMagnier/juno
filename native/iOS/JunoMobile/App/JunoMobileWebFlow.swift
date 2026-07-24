import SafariServices
import SwiftUI

/// An in-app browser for the one thing that genuinely needs one: a provider's
/// OAuth consent screen.
///
/// **Why a browser at all.** Connecting GitHub, Notion or a Composio app is a
/// redirect chain through the provider's own sign-in — Juno never sees those
/// credentials, and that is the point of OAuth. There is no API to call in place
/// of it, and re-implementing a consent screen natively would be both impossible
/// and exactly the thing OAuth exists to prevent.
///
/// **Why `SFSafariViewController` and not a `WKWebView`.** It shares Safari's
/// cookie jar, so the Juno session the reader already has in Safari — the same
/// one `ASWebAuthenticationSession` established at sign-in, which also runs
/// non-ephemeral — authenticates the `/api/connectors/…/connect` route without a
/// second sign-in. A `WKWebView` has its own empty jar and would ask them to log
/// into Juno again inside their own app. It is also the control Apple requires
/// for third-party sign-in: credentials are typed into a real Safari surface with
/// a visible, unspoofable address bar, and the host app cannot read the page.
///
/// The flow's *result* is deliberately not inferred from the sheet closing —
/// the reader may have finished, cancelled, or bounced off a provider error, and
/// only the server knows which. `onFinish` re-reads the connection state.
struct JunoMobileWebFlow: UIViewControllerRepresentable {
    let url: URL
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        // Named rather than converted from the SwiftUI colour: `UIColor(_:)` on a
        // dynamic colour resolves against the trait collection at init, which for
        // a controller built off-screen is the wrong appearance. A named asset
        // stays dynamic and resolves when it draws.
        controller.preferredControlTintColor = UIColor(named: "AccentColor")
        controller.dismissButtonStyle = .cancel
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: SFSafariViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        private let onFinish: () -> Void

        init(onFinish: @escaping () -> Void) {
            self.onFinish = onFinish
        }

        func safariViewControllerDidFinish(_: SFSafariViewController) {
            onFinish()
        }
    }
}
