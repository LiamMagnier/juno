/**
 * Resolving the context tokens of one chat turn.
 *
 * A token names a thing (src/lib/chat/context-tokens.ts); this decides what
 * the turn does with it, through the mechanism Juno ALREADY has for that kind
 * of thing. Nothing here is a new capability:
 *
 *   file      → a clone of the Library file, claimed by the user message,
 *               exactly as "Add from library" does (src/lib/library-attach.ts,
 *               POST /api/library/attach). From there the attachment pipeline
 *               reads, indexes and envelopes it like any upload.
 *   project   → that project's name, instructions and retrieved extracts
 *               (buildProjectContext / retrieveProjectKnowledge), for this
 *               turn only. The chat is not refiled.
 *   app       → the connector joins this turn's `connectors`, so its tools
 *               load through getActiveConnectors and every call still goes
 *               through the approval broker. Never sticky: the conversation's
 *               `activeConnectors` is untouched. Blocked, locked down, denied
 *               by the project's setup or not connected: the turn goes on,
 *               the model is told it is unavailable, and the receipt carries
 *               a structured `needs_connection` notice with where to connect.
 *   crew      → in another crew member's thread, where `hand_off_to_teammate`
 *               is offered this turn, the ask is routed there: the model is
 *               given the teammate's exact name, and the handoff tool still
 *               raises its approval card every time. Everywhere else the
 *               member is CONSULTED: their brief (role and instructions) is
 *               context for this reply, and the model is told it cannot hand
 *               work to them from here. See `crewRoute` for why start_task is
 *               not bound to the member instead.
 *   skill     → the existing single-skill arming: the token becomes this
 *               turn's `skillSlug`, loaded by loadChatSkill with its grant.
 *   chat      → a bounded excerpt of that conversation (title, its memory
 *               digest, its latest turns), inside the untrusted envelope.
 *   artifact  → the artifact's current version, bounded, inside the envelope.
 *
 * EVERY TOKEN IS OWNERSHIP-CHECKED against the account's own rows through the
 * port. A token whose id is not the account's is dropped with `not_found` —
 * one code for "gone" and "someone else's", so a token cannot be used to
 * probe whether another account's id exists.
 *
 * TWO PHASES, because the route decides things in an order that matters.
 * Apps, files and skills must be known before the connectors are opened, the
 * user message is written and the skill is loaded (`begin`). Projects, chats,
 * artifacts and crew are prompt context and are read once the conversation
 * and its history exist (`resolveReferences`). The crew route is decided last
 * (`turnBlock`), when the route knows whether the handoff tool is on.
 *
 * Pure: every read goes through `ContextPort`, which src/lib/chat/context-resolve.ts
 * implements over Prisma and the tests implement over arrays.
 */
import {
  contextTokenKey,
  contextTokenLabel,
  type AppApprovalPreview,
  type ContextReceipt,
  type ContextToken,
  type ContextTokenCode,
  type ContextTokenKind,
  type ContextTokenRange,
  type ContextTokenResolution,
  type ContextTokenVia,
} from "@/lib/chat/context-tokens";
import { appApprovalPreview } from "@/lib/chat/app-approval-preview";
import type { ActionPermissionPolicy } from "@/lib/action-approval";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { MAX_CHAT_CONNECTORS } from "@/lib/connector-intent";
import { wrapUntrusted } from "@/lib/untrusted-content";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How many of each prompt-context kind one message resolves. The rest are `too_many`. */
export const CONTEXT_KIND_LIMITS = { project: 2, chat: 3, artifact: 3, crew: 3 } as const;

/** Characters each section may put in front of the model. */
export const CONTEXT_SECTION_CHARS = { project: 12_000, chat: 6_000, artifact: 12_000, crew: 2_000 } as const;

/** The whole referenced-context block, all sections together. */
export const CONTEXT_BLOCK_CHARS = 40_000;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** One Library file, as the clone needs it. The resolver reads only `id`, `fileName` and `kind`. */
export interface ContextLibraryFile {
  id: string;
  fileName: string;
  kind: string;
}

export interface ContextSkillRow {
  id: string;
  slug: string;
  name: string;
}

