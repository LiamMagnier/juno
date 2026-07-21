# Juno Native — Product and Platform Research

Updated: 2026-07-21. Prefer these official sources over competitor screenshots or remembered behavior.

## OpenAI Codex

Sources:

- [Codex manual](https://developers.openai.com/codex/codex-manual.md)
- [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

Useful conclusions:

- Local and worktree sessions run on the user's computer; cloud sessions run in isolated hosted environments. Juno must make that execution location equally explicit.
- Remote control is a structured connection to a local agent session, not general remote desktop. Product surfaces expose task progress, diffs, tests, terminal output, screenshots, and approvals.
- Worktrees isolate parallel sessions; a chat retains its associated worktree and can be handed between local and worktree contexts. Juno needs stable workspace/session identity rather than path-only identity.
- Subagents are separate inspectable threads. Parallel read-heavy work is beneficial, while concurrent write-heavy work needs careful conflict control.
- Approval and sandbox policy remain first-class; a background/non-interactive run cannot silently invent an approval channel.

Juno difference: Juno's Mac remains authoritative for local sessions, and the existing Juno backend provides its own versioned relay/registry rather than copying Codex branding or protocols.

## Anthropic Claude Code

Sources:

- [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Web/remote quickstart comparison](https://code.claude.com/docs/en/web-quickstart)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Subagents](https://code.claude.com/docs/en/sub-agents)

Useful conclusions:

- Remote Control keeps code execution, filesystem, tools, and project configuration on the user's machine; mobile/web are synchronized control surfaces.
- The documented transport uses outbound TLS rather than an open inbound host port, short-lived scoped credentials, reconnection, visible status, and push notifications for completion/decisions.
- Cloud tasks remain alive after the laptop disconnects; local Remote requires the host process. Juno Code Cloud and Juno Code Remote must communicate this difference before launch.
- Permissions and OS-level sandboxing are complementary defenses. Juno should enforce both intent-level tool policy and process/filesystem/network boundaries.
- Background subagents cannot depend on new interactive approvals. Juno should surface awaiting-approval state or fail closed rather than auto-approve.

Juno difference: the backend and runner already exist; the apps should expose their typed events and permissions rather than embed a third-party CLI or API key.

## Apple interface and platform guidance

Sources:

- [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views)
- [Human Interface Guidelines — Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Human Interface Guidelines — Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Human Interface Guidelines — Searching](https://developer.apple.com/design/human-interface-guidelines/searching)
- [ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/)
- [Keychain services](https://developer.apple.com/documentation/security/keychain-services/)
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Capturing screen content in macOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Preparing an app for distribution](https://developer.apple.com/documentation/xcode/preparing-your-app-for-distribution)
- [Configuring the hardened runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime/)
- [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

Useful conclusions:

- Standard SwiftUI/AppKit bars, split views, sheets, popovers, and controls adopt current material automatically. Custom glass should be rare and restricted to the functional control layer.
- Custom backgrounds can interfere with system scroll-edge/glass behavior. Prefer system navigation and toolbar containers.
- Global search should have one clear entry point, recent/suggested queries, explicit scope, filters where useful, and a visible way to clear private history.
- `ASWebAuthenticationSession` binds the callback to the initiating app session and uses the system browser experience. Juno still validates state, nonce, verifier, and exact redirect itself.
- Keychain is appropriate for refresh/access credentials and small cryptographic secrets; account data belongs in a transactional local store.
- ScreenCaptureKit recommends the system content-sharing picker and explicit permission. Juno Computer Use must keep capture selection, active indication, pause/stop, and sensitive-action controls visible.
- Developer ID distribution requires hardened runtime, an appropriate Developer ID signature, notarization, and stapling. Mac App Store distribution requires App Sandbox; a full local coding host may be better suited to Developer ID with minimal explicit entitlements.

## Product decisions from the four screenshots

- Treat screenshots as functional/interaction references only; do not reuse brand assets, copy, layout, or trade dress.
- Remote: device/workspace/session choice and permission/model state belong close to the composer; transcript state must survive keyboard and reconnection changes.
- Search: show recents before typing, use category sections, instant filtering, native focus, and keyboard-safe layout.
- Sidebar: maintain chat identity and scroll state while the drawer moves spatially; use permanent split-view columns on wider iPad/Mac layouts.
- Cloud Code: repository and base-branch context must remain visible; Ask/Plan/Code, permission, model, effort, attachments, status and PR output are typed task inputs/outputs rather than decorative chips.

## Risks to retain in implementation

- Prompt injection and untrusted repository configuration.
- Token theft/reuse and cross-account cache confusion.
- Remote command replay, duplicated/out-of-order events, and stale device presence.
- Capture/log/diff secret leakage.
- Background execution constraints on iOS.
- Over-broad macOS entitlements and unsigned helpers.
- Store/App Review constraints for external subscriptions and account deletion.
- New OS/SDK behavior must be guarded with availability and verified on final stable toolchains before release.
