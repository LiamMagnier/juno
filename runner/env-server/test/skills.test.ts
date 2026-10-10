/**
 * Skills lane: SKILL.md parsing, discovery across project, user and plugin
 * folders with project > user > plugin precedence, the watched cache,
 * `skills.list` (names, descriptions, paths; never bodies), and activation on
 * every engine: Alevr's engine takes the skill in its system prompt, Claude,
 * Codex and ACP agents get it ahead of the message. A thread keeps its
 * selection; a `/name` (once) skill applies to one message only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { AlevrEngine, EngineSession, EngineSessionOptions } from "../src/providers/alevr.js";
import type { LocalSkillSummary, ModelSelection, TurnItem } from "../src/contracts/code-v2.js";
import {
  SkillCatalog,
  dedupeSkills,
  discoverAll,
  parseSkillFile,
  renderSkillInstructions,
  resolveSkillActivations,
  skillName,
  skillRoots,
  toSummaries,
} from "../src/skills/discovery.js";
import { TestClient, fakeBinDir, fakeClaudeQuery, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
const catalogs: SkillCatalog[] = [];
after(async () => {
  for (const c of clients) c.close();
  for (const c of catalogs) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

function writeSkill(root: string, folder: string, frontMatter: string, body: string): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\n${frontMatter}\n---\n\n${body}\n`);
  return file;
}

/** A home with user, Codex and plugin skills, and a project with its own. */
function fixtureMac() {
  const home = tempDir("home");
  const cwd = tempDir("proj");
  writeSkill(path.join(home, ".claude", "skills"), "design-taste-frontend", "name: design-taste-frontend\ndescription: Anti-slop frontend.", "USER TASTE BODY");
  writeSkill(path.join(home, ".claude", "skills"), "shared", "name: shared\ndescription: user copy", "USER SHARED BODY");
  writeSkill(path.join(home, ".codex", "skills"), "codex-only", "name: codex-only\ndescription: From Codex", "CODEX BODY");
  writeSkill(path.join(cwd, ".claude", "skills"), "shared", "name: shared\ndescription: project copy", "PROJECT SHARED BODY");
  writeSkill(path.join(cwd, ".alevr", "skills"), "repo-rules", "description: The repo's rules", "REPO RULES BODY");
  // Two plugins: one enabled, one switched off in Claude Code's settings.
  const plugin = path.join(home, ".claude", "plugins", "cache", "mkt", "impeccable", "4.3.1");
  writeSkill(path.join(plugin, "skills"), "impeccable", "name: impeccable\ndescription: >\n  Design, critique\n  and polish.", "PLUGIN BODY");
  writeSkill(path.join(plugin, "skills"), "shared", "name: shared\ndescription: plugin copy", "PLUGIN SHARED BODY");
  writeSkill(path.join(plugin, "extra-skills"), "declared", "name: declared\ndescription: declared in the manifest", "DECLARED BODY");
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "impeccable", skills: ["./extra-skills", "../../../escape"] }));
  const off = path.join(home, ".claude", "plugins", "cache", "mkt", "disabled", "1.0.0");
  writeSkill(path.join(off, "skills"), "nope", "name: nope\ndescription: off", "OFF BODY");
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "impeccable@mkt": [{ installPath: plugin, lastUpdated: "2026-09-21T00:00:00Z" }],
        "disabled@mkt": [{ installPath: off }],
      },
    }),
  );
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "impeccable@mkt": true, "disabled@mkt": false } }));
  return { home, cwd };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

test("SKILL.md: front matter name and description, quoted and block scalars, body without front matter", () => {
  const plain = parseSkillFile("---\nname: tidy-commits\ndescription: \"Squash fixups: before a PR\"\n---\n\n# Tidy\nDo it.\n");
  assert.equal(plain.name, "tidy-commits");
  assert.equal(plain.description, "Squash fixups: before a PR");
  assert.equal(plain.body, "# Tidy\nDo it.");

  const folded = parseSkillFile("---\nname: x\ndescription: >-\n  Line one\n  line two\nallowed-tools: Read\n---\nBody");
  assert.equal(folded.description, "Line one line two");
  assert.equal(folded.body, "Body");

  const none = parseSkillFile("# Heading\n\nFirst prose line.\nMore.");
  assert.equal(none.name, undefined);
  assert.equal(none.description, "First prose line.");

  assert.equal(skillName({ name: "Design Taste", body: "" }, "folder"), "design-taste");
  assert.equal(skillName({ name: "../evil", body: "" }, "good-folder"), "good-folder", "an unsafe name falls back to the folder");
  assert.equal(skillName({ body: "" }, ".hidden"), null);
});

