import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOWED_DOMAINS,
  auditEvent,
  evaluateEgress,
  hostMatches,
  normalizeHost,
  type EgressPolicy,
} from '../tools/egress-policy.js';

/*
 * The allowlist an egress proxy enforces for agent-authored commands.
 *
 * `--network=none` is the default and is not always workable — a real build
 * fetches dependencies. The wrong answer is to turn the network on, because an
 * agent with unrestricted egress can post the repository anywhere. These cover
 * the ways an allowlist gets quietly widened.
 */

const policy: EgressPolicy = { allowedDomains: ['registry.npmjs.org', '.pypi.org'] };

test('an allowlisted host is permitted', () => {
  const decision = evaluateEgress('https://registry.npmjs.org/express', policy);
  assert.equal(decision.allowed, true);
});

test('anything not on the list is refused, with a reason', () => {
  const decision = evaluateEgress('https://evil.example/exfiltrate', policy);
  assert.equal(decision.allowed, false);
  // A blocked fetch that says only "failed" sends whoever is debugging it to
  // the network stack rather than to the policy that refused.
  assert.match(decision.reason, /not on the allowlist/);
});

test('a leading dot allows subdomains, and only real ones', () => {
  assert.equal(hostMatches('files.pypi.org', '.pypi.org'), true);
  assert.equal(hostMatches('pypi.org', '.pypi.org'), true);
  // The bug a naive suffix test creates: a different party entirely.
  assert.equal(hostMatches('notpypi.org', '.pypi.org'), false);
  assert.equal(hostMatches('evilpypi.org', '.pypi.org'), false);
});

test('an exact entry does not silently cover subdomains', () => {
  assert.equal(hostMatches('registry.npmjs.org', 'registry.npmjs.org'), true);
  assert.equal(hostMatches('sub.registry.npmjs.org', 'registry.npmjs.org'), false);
});

test('a trailing dot cannot be used to slip past an exact match', () => {
  // `evil.com.` and `evil.com` resolve identically, so a string comparison
  // that keeps the dot lets the first through a list containing the second.
  assert.equal(normalizeHost('REGISTRY.NPMJS.ORG.'), 'registry.npmjs.org');
  assert.equal(evaluateEgress('https://registry.npmjs.org./x', policy).allowed, true);
});

test('case is not a way around the list', () => {
  assert.equal(evaluateEgress('https://REGISTRY.NPMJS.ORG/x', policy).allowed, true);
});

test('non-http protocols are refused', () => {
  // `file:` would read the container's disk through the proxy; the others are
  // protocol-confusion surface with no legitimate use in a build.
  for (const url of ['file:///etc/passwd', 'ftp://registry.npmjs.org/x', 'gopher://x']) {
    const decision = evaluateEgress(url, policy);
    assert.equal(decision.allowed, false, `${url} should be refused`);
  }
});

test('a URL carrying credentials is refused even to an allowed host', () => {
  // How a token reaches a log. The proxy is the last place to stop it.
  const decision = evaluateEgress('https://user:token@registry.npmjs.org/x', policy);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /credentials/);
});

test('a non-standard port is refused unless listed', () => {
  assert.equal(evaluateEgress('https://registry.npmjs.org:8443/x', policy).allowed, false);
  const wider: EgressPolicy = { ...policy, allowedPorts: [443, 8443] };
  assert.equal(evaluateEgress('https://registry.npmjs.org:8443/x', wider).allowed, true);
});

test('an unparseable URL is refused rather than passed through', () => {
  assert.equal(evaluateEgress('not a url', policy).allowed, false);
});

test('an empty allowlist permits nothing', () => {
  const decision = evaluateEgress('https://registry.npmjs.org/x', { allowedDomains: [] });
  assert.equal(decision.allowed, false);
});

test('both outcomes are audited, not only refusals', () => {
  // A run whose log shows no blocked egress could be one that never tried, or
  // one whose proxy was bypassed. Those must be distinguishable afterwards.
  const allowed = auditEvent(
    'https://registry.npmjs.org/x',
    evaluateEgress('https://registry.npmjs.org/x', policy),
  );
  assert.equal(allowed.kind, 'egress_allowed');
  assert.equal(allowed.host, 'registry.npmjs.org');

  const blocked = auditEvent(
    'https://evil.example/x',
    evaluateEgress('https://evil.example/x', policy),
  );
  assert.equal(blocked.kind, 'egress_blocked');
});

test('the audit record never carries the URL itself', () => {
  // A query string can hold a token, and an audit log is exactly the wrong
  // place for one.
  const url = 'https://evil.example/steal?token=super-secret-value';
  const event = auditEvent(url, evaluateEgress(url, policy));
  assert.ok(!JSON.stringify(event).includes('super-secret-value'));
  assert.ok(!JSON.stringify(event).includes('/steal'));
});

test('the shipped defaults are package registries and nothing else', () => {
  // A default list is the one most deployments will run with, so a general
  // host slipping into it would widen every deployment at once.
  for (const domain of DEFAULT_ALLOWED_DOMAINS) {
    assert.ok(
      /npmjs|pypi|pythonhosted|crates|golang|maven/.test(domain),
      `${domain} is not a package registry`,
    );
  }
});
