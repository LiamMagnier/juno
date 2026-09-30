import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_PERMISSION_POLICIES, DEFAULT_ACTION_PERMISSION_POLICY, decideActionPolicy } from "@/lib/action-approval";
import { actionPolicyFromSetting, appApprovalPreview } from "@/lib/chat/app-approval-preview";
import { appApprovalPreviewSchema } from "@/lib/chat/context-tokens";

/*
 * "Posting to Slack will ask you first", said before send. The preview must
 * be the broker's own decision, and it must never promise that a send, a
 * post, a delete or a payment goes through without asking: that is the
 * always-confirm floor (src/lib/action-approval.ts, src/lib/work/domain.ts).
 */

test("sending, posting and deleting ask under every policy that is not a block", () => {
  for (const policy of ACTION_PERMISSION_POLICIES) {
    for (const lockdown of [false, true]) {
      for (const blocked of [false, true]) {
        const preview = appApprovalPreview({ label: "Slack", policy, lockdown, blocked });
        assert.ok(appApprovalPreviewSchema.safeParse(preview).success, `${policy} preview parses`);
        const shutOff = lockdown || blocked || policy === "block";
        assert.equal(preview.sends, shutOff ? "block" : "ask", `${policy} lockdown=${lockdown} blocked=${blocked}`);
        assert.equal(preview.deletes, shutOff ? "block" : "ask");
      }
    }
  }
});

test("each verdict is exactly what the broker decides for that risk class", () => {
  for (const policy of ACTION_PERMISSION_POLICIES) {
    const preview = appApprovalPreview({ label: "Linear", policy, lockdown: false, blocked: false });
    assert.equal(preview.reads, decideActionPolicy({ policy, riskClass: "read_only" }));
    assert.equal(preview.changes, decideActionPolicy({ policy, riskClass: "reversible_write" }));
    assert.equal(preview.sends, decideActionPolicy({ policy, riskClass: "external_write" }));
    assert.equal(preview.deletes, decideActionPolicy({ policy, riskClass: "destructive_or_sensitive" }));
  }
});

test("the default policy asks before any change and reads freely", () => {
  const preview = appApprovalPreview({ label: "Slack", policy: DEFAULT_ACTION_PERMISSION_POLICY, lockdown: false, blocked: false });
  assert.deepEqual(
    { reads: preview.reads, changes: preview.changes, sends: preview.sends, deletes: preview.deletes },
    { reads: "allow", changes: "ask", sends: "ask", deletes: "ask" }
  );
  assert.equal(preview.summary, "Sending, posting or changing anything in Slack will ask you first.");
});

test("the summary names the rule that applies, in the person's words", () => {
  const say = (policy: (typeof ACTION_PERMISSION_POLICIES)[number], extra: { lockdown?: boolean; blocked?: boolean } = {}) =>
    appApprovalPreview({ label: "Slack", policy, lockdown: !!extra.lockdown, blocked: !!extra.blocked }).summary;
  assert.equal(say("ask_for_important_actions"), "Sending, posting or deleting in Slack will ask you first. Changes you can undo won't.");
  assert.equal(say("always_ask"), "Juno will ask you before anything it does in Slack, even reading.");
  assert.equal(say("block"), "Your approval settings stop Juno acting in apps, so it won't use Slack.");
  assert.equal(say("ask_for_any_change", { blocked: true }), "Slack is turned off in Settings, so Juno won't use it.");
  assert.equal(say("ask_for_any_change", { lockdown: true }), "Lockdown is on, so Juno won't use Slack.");
});

test("a stored policy the broker does not know reads as the broker's default", () => {
  assert.equal(actionPolicyFromSetting(null), DEFAULT_ACTION_PERMISSION_POLICY);
  assert.equal(actionPolicyFromSetting("allow_everything"), DEFAULT_ACTION_PERMISSION_POLICY);
  assert.equal(actionPolicyFromSetting("always_ask"), "always_ask");
});

test("a long or multi-line app label stays one short line in the summary", () => {
  const preview = appApprovalPreview({
    label: `My\nvery ${"long ".repeat(30)}server`,
    policy: "ask_for_any_change",
    lockdown: false,
    blocked: false,
  });
  assert.ok(!preview.summary.includes("\n"));
  assert.ok(preview.summary.length <= 300);
});
