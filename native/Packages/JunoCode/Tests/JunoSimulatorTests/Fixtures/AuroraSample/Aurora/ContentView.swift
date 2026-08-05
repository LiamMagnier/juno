import SwiftUI

/// The one screen the integration fixture shows.
///
/// The accessibility identifiers are the point: a visual check asserts against
/// them rather than against pixels, which is what lets the loop verify a change
/// without depending on fonts, scale factor or the simulator's theme.
public struct ContentView: View {
    @State private var signedIn = false

    public init() {}

    public var body: some View {
        VStack(spacing: 16) {
            Text("Welcome back")
                .font(.title2.weight(.semibold))
                .accessibilityIdentifier("aurora.title")

            Text(signedIn ? "Signed in" : "Signed out")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("aurora.status")

            Button(signedIn ? "Sign out" : "Sign in") { signedIn.toggle() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("aurora.primaryAction")
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("aurora.root")
    }
}
