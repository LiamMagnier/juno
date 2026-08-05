import assert from "node:assert/strict";
import test from "node:test";

import { DesignAiError, parseDesignProposal, previewProposal } from "../src/lib/design/ai";
import { buildDesignEditPrompt } from "../src/lib/design/ai";
import { buildDocumentSummary, buildSelectionContext } from "../src/lib/design/selection-context";
import { applyTransaction, invertTransaction } from "../src/lib/design/operations";
import { PAGE_ID, run, signInDocument, withTokens } from "./design-fixtures";

function block(payload: unknown): string {
  return `Sure — here's the change.\n\n<juno:design-ops>\n${JSON.stringify(payload)}\n</juno:design-ops>`;
}

test("a well-formed proposal parses out of surrounding prose", () => {
  const proposal = parseDesignProposal(
    block({
      summary: "Rounded the button.",
      baseRevision: 1,
      operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }],
    })
  );
  assert.equal(proposal.summary, "Rounded the button.");
  assert.equal(proposal.operations.length, 1);
});

test("a missing, malformed, or unusable block is refused honestly", () => {
  assert.throws(() => parseDesignProposal("I changed the button for you!"), /did not return any design operations/);
  assert.throws(() => parseDesignProposal("<juno:design-ops>{nope}</juno:design-ops>"), /not valid JSON/);
  assert.throws(
    () => parseDesignProposal(block({ summary: "x", baseRevision: 1, operations: [{ op: "rmrf", path: "/" }] })),
    DesignAiError
  );
  assert.throws(() => parseDesignProposal(block({ summary: "x", baseRevision: 1, operations: [] })), DesignAiError);
});

test("a proposal built against a stale revision is refused, not rebased", () => {
  const doc = signInDocument();
  const proposal = parseDesignProposal(
    block({ summary: "x", baseRevision: 0, operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }] })
  );
  assert.throws(
    () => previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z" }),
    /changed while Juno was working/
  );
});

test("preview does not mutate the document it previews", () => {
  const doc = signInDocument();
  const before = JSON.stringify(doc);
  const proposal = parseDesignProposal(
    block({ summary: "Rounded", baseRevision: 1, operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }] })
  );
  const preview = previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z" });

  assert.equal(JSON.stringify(doc), before, "rejecting must leave the real document untouched");
  assert.equal(preview.result.document.nodes["button"].cornerRadius, 12);
  assert.equal(preview.result.document.revision, 2);
});

test("an out-of-scope proposal is rejected before the user can apply it", () => {
  const doc = signInDocument();
  const proposal = parseDesignProposal(
    block({
      summary: "Rounded the button and shrank the field",
      baseRevision: 1,
      operations: [
        { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
        { op: "updateNode", nodeId: "email", patch: { height: 20 } },
      ],
    })
  );
  assert.throws(
    () => previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z", scopeTo: ["button"] }),
    /outside your selection/
  );
});

test("an in-scope proposal covering the selection's own subtree is allowed", () => {
  const doc = signInDocument();
  const proposal = parseDesignProposal(
    block({
      summary: "Restyled the button",
      baseRevision: 1,
      operations: [
        { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
        { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Continue" } },
      ],
    })
  );
  const preview = previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z", scopeTo: ["button"] });
  assert.equal(preview.result.touchedNodeIds.length, 2);
});

test("an applied Juno transaction reverts in one step", () => {
  const doc = signInDocument();
  const proposal = parseDesignProposal(
    block({
      summary: "Rounded the button and added a spring hover",
      baseRevision: 1,
      operations: [
        { op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } },
        {
          op: "createAnimation",
          animation: {
            id: "anim-hover",
            name: "Hover scale",
            durationMs: 220,
            loop: false,
            tracks: [
              {
                nodeId: "button",
                property: "scale",
                keyframes: [
                  { time: 0, value: 1, easing: { type: "spring", stiffness: 320, damping: 22, mass: 1 } },
                  { time: 220, value: 1.03, easing: { type: "spring", stiffness: 320, damping: 22, mass: 1 } },
                ],
              },
            ],
          },
        },
      ],
    })
  );
  const preview = previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z", scopeTo: ["button"] });
  const applied = preview.result.document;
  assert.equal(applied.animations["anim-hover"].tracks[0].keyframes[1].value, 1.03);

  const reverted = applyTransaction(applied, invertTransaction(preview.result, preview.transaction, "2026-01-01T00:00:01.000Z"));
  assert.equal(reverted.document.nodes["button"].cornerRadius, 8);
  assert.equal(reverted.document.animations["anim-hover"]?.tracks.length ?? 0, 0);
});

test("the change review names the fields that actually moved", () => {
  const doc = signInDocument();
  const proposal = parseDesignProposal(
    block({
      summary: "Rounded the button",
      baseRevision: 1,
      operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12, opacity: 0.9 } }],
    })
  );
  const preview = previewProposal(doc, proposal, { transactionId: "t1", now: "2026-01-01T00:00:00.000Z" });
  assert.equal(preview.changes.length, 1);
  assert.match(preview.changes[0], /^Sign in button: /);
  assert.match(preview.changes[0], /cornerRadius 8 → 12/);
  assert.match(preview.changes[0], /opacity 1 → 0\.9/);
});

