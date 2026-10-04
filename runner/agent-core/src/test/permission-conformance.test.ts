import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  actionRiskOf,
  ladderRuling,
  mayGrantAlways,
  permissionRuling,
  unattendedApprovalAnswer,
} from '../permissions.js';
import {
  HARD_FLOOR_TOKENS,
  WORK_PERMISSION_POLICIES,
  approvalAsksUnder,
  mayHoldStandingAllowance,
  type WorkRiskLevel,
} from '../work/types.js';
import type { PermissionMode, RiskLevel } from '../types.js';

/*
 * The shared permission contract (BRIEF §6), read by this runtime:
 * contracts/permissions/permission-taxonomy.v1.json. The web/server side runs
 * the same cases in tests/permission-conformance.test.ts and the Mac in
 * PermissionConformanceTests.swift, so no runtime can loosen a floor without
 * a failing test in its own language.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const contractPath = [
  path.resolve(here, '../../../../contracts/permissions/permission-taxonomy.v1.json'),
  path.resolve(here, '../../../contracts/permissions/permission-taxonomy.v1.json'),
].find((candidate) => fs.existsSync(candidate));

interface Case {
  runtime: string;
  action?: string;
  risk?: string;
  expect: { tier: string; asksUnderEveryMode: boolean; standing: boolean };
}

if (!contractPath) {
  test('permission contract is not vendored with this build', { skip: true }, () => {});
} else {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as {
    hardFloorTokens: Record<string, string[]>;
    runtimeRiskTiers: Record<string, Record<string, string>>;
    cases: Case[];
  };

  test('the runner copy of the hard-floor tokens matches the contract', () => {
    assert.deepEqual(HARD_FLOOR_TOKENS, contract.hardFloorTokens);
  });

  test('Work runner gate: every contract case', () => {
    for (const c of contract.cases.filter((c) => c.runtime === 'work')) {
      const risk = c.risk as WorkRiskLevel;
      assert.equal(contract.runtimeRiskTiers.work[risk], c.expect.tier, c.action);
      const asksEverywhere = WORK_PERMISSION_POLICIES.every((policy) => approvalAsksUnder(c.action!, risk, policy));
      assert.equal(asksEverywhere, c.expect.asksUnderEveryMode, `${c.action}: asks under every mode`);
      assert.equal(mayHoldStandingAllowance(c.action!, risk), c.expect.standing, `${c.action}: standing`);
    }
  });

  test('Code cloud ladder: every contract case, and the unattended answer holds the floor', () => {
    const modes: PermissionMode[] = ['plan', 'ask', 'auto-edit', 'full'];
    for (const c of contract.cases.filter((c) => c.runtime === 'code_runner')) {
      const risk = c.risk as RiskLevel;
      assert.equal(contract.runtimeRiskTiers.code_runner[risk], c.expect.tier);
      const asksEverywhere = modes.every((mode) => ladderRuling(mode, actionRiskOf(risk)) !== 'allow');
      assert.equal(asksEverywhere, c.expect.asksUnderEveryMode, `${risk}: asks under every mode`);
      assert.equal(mayGrantAlways(risk), c.expect.standing, `${risk}: standing`);
      // An allow rule (owner-written or "always") never silences the floor.
      if (c.expect.asksUnderEveryMode) {
        for (const mode of modes) {
          assert.notEqual(
            permissionRuling(mode, actionRiskOf(risk), { decision: 'allow', rule: { toString: () => 'Bash' } } as never),
            'allow',
            `${risk} under ${mode} with an allow rule`,
          );
          assert.equal(unattendedApprovalAnswer(mode, risk), 'deny', `${risk} unattended under ${mode}`);
        }
      }
    }
    assert.equal(unattendedApprovalAnswer('full', 'command'), 'allow', 'Full access still means full access below the floor');
    assert.equal(unattendedApprovalAnswer('auto-edit', 'command'), 'deny');
  });
}
