// Starting a design: the four sizes and `POST /api/design`.
//
// Moved out of the retired Design page (Phase 4 A2): a design is an artifact
// of type DESIGN, so the sizes are the Artifacts page's New menu and its
// pinned preset buttons, and a new design opens on its own artifact page.
import Foundation
import JunoAPI
import JunoAuth
import JunoChatKit
import JunoCore
import JunoDesignSystem
import JunoStorage
import JunoSync
import SwiftUI

// MARK: - Presets

/// The sizes a new design can start at.
///
/// The four the website offers, with the same names and the same numbers —
/// `src/app/(app)/design/page.tsx` lists them and `src/app/api/design/route.ts`
/// turns each into a frame. The raw values are the wire enum that route parses,
/// so renaming one here silently starts every design at 375×812 (the route's
/// default) rather than failing; ``DesktopDesignLauncherTests`` pins them.
///
/// Named for what is being designed rather than for the numbers, because the
/// choice a person is making is "a phone screen", not "812 points tall". The
/// numbers are still printed under the name — they are what tells a designer
/// this is the *device* size and not a canvas they will have to resize.
enum DesktopDesignPreset: String, CaseIterable, Identifiable {
    case phone
    case tablet
    case desktop
    case square

    var id: Self { self }

    var label: String {
        switch self {
        case .phone: "Phone"
        case .tablet: "Tablet"
        case .desktop: "Desktop"
        case .square: "Square"
        }
    }

    /// The frame the route actually creates. Duplicated from the server on
    /// purpose: this is a *label*, and a label that says 375 × 812 while the
    /// route builds something else is worse than no label at all — which is why
    /// the numbers are asserted against the route's own table in the tests.
    var size: CGSize {
        switch self {
        case .phone: CGSize(width: 375, height: 812)
        case .tablet: CGSize(width: 834, height: 1_194)
        case .desktop: CGSize(width: 1_440, height: 900)
        case .square: CGSize(width: 1_080, height: 1_080)
        }
    }

    /// "375 × 812", with the multiplication sign the web uses rather than an "x".
    var detail: String {
        "\(Int(size.width)) × \(Int(size.height))"
    }
}

// MARK: - Starting a design

enum DesktopDesignStartError: LocalizedError {
    case unavailable
    case malformedResponse
    case server(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Juno is not signed in to a backend that can start a design."
        case .malformedResponse:
            "Juno started the design but could not read where it went."
        case .server(_, let message):
            message
        }
    }
}

/// `POST /api/design` — the one route that starts a design from nothing.
///
/// The same route the website's launcher posts to, and deliberately not a
/// native shortcut around it: the route creates the conversation that owns the
/// artifact, expands the frame through the same authoring pass a model's design
/// goes through, and writes version 1. A client that built the `DesignDocument`
/// here and saved it as an artifact would produce a design that is subtly not
/// the same kind of object as every other one — and would have to be kept in
/// step with `expandAuthoredDesign` by hand, forever.
///
/// It rides ``NativeAuthenticatedRequestSending``, which is the app's only
/// authenticated transport — the same one ``NativeArtifactAPIClient`` and
/// ``JunoDesktopVoiceAuthorization`` use. Nothing here reaches for URLSession or
/// for the Keychain.
struct DesktopDesignStartClient: Sendable {
    let sender: any NativeAuthenticatedRequestSending

