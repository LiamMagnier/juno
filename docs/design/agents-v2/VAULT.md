# Agents v2: saved logins (the credential vault)

October 31, 2026. The audit listed a credential vault as a gap (AUDIT.md §3 item 10,
§5 "Deferred"). This is the vault: a person saves a site login for one of their agents,
and when that agent's computer is on the site's sign-in page, the agent can ask to have
it filled. The values are typed by the platform. The model never sees them.

It is **off by default**: `AGENT_VAULT_ENABLED=1` turns it on, and only beside a computer
provider (`COMPUTER_PROVIDER=docker` or `remote`; `fake` outside production).

---

## 1. What the person sees

- **Profile → Saved logins** (`src/components/agents/agent-logins.tsx`). Shown only when
  the agent has a computer and the server has the vault on. Each row shows the name and
  the site, never a value, then "Asks before its first use", "Approved", or the last-used
  date. **Add login** opens a form with Name, Site, Username, Password and an optional
  two-step setup key (a base32 key or an `otpauth://totp/...` link). **Remove** deletes
  the row and its sealed values.
- **The approval card**, the first time each login is used:
  "Sign in with your saved login “GitHub” on github.com". This is the Work approval card
  with verb **Sign in**, body = the login's name, target = the site. The text comes from
  the server and the stored row, never from the model. The explanation says the platform
  types it and the model never sees it.

## 2. What the model sees

One tool, `computer_fill_login`, offered only when the vault is on, the run has the
agent's computer, and the agent has at least one saved login. Its description lists the
saved logins by **label and site only**. Its one input is `login`: the label, or the site
when only one login is saved for it.

It answers with fixed sentences only (`VAULT_RESULT_MESSAGE` in `vault-policy.ts`):
"Filled the login for GitHub.", or a refusal that names no value. It does not submit the
form. The model presses the sign-in button with the tools it already has, which keeps
their own approval rules. A two-step code page is a second call on that page.

## 3. How a fill works (`src/lib/computer/vault-fill.ts`)