// ── Discovery ───────────────────────────────────────────────────────────────

test("discovery: project > user > plugin, Codex and Alevr folders, enabled plugins and their declared folders only", async () => {
  const { home, cwd } = fixtureMac();
  const all = await discoverAll(await skillRoots({ home, cwd }));
  const list = toSummaries(all);
  const by = new Map(list.map((s) => [s.name, s]));

  assert.equal(by.get("shared")?.source, "project", "the project's copy wins");
  assert.equal(by.get("shared")?.description, "project copy");
  assert.equal(all.filter((s) => s.name === "shared").length, 3, "shadowed copies stay discoverable");
  assert.equal(by.get("design-taste-frontend")?.source, "user");
  assert.equal(by.get("design-taste-frontend")?.origin, "claude");
  assert.equal(by.get("codex-only")?.origin, "codex");
  assert.equal(by.get("repo-rules")?.origin, "alevr");
  assert.equal(by.get("repo-rules")?.source, "project");
  assert.equal(by.get("impeccable")?.source, "plugin");
  assert.equal(by.get("impeccable")?.plugin, "impeccable");
  assert.equal(by.get("impeccable")?.description, "Design, critique and polish.");
  assert.ok(by.has("declared"), "a manifest's own skills folder is read");
  assert.ok(!by.has("nope"), "a plugin switched off in Claude Code is skipped");
  assert.ok(path.isAbsolute(by.get("shared")!.path));

  // Order: nearest tier first.
  const tiers = list.map((s) => s.source);
  assert.deepEqual([...tiers].sort((a, b) => ["project", "user", "plugin"].indexOf(a) - ["project", "user", "plugin"].indexOf(b)), tiers);

  // The wire summary carries no body and no folder.
  for (const s of list) {
    assert.deepEqual(Object.keys(s).sort(), ["description", "name", "origin", "path", "source", ...(s.plugin ? ["plugin"] : [])].sort());
    assert.ok(!JSON.stringify(s).includes("BODY"));
  }

  // Without a project only the Mac's own skills.
  const homeOnly = toSummaries(await discoverAll(await skillRoots({ home })));
  assert.equal(homeOnly.find((s) => s.name === "shared")?.source, "user");
  assert.ok(!homeOnly.some((s) => s.name === "repo-rules"));
  assert.deepEqual(dedupeSkills([{ name: "a", n: 1 }, { name: "a", n: 2 }]), [{ name: "a", n: 1 }]);
});