/**
 * What an app id is for this account right now.
 *
 * `connected`: a live row (a Connection, an active Composio app, an enabled
 * user MCP server) that getActiveConnectors will try to open.
 * `not_connected`: an app this server can connect but the account has not.
 * `disabled`: the account's own MCP server, switched off.
 * `unavailable`: known, but not set up on this server.
 * `unknown`: not an app this account can reach (including another account's
 * MCP server).
 */
export type AppConnectorState =
  | { state: "connected"; label: string; connectHref: string | null; standingGrants?: boolean }
  | { state: "not_connected"; label: string; connectHref: string | null; standingGrants?: boolean }
  | { state: "disabled"; label: string; connectHref: string | null; standingGrants?: boolean }
  | { state: "unavailable"; label: string }
  | { state: "unknown" };

export interface ContextProjectRow {
  id: string;
  name: string;
}

export interface ContextSection {
  /** The prompt text, already bounded and enveloped where it needs to be. */
  text: string;
  /** Carries text Juno did not author (and so needs the untrusted-content rule). */
  untrusted: boolean;
}

export interface ContextConversationRow {
  id: string;
  title: string;
}

export interface ContextArtifactRow {
  id: string;
  title: string;
  type: string;
  content: string;
}

export interface ContextAgentRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  status: string;
}

export interface ContextPort {
  libraryFiles(ids: string[]): Promise<ContextLibraryFile[]>;
  skills(ids: string[]): Promise<ContextSkillRow[]>;
  apps(ids: string[]): Promise<Map<string, AppConnectorState>>;
  projects(ids: string[]): Promise<ContextProjectRow[]>;
  /** The project's context for this question: instructions bare, extracts and files enveloped. */
  projectSection(project: ContextProjectRow, query: string, maxChars: number): Promise<ContextSection>;
  conversations(ids: string[]): Promise<ContextConversationRow[]>;
  /** The conversation's excerpt as plain text (the resolver envelopes it). */
  conversationExcerpt(conversation: ContextConversationRow, maxChars: number): Promise<string>;
  artifacts(ids: string[]): Promise<ContextArtifactRow[]>;
  agents(ids: string[]): Promise<ContextAgentRow[]>;
}

// ---------------------------------------------------------------------------
// Turn facts
// ---------------------------------------------------------------------------

export interface ContextTurnFacts {
  privateMode: boolean;
  /** The connectors the request named the legacy way, already filtered by the project's setup. */
  legacyConnectorIds: readonly string[];
  /** Whether the project's assistant setup lets this chat use apps, and which. */
  workspace: { connectorsPermitted: boolean; allowedConnectorIds?: readonly string[] };
  /** Files the request attached the ordinary way. */
  attachmentCount: number;
  /** A skill the request armed the ordinary way (`skillSlug`). */
  explicitSkillSlug: string | null;
  approvals: { policy: ActionPermissionPolicy; lockdown: boolean; blockedConnectors: readonly string[] };
  /**
   * The tokens came back from the answer a regenerate replaces, rather than
   * from the request. Their files are already attached to the user message,
   * so they are reported, not cloned again.
   */
  carriedOver?: boolean;
}

