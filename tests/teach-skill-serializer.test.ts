import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { admitSkillDraft, skillDraftKey } from "@/lib/skills/teach";
import { skillDraftActivity } from "@/lib/chat/skill-draft-tool";

/**
 * A chat's skill draft card survives a reload: the reply's activity is stored
 * sealed (`encryptJsonField`, as `turn/persist.ts` writes it), and
 * `serializeMessage` rebuilds it from a field whitelist, so a field written
 * live and not read back would stream, then vanish. A row that does not match
 * the draft shape is dropped from that event, never handed to the card.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/teach-skill-serializer.test.ts
 *
 * `serializers.ts` is server-only, so without the react-server condition the
 * suite says why it skipped rather than failing on the import.
 */

const reactServer = [process.env.NODE_OPTIONS ?? "", ...process.execArgv].some((arg) => arg.includes("react-server"));

if (!reactServer) {
  test("the skill draft serializer suite needs NODE_OPTIONS=--conditions=react-server", { skip: true }, () => {});
} else {
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;

  const NOW = new Date("2026-10-25T10:00:00Z");
  const admission = admitSkillDraft(
    {
      name: "File the monthly invoices",
      whenToUse: "When I ask to file invoices for a month.",
      steps: ["Open the Invoices label in Gmail.", "Download each PDF."],
      inputs: [{ name: "Month", description: "Which month", required: true }],
      tools: ["web_search"],
      apps: ["Gmail"],
      questions: ["Which Drive folder holds the months?"],
    },
    {
      key: skillDraftKey("m1", 0),
      now: NOW,
      conversationId: "c1",
      connectors: [{ id: "composio:gmail", label: "Gmail" }],
      observed: { tools: ["web_search"], apps: [] },
      untrusted: true,
    }
  );
  if (!admission.ok) throw new Error(admission.message);
  const draft = admission.draft;

  const row = (activity: unknown) => ({
    id: "msg-1",
    conversationId: "c1",
    role: "ASSISTANT",
    content: "Drafted it: review the card below.",
    reasoning: null,
    reasoningParts: null,
    model: null,
    feedback: null,
    createdAt: NOW,
    attachments: [],
    sources: null,
    activity,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });

  test("serializeMessage brings a sealed skill draft back exactly as it was drafted", async () => {
    const { serializeMessage } = await import("@/lib/serializers");
    const { encryptJsonField } = await import("@/lib/field-crypto");
    const live = { id: "a1", createdAt: NOW.toISOString(), ...skillDraftActivity(draft) };
    const sealed = encryptJsonField(JSON.parse(JSON.stringify([live])));
    assert.ok(sealed && "enc" in sealed, "stored sealed, as persist.ts writes it");

    const reloaded = await serializeMessage(row(sealed) as never);
    const event = reloaded.activity?.find((e) => e.id === "a1");
    assert.ok(event, "the row survives");
    assert.equal(event.kind, "tool");
    assert.equal(event.title, "Drafted a skill");
    assert.deepEqual(event.skillDraft, draft, "every field of the draft, the outside-content mark included");
  });

  test("a malformed draft is dropped from its event, and the event itself still loads", async () => {
    const { serializeMessage } = await import("@/lib/serializers");
    const reloaded = await serializeMessage(
      row([
        { id: "a2", kind: "tool", title: "Drafted a skill", createdAt: NOW.toISOString(), skillDraft: { key: "k", name: "No steps", steps: [] } },
        { id: "a3", kind: "tool", title: "Drafted a skill", createdAt: NOW.toISOString(), skillDraft: "not an object" },
      ]) as never
    );
    assert.deepEqual(
      reloaded.activity?.map((e) => [e.id, e.skillDraft === undefined]),
      [
        ["a2", true],
        ["a3", true],
      ]
    );
  });
}
