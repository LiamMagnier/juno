import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestCandidate,
  candidatesForIntent,
  evaluateTier,
  tierPromptSection,
} from '../work/tier.js';
import type { WorkToolCandidate, WorkToolDefinition } from '../work/types.js';

/*
 * The tool-selection hierarchy, enforced.
 *
 * The rule is refusal, not preference, and every test here is about that
 * distinction. A preference is a hint the model may decline; asked to archive
 * a thread, a model that finds the connector fiddly will take a screenshot and
 * click, and the run is then slower, less reliable, needs screen-recording
 * permission it did not need, and has put the user's inbox in an image.
 *
 * The second thing under test is the escape hatch that keeps the rule from
 * becoming a trap: an expired connector is still tier 1, and refusing the
 * browser because of it would leave the run unable to work at all.
 */

const connector: WorkToolCandidate = { tool: 'gmail_archive', tier: 'connector', healthy: true };
const browser: WorkToolCandidate = { tool: 'browser_click', tier: 'browser_dom', healthy: true };
const visual: WorkToolCandidate = { tool: 'screen_click', tier: 'visual', healthy: true };

test('the highest-tier tool available is permitted', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'gmail_archive',
    candidates: [connector, browser, visual],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.tier, 1);
});

test('a lower tier is refused outright while a higher one is available', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'screen_click',
    candidates: [connector, browser, visual],
  });
  assert.equal(decision.allowed, false);
  // The refusal has to name the tool to use instead; "denied" alone tells the
  // model nothing it can act on and it retries the same thing.
  assert.match(decision.reason, /gmail_archive/);
  assert.equal(decision.allowed === false ? decision.better?.tool : undefined, 'gmail_archive');
  assert.equal(decision.allowed === false ? decision.better?.tier : undefined, 1);
});

test('the refusal is one tier down as well as five', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'browser_click',
    candidates: [connector, browser],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /gmail_archive/);
});

test('an unhealthy higher tier does not block the lower one', () => {
  // A connector whose token expired must not leave the run with no way to do
  // the work at all.
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'browser_click',
    candidates: [
      { ...connector, healthy: false, unhealthyReason: 'the Gmail connection needs reconnecting' },
      browser,
    ],
  });
  assert.equal(decision.allowed, true);
  // And the user is told why the better tool was skipped, rather than silently
  // getting the browser.
  assert.match(decision.reason, /gmail_archive/);
  assert.match(decision.reason, /unavailable/);
});

test('an unhealthy chosen tool is refused, pointing at what does work', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'gmail_archive',
    candidates: [
      { ...connector, healthy: false, unhealthyReason: 'the Gmail connection needs reconnecting' },
      browser,
    ],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /needs reconnecting/);
  assert.equal(decision.allowed === false ? decision.better?.tool : undefined, 'browser_click');
});

test('a tool that never declared the intent cannot be used for it', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'shell_run',
    candidates: [connector, browser],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /has not declared/);
});

test('a tool on no tier is refused rather than assumed safe', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'mystery_tool',
    // The cast is the point of the test: this is what a typo in a tool
    // definition looks like at runtime, and it must fail closed.
    candidates: [{ tool: 'mystery_tool', tier: 'teleport' as never, healthy: true }],
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not on any tier/);
});

test('the sole candidate for an intent is permitted whatever its tier', () => {
  const decision = evaluateTier({
    intent: 'repo.build',
    chosen: 'shell_run',
    candidates: [{ tool: 'shell_run', tier: 'shell', healthy: true }],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.tier, 6);
});

test('two tools on the same tier do not refuse each other', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'outlook_archive',
    candidates: [connector, { tool: 'outlook_archive', tier: 'connector', healthy: true }],
  });
  assert.equal(decision.allowed, true);
});

test('a refusal carries an audit intent the caller can write verbatim', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'screen_click',
    candidates: [connector, visual],
  });
  assert.equal(decision.allowed, false);
  const audit = decision.allowed === false ? decision.audit : null;
  assert.equal(audit?.kind, 'tier_downgrade_refused');
  assert.equal(audit?.severity, 'refusal');
  assert.deepEqual(audit?.detail, {
    intent: 'email.archive',
    chosen: 'screen_click',
    chosenTier: 5,
    better: 'gmail_archive',
    betterTier: 1,
  });
});

test('an unknown tier is recorded as 0, not as MAX_SAFE_INTEGER', () => {
  // toolTier returns MAX_SAFE_INTEGER so comparisons sort it last, which is
  // right for the comparison and reads as corruption in a stored row.
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'mystery_tool',
    candidates: [{ tool: 'mystery_tool', tier: 'teleport' as never, healthy: true }],
  });
  const audit = decision.allowed === false ? decision.audit : null;
  assert.equal(audit?.detail.chosenTier, 0);
});

test('the audit detail carries identifiers only, never the tool input', () => {
  const decision = evaluateTier({
    intent: 'email.archive',
    chosen: 'screen_click',
    candidates: [connector, visual],
  });
  const audit = decision.allowed === false ? decision.audit : null;
  for (const value of Object.values(audit?.detail ?? {})) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  }
  assert.deepEqual(Object.keys(audit?.detail ?? {}).sort(), [
    'better',
    'betterTier',
    'chosen',
    'chosenTier',
    'intent',
  ]);
});

test('bestCandidate ignores unhealthy tools entirely', () => {
  assert.equal(bestCandidate([{ ...connector, healthy: false }, browser])?.tool, 'browser_click');
  assert.equal(bestCandidate([{ ...connector, healthy: false }]), undefined);
});

function toolStub(
  name: string,
  tier: WorkToolDefinition['tier'],
  intents: string[],
  healthy: boolean,
): WorkToolDefinition {
  return {
    spec: { name, description: name, inputSchema: {} },
    kind: 'command',
    tier,
    intents,
    intentFor: () => intents[0] ?? '',
    actionFor: () => `work.test.${name}`,
    riskFor: () => 'safe',
    provenanceFor: () => ({
      source: name,
      sourceKind: 'connector',
      action: `work.test.${name}`,
      trust: 'trusted',
    }),
    isHealthy: () => healthy,
    execute: async () => ({ output: '' }),
    summarize: () => name,
  };
}

test('candidacy comes from declared intents, and health is asked per call', () => {
  const tools = [
    toolStub('gmail_archive', 'connector', ['email.archive'], false),
    toolStub('browser_click', 'browser_dom', ['email.archive', 'web.click'], true),
    toolStub('shell_run', 'shell', ['repo.build'], true),
  ];
  const candidates = candidatesForIntent(tools, 'email.archive');
  assert.deepEqual(
    candidates.map((c) => [c.tool, c.healthy]),
    [
      ['gmail_archive', false],
      ['browser_click', true],
    ],
  );
  assert.equal(
    evaluateTier({ intent: 'email.archive', chosen: 'browser_click', candidates }).allowed,
    true,
  );
});

test('the prompt section states the rule as enforcement, not advice', () => {
  const section = tierPromptSection();
  assert.match(section, /1\. Connected app/);
  assert.match(section, /6\. Shell/);
  assert.match(section, /enforced, not advised/);
});
