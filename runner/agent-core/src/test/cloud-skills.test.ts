/**
 * Skills on a cloud run: the account's skills (instructions from
 * runner-context) and the cloned repository's own `.alevr/skills`,
 * `.juno/skills` and `.claude/skills`, found by the env server's rules and
 * injected into the engine's system prompt, exactly as the Mac's Alevr engine
 * does. No home folders are read on a runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { cloudSkillsNotice, readCloudSkillRequest, resolveCloudSkills } from '../skills/cloud.js';
import { PROJECT_SKILL_DIRS } from '../skills/skill-parse.js';
import { done, scriptedProvider } from './fake-provider.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `alevr-cloud-skills-${prefix}-`));
}

function writeSkill(root: string, folder: string, frontMatter: string, body: string): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\n${frontMatter}\n---\n\n${body}\n`);
  return file;
}

/** A cloned repository with skills in all three project folders. */
function clone(): string {
  const repo = tmp('repo');
  writeSkill(path.join(repo, '.alevr', 'skills'), 'repo-rules', 'name: repo-rules\ndescription: How this repo works', 'ALEVR RULES BODY');
  writeSkill(path.join(repo, '.juno', 'skills'), 'release', 'description: Cut a release', 'JUNO RELEASE BODY');
  writeSkill(path.join(repo, '.claude', 'skills'), 'repo-rules', 'name: repo-rules\ndescription: shadowed', 'CLAUDE SHADOWED BODY');
  writeSkill(path.join(repo, '.claude', 'skills'), 'testing', 'name: testing\ndescription: Write tests', 'CLAUDE TESTING BODY');
  return repo;
}

test('cloud skills: the repository folders, nearest first, are the env server\'s', () => {
  assert.deepEqual(PROJECT_SKILL_DIRS.map((d) => d.dir), ['.alevr/skills', '.juno/skills', '.claude/skills']);
});

test('cloud skills: account instructions and the repository\'s chosen skills are resolved; the nearest copy wins', async () => {
  const repo = clone();
  const skills = await resolveCloudSkills(repo, {
    account: [{ name: 'tidy-commits', title: 'Tidy commits', instructions: 'ACCOUNT TIDY BODY' }],
    project: ['repo-rules', 'testing', 'ghost'],
  });
  assert.deepEqual(skills.applied.map((s) => `${s.source}:${s.name}`), ['account:tidy-commits', 'project:repo-rules', 'project:testing']);
  assert.deepEqual(skills.missing, ['ghost']);
  assert.match(skills.text, /ACCOUNT TIDY BODY/);
  assert.match(skills.text, /ALEVR RULES BODY/, '.alevr/skills beats .claude/skills');
  assert.doesNotMatch(skills.text, /CLAUDE SHADOWED BODY/);
  assert.match(skills.text, /CLAUDE TESTING BODY/);
  assert.doesNotMatch(skills.text, /JUNO RELEASE BODY/, 'only chosen skills apply');
  assert.match(skills.text, /<skill name="repo-rules" folder="[^"]+\.alevr\/skills\/repo-rules">/);
  assert.deepEqual(skills.available.map((s) => s.name).sort(), ['release', 'repo-rules', 'testing']);
  assert.equal(cloudSkillsNotice(skills), 'Running with skills Tidy commits, repo-rules, testing. Not found in this repository or your library: ghost.');
});

test('cloud skills: no home folder is read on a runner', async () => {
  const repo = clone();
  const home = tmp('home');
  writeSkill(path.join(home, '.claude', 'skills'), 'home-only', 'name: home-only\ndescription: x', 'HOME BODY');
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const skills = await resolveCloudSkills(repo, { project: ['home-only'] });
    assert.deepEqual(skills.applied, []);
    assert.deepEqual(skills.missing, ['home-only']);
    assert.ok(!skills.available.some((s) => s.name === 'home-only'));
  } finally {
    process.env.HOME = prev;
  }
});

test('cloud skills: runner-context\'s field is validated; nothing asked for is nothing applied', async () => {
  assert.deepEqual(readCloudSkillRequest(undefined), {});
  assert.deepEqual(readCloudSkillRequest({ account: [{ name: 'a' }, { name: 'b', instructions: 'B', title: 7 }, 'x'], project: ['p', '', 3] }), {
    account: [{ name: 'b', instructions: 'B' }],
    project: ['p'],
  });
  const none = await resolveCloudSkills(clone(), {});
  assert.equal(none.text, '');
  assert.equal(cloudSkillsNotice(none), null);
});

test('cloud skills: the engine carries them in its system prompt on every model call', async () => {
  const repo = clone();
  process.env.JUNO_HOME = tmp('juno-home');
  const skills = await resolveCloudSkills(repo, {
    account: [{ name: 'tidy-commits', instructions: 'ACCOUNT TIDY BODY' }],
    project: ['testing'],
  });
  const provider = scriptedProvider('p', () => [{ type: 'text_delta', text: 'ok' }, done()]);
  const session = AgentSession.create({
    provider,
    cwd: repo,
    mode: 'full',
    userSettingsFile: null,
    systemAppendix: skills.text,
    callbacks: { onEvent: () => undefined, requestApproval: async () => 'allow' },
  });
  await session.prompt('Add a test for the parser');
  await session.prompt('And another');
  assert.equal(provider.requests.length, 2);
  for (const req of provider.requests) {
    assert.match(String(req.system), /ACCOUNT TIDY BODY/);
    assert.match(String(req.system), /CLAUDE TESTING BODY/);
    assert.match(String(req.system), /The user turned on skills for this work: tidy-commits, testing\./);
  }
  const lastUser = JSON.stringify(provider.requests[0].messages.at(-1));
  assert.doesNotMatch(lastUser, /ACCOUNT TIDY BODY/, 'the message itself is untouched');
});