1. **Resolve** the label among *this* agent's logins. The person's id and the agent's id
   come from the run (the server's record of whose task it is). The model never supplies
   them.
2. **Origin check (anti-phishing).** The browser's own record of the page's top-level URL
   (Playwright's main-frame URL, not anything the page says) must have **exactly** the
   saved origin: scheme, host and port. `login.github.com`, `github.com.evil.example`,
   `http://github.com`, `https://github.com:8443` and the Cyrillic `gіthub.com` are all
   refused. Only https origins can be saved. International names are stored in their
   `xn--` form, so a lookalike in another script is a different string.
3. **Approval check.** A login the person has never approved is filled only by a call
   that was put to them and approved. The host is told this per call (`approvedNow`) and
   does not trust the snapshot the risk was decided from.
4. Only now is the login **decrypted**.
5. **Fields.** If a password field is visible, it fills the username field before it in
   the same form, then the password. Otherwise, if a one-time-code field is visible, it
   fills the current TOTP code. Otherwise it fills a visible username field (a
   username-first sign-in). Only the page's main document is searched. A field is typed
   into only when `document.activeElement` is that very input, so a cross-origin frame
   never receives a value.
6. **Typing** uses CDP `Input.insertText` (`vault-page.ts`). Before each field it reads the
   takeover/lease fence and the origin again. After each field it checks them again and
   confirms the field's length (never its value).
7. It records `lastUsedAt` and, for an approved first use, `approvedAt`. The operator
   audit gets `login_filled` or `login_refused` with a reason only.

## 4. Approval

| The call | Risk | Who is asked |
|---|---|---|
| A login never approved | `sensitive` | Always, under every mode, Skip included. Never covered by "Always allow". |
| A login approved before | `command` | Follows the run's approval mode. The action `work.computer.fill_login` carries the hard-floor token `login`, so "Always allow" never covers it. |
| No such login, or the browser on another site | `safe` | Nobody. It is refused without typing anything. |

Changing a login's **site** or **username** clears its approval, so the next use asks
again. A new password or two-step secret for the same account does not.

## 5. Storage (`src/lib/computer/vault-store.ts`)

- The `AgentCredential` table (migration `20261031093517_agent_credentials`, RLS
  enabled) is owned by `userId` and `agentId`, and listed in `OWNER_COLUMN`. Every read
  filters on both.
- `usernameSealed`, `passwordSealed` and `totpSealed` are each sealed with
  `encryptSecretBound` (AES-256-GCM, keyring-versioned). The additional data is
  `juno.agent-credential.v1:<userId>:<agentId>:<rowId>:<field>`, so a ciphertext moved to
  another field, row, agent or account does not open. Listed in SECURITY.md.
  `npm run crypto:rotate` re-seals them.
- The only function that returns values is `openAgentCredentialForFill`. Only the fill
  calls it, after its checks. Route responses carry `id, label, origin, hasTotp,
  approved, createdAt, lastUsedAt`, never a value.
- Retiring an agent deletes its saved logins. Deleting the account or the agent row
  cascades.

## 6. API

| Route | Method | Notes |
|---|---|---|
| `/api/agents/[id]/credentials` | GET | `{ credentials }`, or `{ credentials: null }` with the vault off |
| `/api/agents/[id]/credentials` | POST | `{ label, origin, username, password, totpSecret? }` → `{ credential }` (the view). Rate limited, 30 per hour per account. |
| `/api/agents/[id]/credentials/[credentialId]` | PATCH | Any of the same fields; `totpSecret: null` removes it. Rate limited. |
| `/api/agents/[id]/credentials/[credentialId]` | DELETE | Works with the vault off, so a person can always remove a login. |

All are `requireUser` + `findAgent(user.id, id)` and `Cache-Control: private, no-store`.
Cookie mutations pass the middleware's Origin check (`src/lib/csrf.ts`). The routes are
classified `planned` in `contracts/parity/features.json`.

## 7. Two-step codes

These are RFC 6238 TOTP codes from the repository's own `src/lib/totp.ts` (SHA-1, six
digits, 30 seconds), generated on the server at fill time. Secrets with other parameters
are refused when saved, because only the secret is stored.
`tests/agent-vault.test.ts` checks the codes against the RFC 6238 Appendix B vectors.

## 8. Where a value can and cannot go

- **Never** into: a tool result, the model's requests (system prompt, tool descriptions,
  messages), Work events, approvals, `AgentEvent`s, the computer audit, logs, or error
  messages. A browser exception's own text is never passed on.
- **Scrubbed** from later `browser` page reads in the same run: the URL, title, HTML and
  element labels have every typed value replaced (`scrubBrowserOutcome`). Scrubbing
  helps, but it is not the boundary.
- **Known limits, said plainly:**
  - A screenshot after a fill shows what the page shows. Password fields are masked by the
    page, but the username is visible like any typed text. A page that unmasks its
    password field would show it.
  - Once filled, the values are in the page, and the site's own scripts can read them.
    That is the point of filling: the origin check is what makes that page the right one.
  - Chromium on the computer saves no passwords (`PasswordManagerEnabled: false` in
    `deploy/agent-computers/chrome-policies.json`, pinned by a test). Its ordinary form
    history may keep a typed username.

## 9. Tests

- `tests/agent-vault.test.ts`: the store over its in-memory table with the real
  `encryptSecretBound`, the fill over a stand-in page, and the tool from the built
  runtime inside a real `WorkAgentSession` driven by the scripted model. It covers: no
  value in any result, request, event, approval, audit row or log line; origin refusals
  (subdomain, parent, lookalike, scheme, port) before decryption; approval asked the first
  time, a decline types nothing, an approved login follows the mode, and a new site or
  username asks again; ownership across people and agents; RFC 6238 vectors; sealing at
  rest and binding; off without the switch or a provider.
- `runner/agent-core/src/test/computer-login-tool.test.ts`: the risk per state under
  every mode, `approvedNow`, no standing allowance, and the takeover fence.

## 10. Owner setup

1. Agent computers must already be on (`ENABLE_COMPUTERS.md`).
2. Set `AGENT_VAULT_ENABLED=1` in the app's **and** the Work runner's environment, and
   restart both.
3. Run `npx prisma migrate deploy` as usual (the migration adds one table).
4. To turn it off, unset the variable. The tool disappears from new runs, the profile
   section hides, and saved rows stay sealed until deleted.
