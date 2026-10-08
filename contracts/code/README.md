# Alevr Code v2 contracts

Shared seam for every Code v2 lane (docs/code-v2/SPEC.md §6). Edit additively only.

| What | Where |
| --- | --- |
| Source of truth (TS types, value arrays, helpers) | `src/lib/code-v2/contracts.ts` |
| Runner copy (byte-identical, agent-core builds standalone) | `runner/agent-core/src/contracts/code-v2.ts`, exported as `codeV2` from `@juno/agent-core` |
| JSON Schema (generated) | `contracts/code/alevr-code-v2.schema.json` |
| Fixtures (`{"$def": <definition>, "cases": [...]}`) | `contracts/code/fixtures/*.json` |
| Swift Codable mirror (`CodeV2.*`) | `native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2Contracts.swift` |

Workflow:

1. Edit `src/lib/code-v2/contracts.ts`.
2. If you added a field or union member, add it to the schema builder in `scripts/check-code-v2-contracts.mjs`, to the Swift mirror, and to a fixture.
3. `npm run code-v2:contracts` rewrites the runner copy and the schema; `npm run code-v2:contracts:check` fails on any drift (runner copy, schema, fixture validity and coverage of every item kind / command / event, Swift enum raw values marked `// contract: NAME`, alias table).
4. Tests: `tsx --test tests/code-v2-contracts.test.ts`; `swift test --filter CodeV2ContractsTests` in `native/Packages/JunoCode`.

Wire rules (summary of SPEC §3.1, spelled out in the TS file): one WebSocket or stdio stream of JSON; every `ClientCommand {id,type,params}` gets exactly one `ServerResponse`; session events carry a gap-free per-session `sequence`; `session.open` without `afterSequence` sends `session.snapshot` (sequence = snapshotSequence) then live events; clients apply an event iff `sequence === cursor + 1` (`classifyEvent` / `CodeV2.classify`), drop duplicates and re-open with `afterSequence = cursor` on a gap. Text deltas are coalesced into ≤ 50 ms batches.
