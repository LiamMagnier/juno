import Foundation

/// The backend every shipping Juno client talks to.
///
/// This is deliberately a Swift constant rather than an `Info.plist` value.
/// Two earlier attempts to carry it through the xcconfig chain both produced
/// `https:` on the device, because xcconfig strips `//` to end of line as a
/// comment — including inside the variable that was meant to smuggle the
/// slashes through. More importantly, a plist copy is a *second* statement of
/// the URL: Diagnostics would then be reporting what the build was configured
/// to dial, not what it actually dialed. Here there is one value, and the
/// screen shows the same one the transport uses.
public enum JunoBackend {
    public static let productionURLString = "https://chat.liams.dev"

    /// Force-unwrapped on purpose: a malformed literal here is a build-time
    /// mistake that must not be recoverable at runtime, and it is covered by a
    /// test so it can never reach a device.
    public static let productionURL = URL(string: productionURLString)!
}
