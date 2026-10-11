# Computer use permissions on the Mac

## What went wrong in 1.10.9

Alevr showed as on in System Settings › Privacy & Security › Device Control and
Data Access. macOS still answered "not trusted" to `AXIsProcessTrusted()`, so
every `computer_use` call came back with "Alevr needs Accessibility".

The cause is in the unified log (`tccd`, 2026-10-11 16:25:34):

```
Failed to match existing code requirement for subject com.liammagnier.JunoDesktop
and service kTCCServiceAccessibility
    cdhash H"fdc8f8c02f2ca144a592e5d041620690ecbad27b" or cdhash H"37f5210f3ed89503e13bcf9c7ad81eed0bef8f94"
```

macOS stores each grant with the code requirement it saw when the switch was
turned on. The Accessibility grant was given to an older ad-hoc-signed build,
so macOS stored that build's hash. Alevr 1.10.9 is signed with the Apple
Development certificate:

```
$ codesign -dr - /Applications/Alevr.app
designated => identifier "com.liammagnier.JunoDesktop" and anchor apple generic and
  certificate leaf[subject.CN] = "Apple Development: liam.magnier25@icloud.com (8RSCGS63QP)" and
  certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */
```

No later build can match a hash requirement. Turning the switch off and on
again does not change the stored requirement. Reopening Alevr does not change
it either. Screen Recording was unaffected because it had been granted to a
certificate-signed build.

## Fix it once (owner)

1. Open System Settings › Privacy & Security › Device Control and Data Access.
   On macOS 26 and earlier this page is called Accessibility.
2. Select **Alevr** and press the **minus** button to remove it.
3. Press **plus**, choose **Alevr** in Applications, and turn it on.
4. In the Alevr thread, ask the agent to try again. You don't need to reopen
   Alevr because Accessibility trust is read live.

Optional: the **JunoDesktop** row is most likely the Xcode debug build
(`com.liammagnier.JunoDesktop.debug`). tccd logs the same mismatch for it. It
does nothing for the installed Alevr, and you can remove it with the minus
button.

From now on, every release signed with the same Apple Development certificate
keeps the grant, because the requirement is the identifier plus the
certificate name. If a release is ever signed ad-hoc, the grant breaks again.
`release-macos.sh` now prints a large warning and waits 10 seconds when it has
to fall back to ad-hoc signing. Set `ALEVR_SIGNING_IDENTITY` to pin one
certificate when the keychain holds several.

## What the app does now

- If a connected agent's computer-use call is refused because of a missing
  grant, a notice appears above that thread's composer. It names the grant,
  names the exact Settings page for this macOS version, and explains how to
  fix a switch that shows on but is stale (remove it, then add it again).
  **Open Settings** goes straight to that page. The notice checks both grants
  every second, and once macOS allows them it changes to "Computer use is
  ready", with no relaunch.
- The agent gets the same steps in the tool result. It is also told that
  reopening Alevr is not needed.
- Settings › Screen control rechecks the grants every second while one is
  missing, and shows the remove-and-add step when Accessibility is not
  allowed.
- To copy diagnostics, right-click a grant row in Settings › Screen control or
  the notice, then choose **Copy computer-use diagnostics**. This copies the
  bundle path, bundle id, version, pid, designated requirement, team, ad-hoc
  flag, `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess`, plus the
  `log show` command that prints tccd's reason.
- Each refusal also writes a log line (subsystem `com.liammagnier.JunoDesktop`,
  category `computer-use`):
  `/usr/bin/log show --last 1h --predicate 'subsystem == "com.liammagnier.JunoDesktop" AND category == "computer-use"'`
