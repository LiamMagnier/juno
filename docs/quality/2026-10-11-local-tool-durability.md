# Durable Chat folder-call receipts

Baseline: `58cd3739d283088491fc67be710fb8f1c92e267f`. The backend kept local
folder calls in a process-global Map. A reply reaching another server process or
arriving after a backend restart could not find the call. Repeating a call id
could replace its waiter. This change is stacked on PRs #83 and #84.

## Implementation

Use the existing Prisma database and rotating authenticated-encryption registry,
with a small `ChatLocalToolCall` receipt table. Persist pending identity before
emitting a local-tool request. Account, generation and call identity bind both
queries and encrypted result data. Atomic conditional updates give a pending
call exactly one terminal result. Identical response retries succeed; conflicting
results, wrong owners/generations, cancellation and expiration refuse. Existing
native callers may omit generationId; account and unpredictable call id remain
mandatory. The table is included in the database ownership guard and key-rotation
script, with an additive migration and cascading account deletion.

The waiter polls durable receipts; it never redispatches a call after an uncertain
failure. Database failures, cancellation and timeouts explicitly report an unknown
operation outcome. They do not claim to undo work on the Mac. Outputs are bounded
at 60,000 characters and encrypted with call-bound AAD; document text and plaintext
digests are not persisted. When creating a call, account-scoped cleanup removes
receipts whose execution window ended over 24 hours ago.

## Verification

Node 24.20.0, Prisma 6, disposable PostgreSQL 16; fixture accounts and content only.
No production database, credentials or real documents were modified.

- Full web suite: 6,965 discovered, 6,842 passed, 123 skipped, zero failures.
  Auth, crypto, moderation, skill-package and custom-MCP checks also passed.
- TypeScript check and lint of changed TypeScript files passed.
- 19 local-folder lifecycle/tool tests and seven database ownership-guard tests
  passed. These cover insertion/abort races, duplicate refusal before dispatch,
  unavailable storage, response conflicts, identity, expiry and cancellation.
- Exact migration replay passed against a fresh disposable database. Integration
  tests launched separate Node processes to deliver and recover a result; a fresh
  process recovered the stored result after the original process exited. Conflicting
  concurrent responses had exactly one winner. Wrong owner/generation, late terminal
  replies and duplicate insertion refused. Plaintext absence and ciphertext transfer
  to another call were tested; transfer failed authenticated decryption.
- The same real-database suite is required in the existing CI migration job and
  in local-gates.sh's disposable migration path; no environment bypass was added.

Raw local logs: `/tmp/alevr-quality-evidence/local-tool-web-suite.log`,
`local-tool-ownership.log`, `local-tool-typecheck-complete.log`,
`local-tool-lint.log`, `local-tool-db-final.log`. Hosted results remain pending.

## Scope and remaining acceptance

This is durable result handoff, not automatic resurrection of an SSE generation
or a Mac action after a client crash. It does not provide a persistent Mac-side
execution journal: operation-level duplicate prevention after Mac app restart
still needs acceptance work. Stopping the reply alone cannot prove the Mac stopped;
PR #84 separately covers native revocation and in-flight command cancellation.
Cleanup runs on the next call for that account, not a background timer. Physical
iPhone reconnect, sleep/wake, and the flagship cross-device scenario remain untested.
Key-rotation integration follows the existing account-bound rotation utility; no
production rotation or migration was executed.