export interface ContextReferenceFacts {
  conversationId: string;
  conversationProjectId: string | null;
  /** The agent whose thread this is, if it is one. */
  threadAgentId: string | null;
  /** The person's own words this turn, for project retrieval. */
  query: string;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function oneLine(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const KIND_NOUN: Record<ContextTokenKind, string> = {
  file: "file",
  project: "project",
  app: "app",
  crew: "crew member",
  skill: "skill",
  chat: "chat",
  artifact: "artifact",
};

/** What a person reads when a token did not reach the turn. */
export function contextNoticeMessage(kind: ContextTokenKind, label: string, code: ContextTokenCode): string {
  const name = oneLine(label);
  switch (code) {
    case "not_found":
      return `Juno couldn't find the ${KIND_NOUN[kind]} “${name}”.`;
    case "needs_connection":
      return `${name} isn't connected. Connect it to use it here.`;
    case "blocked":
      return `${name} is turned off in your settings, so Juno didn't use it.`;
    case "workspace_denied":
      return `This project's setup doesn't allow ${name} in its chats.`;
    case "connector_limit":
      return `A message can use up to ${MAX_CHAT_CONNECTORS} apps, so ${name} wasn't added.`;
    case "attachment_limit":
      return `A message can carry up to ${MAX_ATTACHMENTS} files, so “${name}” wasn't attached.`;
    case "too_many":
      return `Too many ${KIND_NOUN[kind]}s in one message, so “${name}” wasn't used.`;
    case "private_mode":
      return `Incognito chats can't use ${KIND_NOUN[kind]}s, so “${name}” wasn't used.`;
    case "skill_conflict":
      return `One skill applies per message, so “${name}” wasn't applied.`;
    case "skill_refused":
      return `The skill “${name}” couldn't be applied.`;
    case "self":
      return `“${name}” is this chat.`;
    case "unavailable":
      return `${name} isn't available right now.`;
  }
}

// ---------------------------------------------------------------------------
// The resolution of one turn
// ---------------------------------------------------------------------------

interface Entry {
  kind: ContextTokenKind;
  id: string;
  /** The sent label until a row supplies the account's own name. */
  label: string;
  /**
   * The words the person's chip covers in the message — the label as sent.
   * The ranges frame these, not `label`, which a rename since the palette
   * can make different.
   */
  sentLabel: string;
  ranges: ContextTokenRange[];
  outcome: "applied" | "dropped" | "pending";
  via?: ContextTokenVia;
  code?: ContextTokenCode;
  message?: string;
  connect?: { connectorId: string; href: string };
  approval?: AppApprovalPreview;
  /** Where connecting an app starts, kept for a sign-in that turns out to have expired. */
  connectHref?: string | null;
}

interface CrewRef {
  key: string;
  agent: ContextAgentRow;
}

interface ReferenceSection {
  key: string;
  heading: string;
  text: string;
  untrusted: boolean;
}

export class TurnContext {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private readonly sections: ReferenceSection[] = [];
  private readonly crew: CrewRef[] = [];
  private files: ContextLibraryFile[] = [];
  private connectors: string[] = [];
  private skill: { key: string; slug: string } | null = null;
  private referencesResolved = false;

  private constructor(
    tokens: readonly ContextToken[],
    private readonly facts: ContextTurnFacts
  ) {
    for (const token of tokens) {
      const key = contextTokenKey(token);
      const existing = this.entries.get(key);
      if (existing) {
        if (token.range) existing.ranges.push(token.range);
        continue;
      }
      this.entries.set(key, {
        kind: token.kind,
        id: token.id,
        label: token.label,
        sentLabel: token.label,
        ranges: token.range ? [token.range] : [],
        outcome: "pending",
      });
      this.order.push(key);
    }
  }

  /** No tokens at all: every method is then a no-op, and the route behaves exactly as before. */
  get empty(): boolean {
    return this.order.length === 0;
  }

  /** Apps this turn adds to the connectors it opens. Never persisted on the conversation. */
  get connectorIds(): readonly string[] {
    return this.connectors;
  }

  /** Library files to clone onto the user message. */
  get libraryFiles(): readonly ContextLibraryFile[] {
    return this.files;
  }

  /** The skill a token armed, when the request did not arm one itself. */
  get skillSlug(): string | null {
    return this.skill?.slug ?? null;
  }

  /** Whether any referenced section carries text Juno did not author. */
  get untrusted(): boolean {
    return this.sections.some((section) => section.untrusted);
  }

  private of(kind: ContextTokenKind): Entry[] {
    return this.order.map((key) => this.entries.get(key)!).filter((entry) => entry.kind === kind && entry.outcome === "pending");
  }

  private drop(entry: Entry, code: ContextTokenCode, message?: string) {
    entry.outcome = "dropped";
    entry.code = code;
    entry.message = message ?? contextNoticeMessage(entry.kind, entry.label, code);
  }

  private apply(entry: Entry, via: ContextTokenVia) {
    entry.outcome = "applied";
    entry.via = via;
  }

  /**
   * Phase one: apps, files and skills, before the route opens connectors,
   * writes the user message or loads a skill.
   */
  static async begin(tokens: readonly ContextToken[], facts: ContextTurnFacts, port: ContextPort): Promise<TurnContext> {
    const turn = new TurnContext(tokens, facts);
    if (turn.empty) return turn;

    // Incognito resolves skills only. A skill is the account's own stored
    // instructions, which private mode already honours (`skillSlug`); every
    // other kind would read rows into, or write a clone out of, a turn that
    // promises to leave no trace.
    if (facts.privateMode) {
      for (const key of turn.order) {
        const entry = turn.entries.get(key)!;
        if (entry.kind !== "skill") turn.drop(entry, "private_mode");
      }
    }

    await Promise.all([turn.beginApps(port), turn.beginFiles(port), turn.beginSkills(port)]);
    return turn;
  }

  private async beginApps(port: ContextPort) {
    const apps = this.of("app");
    if (apps.length === 0) return;
    const { approvals, workspace } = this.facts;
    const states = await port.apps(apps.map((entry) => entry.id));
    const legacy = new Set(this.facts.legacyConnectorIds);
    let room = Math.max(0, MAX_CHAT_CONNECTORS - legacy.size);

    for (const entry of apps) {
      const state = states.get(entry.id) ?? { state: "unknown" as const };
      if (state.state !== "unknown") entry.label = contextTokenLabel(state.label) || entry.label;
      const blocked = approvals.blockedConnectors.includes(entry.id);
      if (state.state !== "unknown" && state.state !== "unavailable") {
        entry.approval = appApprovalPreview({
          label: entry.label,
          policy: approvals.policy,
          lockdown: approvals.lockdown,
          blocked,
          standingGrants: !!state.standingGrants,
        });
      }

      if (state.state === "unknown") {
        this.drop(entry, "not_found");
        continue;
      }
      if (state.state === "unavailable") {
        this.drop(entry, "unavailable");
        continue;
      }
      if (approvals.lockdown) {
        this.drop(entry, "blocked", `Lockdown is on, so Juno didn't use ${oneLine(entry.label)}.`);
        continue;
      }
      if (blocked) {
        this.drop(entry, "blocked");
        continue;
      }
      if (
        !workspace.connectorsPermitted ||
        (workspace.allowedConnectorIds !== undefined && !workspace.allowedConnectorIds.includes(entry.id))
      ) {
        this.drop(entry, "workspace_denied");
        continue;
      }
      if (state.state === "not_connected") {
        this.drop(entry, "needs_connection");
        if (state.connectHref) entry.connect = { connectorId: entry.id, href: state.connectHref };
        continue;
      }
      if (state.state === "disabled") {
        this.drop(entry, "unavailable", `${oneLine(entry.label)} is switched off. Turn it on in Apps to use it here.`);
        if (state.connectHref) entry.connect = { connectorId: entry.id, href: state.connectHref };
        continue;
      }
      // Connected. Already on this turn the legacy way costs no room.
      if (!legacy.has(entry.id)) {
        if (room === 0) {
          this.drop(entry, "connector_limit");
          continue;
        }
        room -= 1;
        this.connectors.push(entry.id);
      }
      entry.connectHref = state.connectHref;
      // Still pending: opening it can fail (an expired sign-in), and only
      // `settleConnectors` knows.
    }
  }

  private async beginFiles(port: ContextPort) {
    const files = this.of("file");
    if (files.length === 0) return;
    // A regenerate's carried-over files are on the user message already: the
    // history the model reads has them. Reported, never cloned twice.
    if (this.facts.carriedOver) {
      for (const entry of files) this.apply(entry, "already_in_context");
      return;
    }
    const rows = new Map((await port.libraryFiles(files.map((entry) => entry.id))).map((row) => [row.id, row]));
    let room = Math.max(0, MAX_ATTACHMENTS - this.facts.attachmentCount);
    for (const entry of files) {
      const row = rows.get(entry.id);
      if (!row) {
        this.drop(entry, "not_found");
        continue;
      }
      entry.label = contextTokenLabel(row.fileName) || entry.label;
      if (room === 0) {
        this.drop(entry, "attachment_limit");
        continue;
      }
      room -= 1;
      this.files.push(row);
    }
  }

  private async beginSkills(port: ContextPort) {
    const skills = this.of("skill");
    if (skills.length === 0) return;
    const rows = new Map((await port.skills(skills.map((entry) => entry.id))).map((row) => [row.id, row]));
    // One skill per message, as the composer's own arming has always been:
    // the request's `skillSlug` first, then the first skill token named.
    const armed = () => this.facts.explicitSkillSlug ?? this.skill?.slug ?? null;
    for (const entry of skills) {
      const row = rows.get(entry.id);
      if (!row) {
        this.drop(entry, "not_found");
        continue;
      }
      entry.label = contextTokenLabel(row.name) || entry.label;
      const current = armed();
      if (current !== null && current !== row.slug) {
        this.drop(entry, "skill_conflict");
        continue;
      }
      // Either nothing was armed, or this token names the skill that was: in
      // both cases it rides the one load the route does, and settles with it.
      // (Two tokens cannot share a slug: slugs are unique per account.)
      this.skill ??= { key: contextTokenKey(entry), slug: row.slug };
    }
  }

  /**
   * The apps that actually opened. A connected app that did not (an expired
   * sign-in the refresh could not renew) is a `needs_connection`, which is
   * the same thing a person has to do about it.
   */
  settleConnectors(active: readonly { id: string; label: string }[]) {
    const opened = new Map(active.map((connector) => [connector.id, connector]));
    for (const entry of this.of("app")) {
      const connector = opened.get(entry.id);
      if (connector) {
        entry.label = contextTokenLabel(connector.label) || entry.label;
        this.apply(entry, "connector");
        continue;
      }
      this.drop(
        entry,
        "needs_connection",
        `${oneLine(entry.label)} couldn't be reached — its sign-in may have expired. Reconnect it to use it here.`
      );
      if (entry.connectHref) entry.connect = { connectorId: entry.id, href: entry.connectHref };
    }
  }

  /**
   * Which Library files made it onto the user message (the sources that were
   * cloned, or that the message already carried). Null when no message could
   * take them.
   */
  settleFiles(attachedSourceIds: ReadonlySet<string> | null) {
    for (const entry of this.of("file")) {
      if (attachedSourceIds?.has(entry.id)) this.apply(entry, "attachment");
      else this.drop(entry, "unavailable", `“${oneLine(entry.label)}” couldn't be attached to this message.`);
    }
  }

  /** What loadChatSkill made of the armed skill. */
  settleSkill(outcome: { applied: true } | { applied: false; message: string } | null) {
    for (const entry of this.of("skill")) {
      if (!this.skill || contextTokenKey(entry) !== this.skill.key || outcome === null) {
        this.drop(entry, "unavailable");
        continue;
      }
      if (outcome.applied) this.apply(entry, "skill");
      else this.drop(entry, "skill_refused", `The skill “${oneLine(entry.label)}” wasn't applied: ${outcome.message}`);
    }
  }

  /**
   * Phase two: projects, chats, artifacts and crew, once the conversation
   * exists and the person's words for this turn are known.
   */
  async resolveReferences(facts: ContextReferenceFacts, port: ContextPort) {
    if (this.referencesResolved) return;
    this.referencesResolved = true;
    await Promise.all([
      this.resolveProjects(facts, port),
      this.resolveChats(facts, port),
      this.resolveArtifacts(port),
      this.resolveCrew(facts, port),
    ]);
    // Sections are rendered in the order the person named them.
    const rank = new Map(this.order.map((key, index) => [key, index]));
    this.sections.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
    this.crew.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  }

  /** Over the per-kind limit, in the order named. Returns the entries still in play. */
  private limit(entries: Entry[], max: number): Entry[] {
    entries.slice(max).forEach((entry) => this.drop(entry, "too_many"));
    return entries.slice(0, max);
  }

  private async resolveProjects(facts: ContextReferenceFacts, port: ContextPort) {
    const pending = this.of("project");
    if (pending.length === 0) return;
    const rows = new Map((await port.projects(pending.map((entry) => entry.id))).map((row) => [row.id, row]));
    const found: Entry[] = [];
    for (const entry of pending) {
      const row = rows.get(entry.id);
      if (!row) this.drop(entry, "not_found");
      else {
        entry.label = contextTokenLabel(row.name) || entry.label;
        if (row.id === facts.conversationProjectId) this.apply(entry, "already_in_context");
        else found.push(entry);
      }
    }
    await Promise.all(
      this.limit(found, CONTEXT_KIND_LIMITS.project).map(async (entry) => {
        const section = await port.projectSection(rows.get(entry.id)!, facts.query, CONTEXT_SECTION_CHARS.project);
        this.sections.push({
          key: contextTokenKey(entry),
          heading: `## Project: ${oneLine(entry.label)}`,
          text: section.text,
          untrusted: section.untrusted,
        });
        this.apply(entry, "project_context");
      })
    );
  }

  private async resolveChats(facts: ContextReferenceFacts, port: ContextPort) {
    const pending = this.of("chat");
    if (pending.length === 0) return;
    const found: Entry[] = [];
    const rows = new Map(
      (await port.conversations(pending.filter((entry) => entry.id !== facts.conversationId).map((entry) => entry.id))).map(
        (row) => [row.id, row]
      )
    );
    for (const entry of pending) {
      if (entry.id === facts.conversationId) {
        this.drop(entry, "self");
        continue;
      }
      const row = rows.get(entry.id);
      if (!row) this.drop(entry, "not_found");
      else {
        entry.label = contextTokenLabel(row.title) || entry.label;
        found.push(entry);
      }
    }
    await Promise.all(
      this.limit(found, CONTEXT_KIND_LIMITS.chat).map(async (entry) => {
        const excerpt = await port.conversationExcerpt(rows.get(entry.id)!, CONTEXT_SECTION_CHARS.chat);
        this.sections.push({
          key: contextTokenKey(entry),
          heading: `## Chat: ${oneLine(entry.label)}`,
          text: wrapUntrusted(`chat “${oneLine(entry.label)}”`, bound(excerpt, CONTEXT_SECTION_CHARS.chat)),
          untrusted: true,
        });
        this.apply(entry, "chat_excerpt");
      })
    );
  }

  private async resolveArtifacts(port: ContextPort) {
    const pending = this.of("artifact");
    if (pending.length === 0) return;
    const rows = new Map((await port.artifacts(pending.map((entry) => entry.id))).map((row) => [row.id, row]));
    const found: Entry[] = [];
    for (const entry of pending) {
      const row = rows.get(entry.id);
      if (!row) this.drop(entry, "not_found");
      else {
        entry.label = contextTokenLabel(row.title) || entry.label;
        found.push(entry);
      }
    }
    for (const entry of this.limit(found, CONTEXT_KIND_LIMITS.artifact)) {
      const row = rows.get(entry.id)!;
      this.sections.push({
        key: contextTokenKey(entry),
        heading: `## Artifact: ${oneLine(entry.label)} (${row.type.toLowerCase()})`,
        text: wrapUntrusted(`artifact “${oneLine(entry.label)}”`, bound(row.content, CONTEXT_SECTION_CHARS.artifact)),
        untrusted: true,
      });
      this.apply(entry, "artifact_excerpt");
    }
  }

  private async resolveCrew(facts: ContextReferenceFacts, port: ContextPort) {
    const pending = this.of("crew");
    if (pending.length === 0) return;
    const rows = new Map((await port.agents(pending.map((entry) => entry.id))).map((row) => [row.id, row]));
    const found: Entry[] = [];
    for (const entry of pending) {
      const row = rows.get(entry.id);
      if (!row) this.drop(entry, "not_found");
      else {
        entry.label = contextTokenLabel(row.name) || entry.label;
        // The member whose thread this is is the one answering.
        if (row.id === facts.threadAgentId) this.apply(entry, "already_in_context");
        else found.push(entry);
      }
    }
    for (const entry of this.limit(found, CONTEXT_KIND_LIMITS.crew)) {
      this.crew.push({ key: contextTokenKey(entry), agent: rows.get(entry.id)! });
      // `via` is decided in `turnBlock`, once the handoff tool's gate is known.
    }
  }

  /**
   * Where a named crew member's ask goes.
   *
   * `hand_off_to_teammate` when this turn carries it: the thread is another
   * member's, the handoff gate is open, and the named member is active. The
   * tool resolves the teammate by exact name among active members and raises
   * its approval card every time, so naming the teammate here grants nothing.
   *
   * Otherwise a consult. `start_task` bound to the member (it takes an
   * `agent`) was considered and not used: it would run the member's task in
   * THIS chat under the member's autonomy but with this turn's apps, a hybrid
   * no surface draws and the crew work (owning member, transfer, parent link,
   * docs/rework/DECISIONS.md D-010) is about to define properly. The consult
   * is honest about what it is, and the receipt says `consult` so a client can
   * offer "Send to Mira" through POST /api/agents/{id}/tasks.
   */
  static crewRoute(agent: Pick<ContextAgentRow, "status">, handoffAvailable: boolean): "handoff" | "consult" {
    return handoffAvailable && agent.status === "active" ? "handoff" : "consult";
  }

  /**
   * The block the model reads, appended to the latest user turn for this
   * generation only (never persisted), or "" when there is nothing to say.
   *
   * Juno-authored framing stays outside the envelope; everything a document,
   * another chat or an artifact said is inside it. Crew briefs and project
   * instructions are the account's own configuration and stay bare, as the
   * agent block and project context already keep them.
   */
  turnBlock(options: { handoffAvailable: boolean }): string {
    if (this.empty) return "";
    const parts: string[] = [];
    let budget = CONTEXT_BLOCK_CHARS;
    const take = (text: string) => {
      if (budget <= 0) return false;
      const cut = bound(text, budget);
      budget -= cut.length;
      parts.push(cut);
      return true;
    };

    // Routes first, whatever the budget leaves room to say: the receipt must
    // record where each ask went even if its brief was cut.
    const routes = this.crew.map((ref) => {
      const route = TurnContext.crewRoute(ref.agent, options.handoffAvailable);
      const entry = this.entries.get(ref.key)!;
      if (entry.outcome === "pending") this.apply(entry, route);
      return { ref, route };
    });

    for (const section of this.sections) {
      if (!take(`${section.heading}\n${section.text}`)) break;
    }

    for (const { ref, route } of routes) {
      const name = oneLine(ref.agent.name);
      const lines = [`## Crew member: ${name}${ref.agent.role.trim() ? ` — ${oneLine(ref.agent.role, 120)}` : ""}`];
      lines.push(
        `${name} is one of the user's crew members (a teammate agent). Their brief is below so you know who they are and what they look after. You are not ${name}; never speak as them.`
      );
      const brief = ref.agent.instructions.trim();
      if (brief) lines.push(`Brief:\n${bound(brief, CONTEXT_SECTION_CHARS.crew)}`);
      if (ref.agent.status !== "active") lines.push(`${name} is paused, so they cannot take new work right now.`);
      lines.push(
        route === "handoff"
          ? `If the user wants ${name} to take this on, call hand_off_to_teammate with teammate "${name}". The user approves every handoff before it starts.`
          : `You cannot hand work to ${name} from this conversation. Answer here, using the brief as context. If the user wants ${name} to do the work, tell them they can ask ${name} in ${name}'s own thread.`
      );
      if (!take(lines.join("\n"))) break;
    }

    const unavailable = this.order
      .map((key) => this.entries.get(key)!)
      .filter((entry) => entry.outcome === "dropped");
    if (unavailable.length > 0) {
      const lines = ["## Mentioned but not available"];
      for (const entry of unavailable) {
        if (entry.kind === "app" && (entry.code === "needs_connection" || entry.code === "blocked" || entry.code === "unavailable" || entry.code === "workspace_denied")) {
          lines.push(
            `- ${oneLine(entry.label)} (app): not available in this reply, so none of its tools can be used. If the request needs it, say so plainly and do not pretend to have used it.`
          );
        } else if (entry.kind === "crew" || entry.kind === "skill") {
          lines.push(`- “${oneLine(entry.label)}” (${KIND_NOUN[entry.kind]}): not available in this reply.`);
        } else {
          lines.push(`- “${oneLine(entry.label)}” (${KIND_NOUN[entry.kind]}): could not be used in this reply. Do not guess at its contents.`);
        }
      }
      take(lines.join("\n"));
    }

    if (parts.length === 0) return "";
    return [
      "# Referenced in this message",
      "The user named these in the message above. They are context for this reply only.",
      ...parts,
    ].join("\n\n");
  }

  /** The structured record, persisted on the reply's activity (`contextReceipt`). */
  receipt(): ContextReceipt | null {
    if (this.empty) return null;
    return {
      version: 1,
      tokens: this.order.map((key) => {
        const entry = this.entries.get(key)!;
        const resolution: ContextTokenResolution = {
          kind: entry.kind,
          id: entry.id,
          label: entry.label,
          // A token still pending here was never settled by the route, which is
          // a wiring bug; it is reported as not used rather than as used.
          outcome: entry.outcome === "applied" ? "applied" : "dropped",
          ...(entry.ranges.length ? { ranges: entry.ranges } : {}),
          ...(entry.ranges.length && entry.sentLabel !== entry.label ? { text: entry.sentLabel } : {}),
          ...(entry.via ? { via: entry.via } : {}),
          ...(entry.outcome === "pending" ? { code: "unavailable" as const } : entry.code ? { code: entry.code } : {}),
          ...(entry.message ? { message: entry.message } : {}),
          ...(entry.connect ? { connect: entry.connect } : {}),
          ...(entry.approval ? { approval: entry.approval } : {}),
        };
        return resolution;
      }),
    };
  }

  /**
   * Stored ranges refitted to the user message the route actually read (a
   * regenerate reads it back). Against the words the person's chip wrote,
   * not the account's current name: a file renamed since the palette still
   * has its chip where it was.
   */
  fitRanges(storedText: string) {
    for (const entry of this.entries.values()) {
      entry.ranges = entry.ranges.filter(
        (range) => range.end <= storedText.length && storedText.slice(range.start, range.end) === entry.sentLabel
      );
    }
  }
}

function bound(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The activity rows the current transcript draws
// ---------------------------------------------------------------------------

export interface ContextActivityRow {
  kind: "context" | "warning";
  title: string;
  detail?: string;
  contextReceipt?: ContextReceipt;
}

/**
 * The receipt row, then one warning per token that did not reach the turn.
 *
 * The receipt row is the durable record (`contextReceipt` survives reload
 * through the serializer's whitelist); the warnings are what today's
 * transcript, which draws only titles and details, can show without new UI —
 * including "Stripe isn't connected".
 */
export function contextActivityRows(receipt: ContextReceipt | null): ContextActivityRow[] {
  if (!receipt || receipt.tokens.length === 0) return [];
  const applied = receipt.tokens.filter((token) => token.outcome === "applied");
  const rows: ContextActivityRow[] = [
    {
      kind: "context",
      title: applied.length > 0 ? "Using what you mentioned" : "Couldn't use what you mentioned",
      ...(applied.length > 0 ? { detail: applied.map((token) => oneLine(token.label, 60)).join(" · ") } : {}),
      contextReceipt: receipt,
    },
  ];
  for (const token of receipt.tokens) {
    if (token.outcome !== "dropped") continue;
    rows.push({
      kind: "warning",
      title:
        token.code === "needs_connection"
          ? `${oneLine(token.label, 60)} isn't connected`
          : `Didn't use ${token.kind === "app" ? oneLine(token.label, 60) : `“${oneLine(token.label, 60)}”`}`,
      ...(token.message ? { detail: token.message } : {}),
    });
  }
  return rows;
}

/**
 * Puts the referenced-context block after the LATEST user turn's own words,
 * for this generation only.
 *
 * The latest turn rather than the first (where project reference files go,
 * `prependToFirstUserTurn`): these are this message's references, and the
 * first turn's prefix is what keeps the provider's prompt cache warm across
 * turns. Nothing is written back, so the stored message stays the sentence
 * the person typed, and the next turn does not carry this one's references
 * unless it names them again. Roles are untouched. Returns a new array.
 */
export function appendToLastUserTurn<T extends { role: string; content: string }>(history: readonly T[], text: string): T[] {
  if (!text) return [...history];
  let index = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "USER") {
      index = i;
      break;
    }
  }
  if (index === -1) return [...history];
  return history.map((message, i) =>
    i === index ? { ...message, content: message.content ? `${message.content}\n\n${text}` : text } : message
  );
}