test("discovery: the catalog is cached and a new skill shows up once its folder changes", async () => {
  const { home, cwd } = fixtureMac();
  const catalog = new SkillCatalog({ home, maxAgeMs: 60_000 });
  catalogs.push(catalog);
  let changes = 0;
  catalog.onChange(() => changes++);
  const before = await catalog.list(cwd);
  assert.ok(!before.some((s) => s.name === "fresh"));
  writeSkill(path.join(home, ".claude", "skills"), "fresh", "name: fresh\ndescription: just installed", "FRESH");
  const deadline = Date.now() + 5000;
  let after: LocalSkillSummary[] = before;
  while (Date.now() < deadline) {
    after = await catalog.list(cwd);
    if (after.some((s) => s.name === "fresh")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(after.some((s) => s.name === "fresh"), "the watcher dropped the cached listing");
  assert.ok(changes > 0);
});

test("activation: resolved by name among discovered skills; a client's path never opens an arbitrary file", async () => {
  const { home, cwd } = fixtureMac();
  const discovered = await discoverAll(await skillRoots({ home, cwd }));
  const userShared = discovered.find((s) => s.name === "shared" && s.source === "user")!;
  const { skills, missing } = await resolveSkillActivations(
    [
      { name: "shared", source: "project", path: "/etc/passwd" },
      { name: "shared", source: "user", path: userShared.path },
      { name: "ghost", source: "user" },
      { name: "tidy", source: "account", instructions: "ACCOUNT BODY", title: "Tidy", once: true },
      { name: "empty", source: "account" },
    ],
    discovered,
  );
  assert.equal(skills[0]!.instructions, "PROJECT SHARED BODY", "an unknown path falls back to the winning skill of that name");
  assert.equal(skills[1]!.instructions, "USER SHARED BODY", "a discovered path picks the shadowed copy");
  assert.equal(skills[2]!.instructions, "ACCOUNT BODY");
  assert.equal(skills[2]!.once, true);
  assert.deepEqual(missing, ["ghost", "empty"]);
  const text = renderSkillInstructions(skills);
  assert.match(text, /<skill name="shared" folder="[^"]+">/);
  assert.match(text, /Files this skill mentions are relative to/);
  assert.equal(renderSkillInstructions([]), "");
});

// ── Over the wire ───────────────────────────────────────────────────────────

interface EngineRec {
  prompts: string[];
  appendix: (string | undefined)[];
}

function fakeEngine(rec: EngineRec): AlevrEngine {
  let n = 0;
  const make = (o: EngineSessionOptions): EngineSession => {
    rec.appendix.push(o.systemAppendix);
    return {
      sessionId: `eng_${++n}`,
      setMode: () => undefined,
      abort: () => undefined,
      queueUserMessage: async () => undefined,
      prompt: async (text) => {
        rec.prompts.push(text);
        o.callbacks.onEvent({ type: "assistant_delta", text: "ok" });
        o.callbacks.onEvent({ type: "turn_finished", usage: { inputTokens: 1, outputTokens: 1 } });
      },
    };
  };
  return { providerFor: () => ({}), createSession: make, resumeSession: (_id, o) => make(o) };
}

async function boot() {
  const mac = fixtureMac();
  const rec: EngineRec = { prompts: [], appendix: [] };
  const record = { options: [] as unknown[], prompts: [] as string[], modes: [] as string[], toolResults: [] as string[] };
  const skills = new SkillCatalog({ home: mac.home, watch: false, maxAgeMs: 0 });
  catalogs.push(skills);
  const server = await startEnvServer({
    dataDir: tempDir("data"),
    searchDirs: [fakeBinDir()],
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    alevrEngine: fakeEngine(rec),
    claudeQuery: fakeClaudeQuery(record),
    skills,
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  await client.command("env.configure", { backend: { baseUrl: "https://alevr.example/api/agent", authorization: "Bearer s", models: [] } });
  return { ...mac, rec, record, client };
}

const ask = { runtimeMode: "ask", interactionMode: "default" } as const;

async function open(client: TestClient, cwd: string, selection: ModelSelection) {
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

async function turn(client: TestClient, sessionId: string, selection: ModelSelection, input: Record<string, unknown>) {
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId, input, selection, ...ask });
  await client.turnCompleted(sessionId, turnId);
}

const lastAssistant = (c: TestClient, sid: string) =>
  [...c.snapshot(sid).items].reverse().find((i): i is Extract<TurnItem, { kind: "assistant_message" }> => i.kind === "assistant_message");

test("skills.list: the Mac's skills plus the session's project, summaries only", async () => {
  const { client, cwd } = await boot();
  const { skills } = await client.command<{ skills: LocalSkillSummary[] }>("skills.list", { cwd });
  assert.equal(skills.find((s) => s.name === "shared")?.source, "project");
  assert.ok(skills.some((s) => s.name === "impeccable" && s.source === "plugin"));
  assert.ok(!JSON.stringify(skills).includes("BODY"), "no skill body crosses the wire");
  const selection = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
  await client.command("provider.probe", { instanceId: "alevr" });
  const sid = await open(client, cwd, selection);
  const bySession = await client.command<{ skills: LocalSkillSummary[] }>("skills.list", { sessionId: sid });
  assert.ok(bySession.skills.some((s) => s.name === "repo-rules"), "a session's folder stands in for cwd");
  const noProject = await client.command<{ skills: LocalSkillSummary[] }>("skills.list", {});
  assert.ok(!noProject.skills.some((s) => s.name === "repo-rules"));
  await assert.rejects(client.command("skills.list", { cwd: "relative/dir" }), /absolute/);
});

test("alevr engine: selected skills go in the system prompt and stay for the thread; a /name skill is one message only", async () => {
  const { client, rec, cwd } = await boot();
  await client.command("provider.probe", { instanceId: "alevr" });
  const selection = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
  const sid = await open(client, cwd, selection);

  await turn(client, sid, selection, {
    text: "Redesign the pricing page",
    skills: [
      { name: "design-taste-frontend", source: "user" },
      { name: "tidy", source: "account", title: "Tidy", instructions: "ACCOUNT ONCE BODY", once: true },
    ],
  });
  assert.equal(rec.prompts.at(-1), "Redesign the pricing page", "the message itself is untouched");
  assert.match(rec.appendix.at(-1) ?? "", /USER TASTE BODY/);
  assert.match(rec.appendix.at(-1) ?? "", /ACCOUNT ONCE BODY/);
  const user = client.snapshot(sid).items.find((i) => i.kind === "user_message");
  assert.deepEqual(user && user.kind === "user_message" ? user.skills : undefined, ["design-taste-frontend", "tidy"]);

  // No skills named: the thread's selection applies, the /name one does not.
  await turn(client, sid, selection, { text: "Now the footer" });
  assert.match(rec.appendix.at(-1) ?? "", /USER TASTE BODY/);
  assert.doesNotMatch(rec.appendix.at(-1) ?? "", /ACCOUNT ONCE BODY/);

  // An empty list clears the selection, and the engine prompt with it.
  await turn(client, sid, selection, { text: "Plain again", skills: [] });
  assert.doesNotMatch(rec.appendix.at(-1) ?? "", /USER TASTE BODY/);

  // The selection survives a reopen (meta-backed snapshot).
  await turn(client, sid, selection, { text: "Again", skills: [{ name: "repo-rules", source: "project" }] });
  const server = servers.at(-1)!;
  const reopened = await TestClient.connect(server.url, server.token);
  clients.push(reopened);
  await reopened.command("session.open", { sessionId: sid, cwd });
  const snap = await reopened.waitFor(() => reopened.snapshots.get(sid), 4000, "reopened snapshot");
  assert.deepEqual(snap.skills?.map((s) => s.name), ["repo-rules"]);
});

test("claude: skills are passed through ahead of the message", async () => {
  const { client, record, cwd } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const selection = { instanceId: "claude-agent:default", model: "claude-opus-5-5" };
  const sid = await open(client, cwd, selection);
  await turn(client, sid, selection, { text: "hello there", skills: [{ name: "impeccable", source: "plugin" }] });
  const prompt = record.prompts.find((p) => p.includes("hello there")) ?? "";
  assert.match(prompt, /<skill name="impeccable"/);
  assert.match(prompt, /PLUGIN BODY/);
  assert.ok(prompt.indexOf("PLUGIN BODY") < prompt.indexOf("hello there"), "the skill comes first");
});

test("codex and ACP agents: skills are prepended to the message", async () => {
  const { client, cwd } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const codex = { instanceId: "codex:default", model: "gpt-6.1-codex" };
  const s1 = await open(client, cwd, codex);
  await turn(client, s1, codex, { text: "plain reply", skills: [{ name: "codex-only", source: "user" }] });
  assert.match(lastAssistant(client, s1)?.text ?? "", /CODEX BODY[\s\S]*plain reply/);
  const user = client.snapshot(s1).items.find((i) => i.kind === "user_message");
  assert.equal(user && user.kind === "user_message" ? user.text : "", "plain reply", "the thread shows what the user typed");

  await client.command("provider.probe", { instanceId: "acp:gemini" });
  const acp = { instanceId: "acp:gemini", model: "default" };
  const s2 = await open(client, tempDir("cwd"), acp);
  await turn(client, s2, acp, { text: "say hi", skills: [{ name: "design-taste-frontend", source: "user" }] });
  assert.match(lastAssistant(client, s2)?.text ?? "", /USER TASTE BODY[\s\S]*say hi/);
});