    /// - Returns: the new artifact's identifier. The route also answers with the
    ///   conversation it made and the web URL to send a browser to; neither is
    ///   useful to a Mac window that opens the document in place.
    func startDesign(
        preset: DesktopDesignPreset,
        title: String,
        for accountID: AccountID
    ) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/design",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(
                    StartRequestWire(title: title, preset: preset.rawValue)
                )
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else {
            throw DesktopDesignStartError.server(
                statusCode: response.statusCode,
                message: Self.serverMessage(response.body)
                    ?? Self.fallbackMessage(statusCode: response.statusCode)
            )
        }
        guard let decoded = try? JSONDecoder().decode(
            StartResponseWire.self,
            from: response.body
        ), !decoded.artifactId.isEmpty else {
            throw DesktopDesignStartError.malformedResponse
        }
        return decoded.artifactId
    }

    /// The route's own sentence when it has one. `403` in particular is a real
    /// answer — "your plan does not include the canvas" — and replacing it with a
    /// generic failure would tell a free-tier reader that Juno is broken rather
    /// than that the canvas is not on their plan.
    private static func serverMessage(_ body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        if let message = object["error"] as? String, !message.isEmpty { return message }
        if let message = object["message"] as? String, !message.isEmpty { return message }
        return nil
    }

    private static func fallbackMessage(statusCode: Int) -> String {
        switch statusCode {
        case 401: "Sign in again to start a design."
        case 403: "The canvas is not included in this account's plan."
        case 404: "This Juno server is too old to start a design."
        case 429: "Juno is busy. Wait a moment and try again."
        default: "Juno could not start a design."
        }
    }

    private struct StartRequestWire: Encodable {
        let title: String
        let preset: String
    }

    private struct StartResponseWire: Decodable {
        let artifactId: String
    }
}

// MARK: - The legacy tasks window's Design row

/// The way into Design at the foot of Code's and the legacy tasks workspace's
/// navigation columns.
///
/// **Not Chat's any more.** The web moved Design up among the navigation rows,
/// and Chat followed in Phase 1 of the Liquid Glass redesign (§2.1): its column
/// has a Design row under Library, Projects and Artifacts, and its footer is
/// about the account alone. This footer row stays for the two columns that have
/// not been reworked yet, and goes with them.
///
/// **One row, two columns.** Code and the legacy workspace each compose their
/// own footer — Code stacks a workspace notice above the account block, the
/// legacy workspace has no account block at all — so the shared thing is this
/// row rather than a shared footer. Its anatomy is ``DesktopAccountFooter``'s account row: the same
/// insets, the same ``JunoRadius/row`` hover shape, the same
/// `Color.junoSidebarSelection` fill, so the two read as one footer instead of
/// as a button sitting on top of one.
///
/// The mark is the web's own (`AppIcons.design`, Juno's `JunoDesign`): a
/// square in front of a circle, stacked like cut paper. This row drew a pencil
/// while the icon set had no Design mark — the SF Symbol `pencil.tip` before
/// that — and both named a tool rather than the place, which is the reason the
/// web gave up its own pen nib for this destination.
struct DesktopSidebarDesignRow: View {
    /// Whether the Design page is the one on screen. The web's `NavRow` takes the
    /// same flag and lifts its ink for it; a footer row that never shows it is
    /// open is a row a reader clicks twice.
    var isActive = false
    let open: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: JunoSpace.cozy) {
                JunoIconView(.design, size: 16)
                    .foregroundStyle(ink)
                    .frame(width: 26, height: 26)
                    .frame(minWidth: 28, minHeight: 28)
                    .accessibilityHidden(true)

                Text("Design")
                    .font(.callout)
                    .foregroundStyle(ink)
                    .lineLimit(1)

                Spacer(minLength: JunoSpace.hairline)
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous)
                    .fill(fill)
            )
            .contentShape(RoundedRectangle(cornerRadius: JunoRadius.row, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(JunoMotion.standard, value: isHovering)
        .animation(JunoMotion.standard, value: isActive)
        // The footer's own inset, so this row hangs on the same left edge as the
        // account row underneath it rather than half a gutter to its left.
        .padding(.horizontal, JunoSpace.snug)
        .padding(.top, JunoSpace.snug)
        .help("Start a design, or open one you already have")
        .accessibilityLabel("Design")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
        .accessibilityIdentifier("juno.desktop.design-row")
    }

    private var ink: Color { isActive ? .primary : .junoSidebarForeground }

    private var fill: Color {
        isActive || isHovering ? Color.junoSidebarSelection : .clear
    }
}
