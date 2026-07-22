# Installing Juno 0.1.0

Three artifacts, each with a different reach. Read the caveat that applies to
yours before installing — none of these is a public-distribution build, and the
reason differs per platform.

Verify what you downloaded first:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

## macOS — `Juno-0.1.0-macOS.dmg`

Universal (`arm64` + `x86_64`), hardened runtime, signed with an **Apple
Development** certificate (team `58PVP763WX`).

1. Open the DMG and drag **Juno** to Applications.
2. The first launch is blocked by Gatekeeper. This is expected and is not a
   sign the app is broken — see below.
3. Right-click **Juno** in Applications → **Open** → **Open**. Or clear the
   quarantine flag:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Juno.app
   ```

**Why Gatekeeper blocks it.** Direct distribution outside the App Store requires
a *Developer ID Application* certificate and a notarization ticket from Apple.
Neither exists on this machine, so the build is signed with the Development
certificate instead. `spctl -a -t exec` reports `rejected` — accurately. The
signature itself is valid (`codesign --verify --deep --strict` passes); it is
simply not a distribution signature.

## iPhone / iPad — `Juno-0.1.0-iOS-development.ipa`

Signed with an **Apple Development** certificate and a development provisioning
profile.

- Installs on **one registered device only** — the single device UDID in the
  profile. It will not install on any other iPhone or iPad.
- The profile **expires 2026-07-29**. After that the app stops launching until
  it is re-signed.
- The build carries `get-task-allow`, so it is debuggable. That is inherent to
  development signing, not a build-configuration mistake.

Install with Apple Configurator, Xcode's Devices window, or:

```bash
xcrun devicectl device install app --device <udid> Juno-0.1.0-iOS-development.ipa
```

TestFlight and App Store distribution are not possible from this machine — see
DELIVERY_REPORT.md for the exact missing credentials.

## iOS Simulator — `Juno-0.1.0-iOS-Simulator.app.zip`

Universal simulator slice, **signed**. Runs on any iOS 27 simulator.

```bash
unzip Juno-0.1.0-iOS-Simulator.app.zip
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted JunoMobile.app
xcrun simctl launch booted com.liammagnier.JunoMobile
```

**This artifact is signed on purpose.** An unsigned simulator build has no
`application-identifier`, which iOS uses as an app's default Keychain access
group. Without it every Keychain call fails with `errSecMissingEntitlement`
(-34018), the app cannot store a token, and the sign-in gate goes unavailable
with its button hidden. Do not rebuild this artifact with
`CODE_SIGNING_ALLOWED=NO`.

## Signing in

All three builds talk to production at `https://chat.liams.dev` and sign in
through the system browser (PKCE). They synchronize with the same account as the
web app. There is no offline or demo mode in a release build.