test("adjustments must bind to a validated property", () => {
  assert.throws(
    () =>
      parseDesignProposal(
        block({
          summary: "x",
          baseRevision: 1,
          operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }],
          adjustments: [{ control: "slider", label: "Anything", nodeIds: ["button"], property: "eval", min: 0, max: 1, step: 1, value: 0 }],
        })
      ),
    DesignAiError
  );

  const ok = parseDesignProposal(
    block({
      summary: "x",
      baseRevision: 1,
      operations: [{ op: "updateNode", nodeId: "button", patch: { cornerRadius: 12 } }],
      adjustments: [{ control: "slider", label: "Corner radius", nodeIds: ["button"], property: "cornerRadius", min: 0, max: 32, step: 1, value: 12 }],
    })
  );
  assert.equal(ok.adjustments?.length, 1);
});

// ---------------------------------------------------------------------------
// Selection context
// ---------------------------------------------------------------------------

test("selection context carries stable ids, computed frames, and the revision", () => {
  const doc = withTokens(signInDocument());
  const context = buildSelectionContext(doc, PAGE_ID, ["button"]);

  assert.equal(context.revision, doc.revision);
  assert.deepEqual(context.selectedNodeIds, ["button"]);
  assert.equal(context.selection[0].id, "button");
  assert.equal(context.selection[0].frame.width, 279, "the frame is the laid-out size, not the authored one");
  assert.deepEqual(context.ancestors.map((a) => a.id), ["card", "screen"]);
  assert.ok(context.siblings.some((s) => s.id === "email"));
  assert.ok(context.variables.some((v) => v.name === "primary"));
  assert.ok(context.previewImage?.startsWith("data:image/svg+xml;base64,"));
});

test("the whole document is not sent when a small selection will do", () => {
  const doc = signInDocument();
  const context = buildSelectionContext(doc, PAGE_ID, ["button"]);
  const serialized = JSON.stringify({ ...context, previewImage: null });
  assert.ok(!serialized.includes('"Welcome back"'), "an unrelated sibling's text is not shipped");
  assert.equal(context.documentNodeCount, 6, "but the model is told the document is bigger");
});

test("the compact subtree is depth- and size-bounded", () => {
  const doc = signInDocument();
  const shallow = buildSelectionContext(doc, PAGE_ID, ["screen"], { depth: 1, includeImage: false });
  const card = shallow.selection[0].children?.[0];
  assert.equal(card?.id, "card");
  assert.equal(card?.children, undefined, "depth 1 stops below the first level");
  assert.equal(card?.truncatedChildren, 3, "and says how much it withheld");
});

test("bound variables are reported with their resolved value", () => {
  const doc = run(withTokens(signInDocument()), [
    { op: "bindVariable", nodeId: "button", property: "fills.0.color", variableId: "var-primary" },
  ]).document;
  const context = buildSelectionContext(doc, PAGE_ID, ["button"], { includeImage: false });
  assert.deepEqual(context.selection[0].boundVariables?.["fills.0.color"], {
    id: "var-primary",
    name: "primary",
    value: "#334de6",
  });
});

test("the document summary describes structure without dumping it", () => {
  const summary = buildDocumentSummary(withTokens(signInDocument()));
  assert.equal(summary.nodeCount, 6);
  assert.equal(summary.pages[0].topLevel[0].id, "screen");
  assert.equal(summary.collections[0].name, "Theme");
  assert.deepEqual(summary.collections[0].modes, ["Light", "Dark"]);
  assert.equal(summary.collections[0].activeMode, "Light");
});

test("the prompt states the exact revision and the scope rule", () => {
  const doc = signInDocument();
  const context = buildSelectionContext(doc, PAGE_ID, ["button"], { includeImage: false });
  const prompt = buildDesignEditPrompt({ identifier: "sign-in", title: "Sign in", version: 1 }, doc, context, { scoped: true });

  assert.match(prompt, /"baseRevision":1/);
  assert.match(prompt, /Change ONLY the selected nodes/);
  assert.match(prompt, /<juno:design-ops>/);
  assert.ok(prompt.includes('"button"'));

  const unscoped = buildDesignEditPrompt({ identifier: "sign-in", title: "Sign in", version: 1 }, doc, null, { scoped: false });
  assert.match(unscoped, /no selection was made/);
});
