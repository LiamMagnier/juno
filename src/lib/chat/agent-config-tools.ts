/**
 * Conversational configuration tools for Juno Agents (docs/design/agents-v2/BRIEF.md §4.6).
 *
 * Pure helpers, schemas, diff builders and approval rules live in the top half
 * of this file so `tests/chat-agent-config-tools.test.ts` can exercise them
 * without a database. The bottom half (`createAgentConfigTools`) dynamically
 * imports Prisma, the agent store, the computer service and the approval broker.
 */

import type { NativeChatTool } from "@/lib/llm";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ClientAgentChange, ClientAgentChangeItem } from "@/types/chat";
import {
  AGENT_EYES,
  AGENT_MARKS,
  AGENT_SHAPES,
  AGENT_TONES,
} from "@/lib/agents/avatar";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import {
  AGENT_GOAL_CADENCES,
  AGENT_GOAL_STATUSES,
  AGENT_NOTIFY_LEVELS,
  AGENT_ROUTINE_CADENCES,
  AGENT_ROUTINE_CADENCE_LABEL,
  AGENT_STATUSES,
  AGENT_STYLES,
  AGENT_STYLE_LABEL,
  createAgentSchema,
  createRoutineSchema,
  patchAgentSchema,
  type AgentNotifyLevel,
  type AgentRoutineCadence,
  type AgentStyle,
} from "@/lib/agents/domain";
import {
  WORK_APPROVAL_MODE_LABEL,
  WORK_PERMISSION_POLICIES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
type ToolDefinition = McpFunctionTool;

const AGENT_TEMPLATE_IDS = AGENT_TEMPLATES.map((t) => t.id);

const AGENT_NOTIFY_LABEL: Record<AgentNotifyLevel, string> = {
  needs_you: "Only when it needs you",
  results: "When a task finishes or needs you",
  all: "Everything (including ideas)",
};

export const CREATE_AGENT_TOOL_NAME = "create_agent";
export const UPDATE_AGENT_TOOL_NAME = "update_agent";
export const AGENT_GOAL_TOOL_NAME = "agent_goal";
export const AGENT_ROUTINE_TOOL_NAME = "agent_routine";
export const AGENT_MEMORY_TOOL_NAME = "agent_memory";

export const AGENT_CONFIG_TOOL_NAMES = [
  CREATE_AGENT_TOOL_NAME,
  UPDATE_AGENT_TOOL_NAME,
  AGENT_GOAL_TOOL_NAME,
  AGENT_ROUTINE_TOOL_NAME,
  AGENT_MEMORY_TOOL_NAME,
] as const;

export type AgentConfigToolName = (typeof AGENT_CONFIG_TOOL_NAMES)[number];

export const AGENT_CONFIG_TOOL_LABELS: Record<AgentConfigToolName, string> = {
  create_agent: "Setting up an agent",
  update_agent: "Updating this agent",
  agent_goal: "Updating goals",
  agent_routine: "Updating schedule",
  agent_memory: "Saving a note",
};

export const AGENT_CONFIG_RATE_LIMIT = { limit: 30, windowSec: 3_600 } as const;

export const UNTRUSTED_CONFIG_REFUSAL_MESSAGE =
  "I can't change my own setup while reading external content in the same turn. Ask me in a clean message.";

export const PAUSED_CONFIG_REFUSAL_MESSAGE =
  "This agent is paused. Resume it before changing its setup.";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface AgentConfigToolGate {
  privateMode: boolean;
  voiceMode: boolean;
  regenerate: boolean;
  userMessageId: string | null;
  researchActive: boolean;
  artifactEdit: boolean;
  conversationKind: string | null | undefined;
  agenticTools: boolean;
  functionToolsReachModel: boolean;
  skillPermits: boolean;
  lockdown: boolean;
}

export function chatAgentConfigToolsEnabled(gate: AgentConfigToolGate): boolean {
  return (
    !gate.privateMode &&
    !gate.voiceMode &&
    !gate.regenerate &&
    typeof gate.userMessageId === "string" &&
    gate.userMessageId.length > 0 &&
    !gate.researchActive &&
    !gate.artifactEdit &&
    gate.conversationKind === "chat" &&
    gate.agenticTools &&
    gate.functionToolsReachModel &&
    gate.skillPermits &&
    !gate.lockdown
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const CREATE_AGENT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: CREATE_AGENT_TOOL_NAME,
    description:
      "Create a new persistent agent for the user when they describe someone they want to hire or set up (for example: 'hire an agent to watch our competitors every Monday'). Creates the agent, its thread, and optional first goal.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short given name for the agent (e.g. 'Scout', 'Ledger')." },
        role: { type: "string", description: "One-line job description (e.g. 'Competitor & pricing watch')." },
        template: { type: "string", enum: AGENT_TEMPLATE_IDS, description: "Optional starter template ID." },
        style: { type: "string", enum: [...AGENT_STYLES], description: "How the agent writes." },
        instructions: { type: "string", description: "Durable brief and standing instructions for the agent." },
        faceShape: { type: "string", enum: [...AGENT_SHAPES], description: "Avatar face shape." },
        faceTone: { type: "string", enum: [...AGENT_TONES], description: "Avatar colour tone." },
        faceEyes: { type: "string", enum: [...AGENT_EYES], description: "Avatar eye style." },
        faceMark: { type: "string", enum: [...AGENT_MARKS], description: "Avatar mark or accessory." },
        autonomy: {
          type: "string",
          enum: [...WORK_PERMISSION_POLICIES],
          description: "Autonomy mode: conservative (ask every time), balanced (ask before risky steps), or permissive.",
        },
        approvalMode: {
          type: "string",
          enum: [...WORK_PERMISSION_POLICIES],
          description: "Autonomy mode: conservative (ask every time), balanced (ask before risky steps), or permissive.",
        },
        apps: {
          type: "array",
          items: { type: "string" },
          description: "Connected app provider IDs this agent may use.",
        },
        computer: {
          type: "boolean",
          description: "Whether to give this agent its own persistent computer.",
        },
        notify: {
          type: "string",
          enum: [...AGENT_NOTIFY_LEVELS],
          description: "When to notify the user: needs_you, results, or all.",
        },
        firstGoal: { type: "string", description: "Optional first standing goal title." },
      },
      required: ["name", "role"],
    },
  },
};

export const UPDATE_AGENT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: UPDATE_AGENT_TOOL_NAME,
    description:
      "Update an agent's profile, brief, face, tone, autonomy, notification level, status (active or paused), connected apps, or personal computer when the user asks to change how it works.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Name of the agent to update (omit when already in the agent's own thread)." },
        name: { type: "string", description: "New name for this agent." },
        role: { type: "string", description: "New one-line role description." },
        style: { type: "string", enum: [...AGENT_STYLES], description: "Writing tone: warm, direct, playful, or formal." },
        instructions: { type: "string", description: "Updated durable brief and rules." },
        addToInstructions: { type: "string", description: "Append one line or rule to the agent's existing instructions." },
        faceShape: { type: "string", enum: [...AGENT_SHAPES], description: "Avatar face shape." },
        faceTone: { type: "string", enum: [...AGENT_TONES], description: "Avatar colour tone." },
        faceEyes: { type: "string", enum: [...AGENT_EYES], description: "Avatar eye style." },
        faceMark: { type: "string", enum: [...AGENT_MARKS], description: "Avatar mark or accessory." },
        autonomy: {
          type: "string",
          enum: [...WORK_PERMISSION_POLICIES],
          description: "Autonomy setting: conservative, balanced, or permissive.",
        },
        approvalMode: {
          type: "string",
          enum: [...WORK_PERMISSION_POLICIES],
          description: "Autonomy setting: conservative, balanced, or permissive.",
        },
        notify: {
          type: "string",
          enum: [...AGENT_NOTIFY_LEVELS],
          description: "Notification preference: needs_you (only when blocked), results (completed tasks), or all (including ideas).",
        },
        proactive: { type: "boolean", description: "Whether to suggest ideas during daily reflection." },
        pinned: { type: "boolean", description: "Whether to pin this agent to the top of the roster." },
        status: { type: "string", enum: [...AGENT_STATUSES], description: "Set to paused to sleep, or active to resume." },
        model: { type: "string", description: "Preferred model ID, or null for account default." },
        reasoningEffort: { type: "string", description: "Reasoning effort (low, medium, high, max)." },
        connectorIds: {
          type: "array",
          items: { type: "string" },
          description: "Connected app provider IDs this agent may use.",
        },
        addApps: {
          type: "array",
          items: { type: "string" },
          description: "App provider IDs to add to this agent.",
        },
        removeApps: {
          type: "array",
          items: { type: "string" },
          description: "App provider IDs to remove from this agent.",
        },
        computer: {
          type: "string",
          enum: ["on", "off", "reset"],
          description: "Turn this agent's persistent cloud computer on, off, or reset it.",
        },
      },
    },
  },
};

export const AGENT_GOAL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: AGENT_GOAL_TOOL_NAME,
    description: "Add, update, pause, resume, achieve, or drop a standing goal for this agent.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "achieve", "pause", "resume", "drop"],
          description: "What to do with the goal.",
        },
        goalId: { type: "string", description: "ID of the existing goal (optional if title matches an existing goal)." },
        title: { type: "string", description: "Goal title." },
        detail: { type: "string", description: "Optional goal details or success criteria." },
        cadence: { type: "string", enum: [...AGENT_GOAL_CADENCES], description: "Check-in cadence." },
        dueAt: { type: "string", description: "Optional ISO due date." },
      },
      required: ["action"],
    },
  },
};

export const AGENT_ROUTINE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: AGENT_ROUTINE_TOOL_NAME,
    description:
      "Create, pause, resume, or delete a recurring scheduled routine for this agent (for example, every Monday at 08:00 or every weekday at 09:00).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "add", "pause", "resume", "delete"],
          description: "Whether to create a new routine, pause an existing one, resume a paused one, or delete one.",
        },
        routineId: { type: "string", description: "Routine ID when pausing, resuming, or deleting." },
        scheduleId: { type: "string", description: "Routine schedule ID when pausing, resuming, or deleting." },
        name: { type: "string", description: "Routine name (used to create, or to match an existing routine by name)." },
        instructions: { type: "string", description: "What the routine should do each time it runs." },
        cadence: { type: "string", enum: [...AGENT_ROUTINE_CADENCES], description: "Schedule cadence." },
        hour: { type: "number", description: "Hour of day (0-23) in the user's timezone." },
        minute: { type: "number", description: "Minute of hour (0-59)." },
        weekday: { type: "number", description: "Day of week for weekly cadence (0=Sunday .. 6=Saturday)." },
        monthday: { type: "number", description: "Day of month for monthly cadence (1-28)." },
        timezone: { type: "string", description: "IANA timezone (defaults to the user's current timezone)." },
      },
      required: ["action"],
    },
  },
};

export const AGENT_MEMORY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: AGENT_MEMORY_TOOL_NAME,
    description:
      "Remember a durable fact or rule in this agent's memory notes, forget an outdated note, or list existing notes.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["remember", "forget", "list"],
          description: "Use 'remember' to store a note, 'forget' to remove a note, or 'list' to read notes.",
        },
        text: { type: "string", description: "The note text to remember (max 1000 chars), or text to match when forgetting." },
        content: { type: "string", description: "The note text to remember (max 1000 chars), or text to match when forgetting." },
        noteId: { type: "string", description: "Optional note ID when forgetting a specific note." },
      },
      required: ["action"],
    },
  },
};

// ---------------------------------------------------------------------------
// Approval & preview helpers (pure)
// ---------------------------------------------------------------------------

export type AgentConfigApprovalRule =
  | "create_routine"
  | "enable_computer"
  | "reset_computer"
  | "disable_computer"
  | "raise_autonomy"
  | "add_connectors"
  | "change_model";

export function isStaleAgentApproval(
  requestedUpdatedAt: Date | string | number | null | undefined,
  currentUpdatedAt: Date | string | number | null | undefined
): boolean {
  if (requestedUpdatedAt == null || currentUpdatedAt == null) return false;
  const reqMs = requestedUpdatedAt instanceof Date ? requestedUpdatedAt.getTime() : new Date(requestedUpdatedAt).getTime();
  const curMs = currentUpdatedAt instanceof Date ? currentUpdatedAt.getTime() : new Date(currentUpdatedAt).getTime();
  if (Number.isNaN(reqMs) || Number.isNaN(curMs)) return false;
  return reqMs !== curMs;
}

export interface AgentSnapshotForConfig {
  id: string;
  name: string;
  role: string;
  style: string;
  instructions: string;
  approvalMode: string;
  notify?: string | null;
  proactive: boolean;
  status: string;
  model: string | null;
  reasoningEffort: string | null;
  connectorIds: readonly string[];
  computerEnabled?: boolean;
}

const AUTONOMY_RANK: Record<WorkPermissionPolicy, number> = {
  conservative: 0,
  balanced: 1,
  permissive: 2,
};

function normalizeAutonomy(value: string | undefined | null): WorkPermissionPolicy {
  if (value === "conservative" || value === "strict") return "conservative";
  if (value === "permissive") return "permissive";
  return "balanced";
}

function normalizeNotify(value: string | undefined | null): AgentNotifyLevel {
  if (value === "needs_you" || value === "all") return value;
  return "results";
}

function normalizeStyle(value: string | undefined | null): AgentStyle {
  if (value === "warm" || value === "direct" || value === "playful" || value === "formal") return value;
  return "warm";
}

/**
 * Determines whether a config tool call requires explicit user approval via
 * `requestActionApproval`, and returns the `juno_agents:<rule>` tool name plus
 * the structured diff preview for the approval card.
 */
export function classifyAgentConfigApproval(
  toolName: AgentConfigToolName,
  rawArgs: Record<string, unknown>,
  agent: AgentSnapshotForConfig | null,
  fallbackTimeZone = "UTC"
): {
  requiresApproval: boolean;
  ruleName: AgentConfigApprovalRule | null;
  headline: string;
  changes: ClientAgentChangeItem[];
} {
  const targetName =
    agent?.name || (typeof rawArgs.name === "string" && rawArgs.name.trim() ? rawArgs.name.trim() : "Agent");

  if (toolName === CREATE_AGENT_TOOL_NAME) {
    const routine =
      rawArgs.routine && typeof rawArgs.routine === "object" && !Array.isArray(rawArgs.routine)
        ? (rawArgs.routine as Record<string, unknown>)
        : null;
    if (routine) {
      const cadence = typeof routine.cadence === "string" ? routine.cadence : "daily";
      const hour = typeof routine.hour === "number" ? routine.hour : 9;
      const minute = typeof routine.minute === "number" ? routine.minute : 0;
      const tz = typeof routine.timezone === "string" && routine.timezone.trim() ? routine.timezone.trim() : fallbackTimeZone;
      const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${tz})`;
      return {
        requiresApproval: true,
        ruleName: "create_routine",
        headline: `${targetName} wants to add a recurring routine`,
        changes: [
          { label: "Agent", to: targetName },
          {
            label: "Routine",
            to: `${typeof routine.name === "string" ? routine.name : "Scheduled check"} · ${AGENT_ROUTINE_CADENCE_LABEL[cadence as AgentRoutineCadence] ?? cadence} at ${clock}`,
          },
        ],
      };
    }
    const requestedAutonomy = rawArgs.approvalMode ?? rawArgs.autonomy;
    if (requestedAutonomy === "permissive") {
      return {
        requiresApproval: true,
        ruleName: "raise_autonomy",
        headline: `${targetName} wants to run with permissive autonomy`,
        changes: [
          {
            label: "Autonomy",
            from: WORK_APPROVAL_MODE_LABEL.balanced,
            to: WORK_APPROVAL_MODE_LABEL.permissive,
          },
        ],
      };
    }
    if (rawArgs.computer === true || (rawArgs.computer && typeof rawArgs.computer === "object" && (rawArgs.computer as Record<string, unknown>).enabled === true)) {
      return {
        requiresApproval: true,
        ruleName: "enable_computer",
        headline: `${targetName} wants to enable its persistent computer`,
        changes: [{ label: "Computer", from: "Off", to: "Enabled" }],
      };
    }
    if (Array.isArray(rawArgs.apps) && rawArgs.apps.length > 0) {
      return {
        requiresApproval: true,
        ruleName: "add_connectors",
        headline: `${targetName} wants access to ${(rawArgs.apps as string[]).join(", ")}`,
        changes: [{ label: "Connected apps", from: "None", to: (rawArgs.apps as string[]).join(", ") }],
      };
    }
    return { requiresApproval: false, ruleName: null, headline: `Hire ${targetName}`, changes: [] };
  }

  if (toolName === AGENT_ROUTINE_TOOL_NAME) {
    const action = typeof rawArgs.action === "string" ? rawArgs.action : "add";
    if (action === "add" || action === "create") {
      const cadence = typeof rawArgs.cadence === "string" ? rawArgs.cadence : "daily";
      const hour = typeof rawArgs.hour === "number" ? rawArgs.hour : 9;
      const minute = typeof rawArgs.minute === "number" ? rawArgs.minute : 0;
      const tz = typeof rawArgs.timezone === "string" && rawArgs.timezone.trim() ? rawArgs.timezone.trim() : fallbackTimeZone;
      const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${tz})`;
      const rName = typeof rawArgs.name === "string" && rawArgs.name.trim() ? rawArgs.name.trim() : "Routine";
      return {
        requiresApproval: true,
        ruleName: "create_routine",
        headline: `${targetName} wants to add a recurring routine`,
        changes: [
          {
            label: "Routine",
            to: `${rName} · ${AGENT_ROUTINE_CADENCE_LABEL[cadence as AgentRoutineCadence] ?? cadence} at ${clock}`,
          },
        ],
      };
    }
    if (action === "resume" || action === "delete") {
      const rName = typeof rawArgs.name === "string" && rawArgs.name.trim() ? rawArgs.name.trim() : "Routine";
      return {
        requiresApproval: true,
        ruleName: "create_routine",
        headline: `${targetName} wants to ${action} routine ${rName}`,
        changes: [
          {
            label: "Routine",
            from: action === "resume" ? "Paused" : rName,
            to: action === "resume" ? "Active" : "Deleted",
          },
        ],
      };
    }
    return { requiresApproval: false, ruleName: null, headline: `Update routine`, changes: [] };
  }

  if (toolName === UPDATE_AGENT_TOOL_NAME && agent) {
    const computerObj =
      rawArgs.computer && typeof rawArgs.computer === "object" && !Array.isArray(rawArgs.computer)
        ? (rawArgs.computer as Record<string, unknown>)
        : null;
    const computerMode =
      typeof rawArgs.computer === "string"
        ? rawArgs.computer
        : computerObj?.enabled === true
          ? "on"
          : computerObj?.enabled === false
            ? "off"
            : null;
    const enablingComputer = computerMode === "on" && !agent.computerEnabled;
    const resettingComputer = computerMode === "reset";
    const disablingComputer = computerMode === "off" && Boolean(agent.computerEnabled);

    const rawAutonomy = typeof rawArgs.approvalMode === "string" ? rawArgs.approvalMode : rawArgs.autonomy;
    const nextMode =
      typeof rawAutonomy === "string" &&
      (WORK_PERMISSION_POLICIES as readonly string[]).includes(rawAutonomy)
        ? (rawAutonomy as WorkPermissionPolicy)
        : null;
    const prevMode = normalizeAutonomy(agent.approvalMode);
    const raisingAutonomy = nextMode !== null && AUTONOMY_RANK[nextMode] > AUTONOMY_RANK[prevMode];
    const enablingProactive = rawArgs.proactive === true && !agent.proactive;

    const requestedConnectors = Array.isArray(rawArgs.connectorIds)
      ? rawArgs.connectorIds.filter((c): c is string => typeof c === "string")
      : Array.isArray(rawArgs.addApps)
        ? [...new Set([...agent.connectorIds, ...rawArgs.addApps.filter((c): c is string => typeof c === "string")])]
        : null;
    const addedConnectors = requestedConnectors
      ? requestedConnectors.filter((c) => !agent.connectorIds.includes(c))
      : [];

    const changingModel =
      (typeof rawArgs.model === "string" && rawArgs.model !== (agent.model ?? "")) ||
      (typeof rawArgs.reasoningEffort === "string" && rawArgs.reasoningEffort !== (agent.reasoningEffort ?? ""));

    const approvalChanges: ClientAgentChangeItem[] = [];
    let ruleName: AgentConfigApprovalRule | null = null;
    let headline = `${targetName} wants to update its permissions`;

    if (enablingComputer) {
      ruleName = "enable_computer";
      headline = `${targetName} wants to enable its persistent computer`;
      approvalChanges.push({ label: "Computer", from: "Off", to: "Enabled" });
    } else if (resettingComputer) {
      ruleName = "reset_computer";
      headline = `${targetName} wants to reset its computer (sign-ins and files will be cleared)`;
      approvalChanges.push({ label: "Computer", from: "Enabled", to: "Reset (clears sign-ins & files)" });
    } else if (disablingComputer) {
      ruleName = "disable_computer";
      headline = `${targetName} wants to turn off its computer (sign-ins and files will be deleted)`;
      approvalChanges.push({ label: "Computer", from: "Enabled", to: "Off (deletes sign-ins & files)" });
    }
    if (raisingAutonomy && nextMode) {
      ruleName = ruleName ?? "raise_autonomy";
      if (!enablingComputer) {
        headline = `${targetName} wants to raise its autonomy`;
      }
      approvalChanges.push({
        label: "Autonomy",
        from: WORK_APPROVAL_MODE_LABEL[prevMode],
        to: WORK_APPROVAL_MODE_LABEL[nextMode],
      });
    }
    if (enablingProactive) {
      ruleName = ruleName ?? "raise_autonomy";
      approvalChanges.push({ label: "Proactive ideas", from: "Off", to: "On" });
    }
    if (addedConnectors.length > 0) {
      ruleName = ruleName ?? "add_connectors";
      if (!enablingComputer && !raisingAutonomy) {
        headline = `${targetName} wants access to ${addedConnectors.join(", ")}`;
      }
      approvalChanges.push({
        label: "Connected apps",
        from: agent.connectorIds.length > 0 ? agent.connectorIds.join(", ") : "None",
        to: requestedConnectors!.join(", "),
      });
    }
    if (changingModel) {
      ruleName = ruleName ?? "change_model";
      if (approvalChanges.length === 0) {
        headline = `${targetName} wants to change its model or reasoning effort`;
      }
      if (typeof rawArgs.model === "string" && rawArgs.model !== (agent.model ?? "")) {
        approvalChanges.push({
          label: "Model",
          from: agent.model ?? "Default",
          to: rawArgs.model || "Default",
        });
      }
      if (typeof rawArgs.reasoningEffort === "string" && rawArgs.reasoningEffort !== (agent.reasoningEffort ?? "")) {
        approvalChanges.push({
          label: "Reasoning effort",
          from: agent.reasoningEffort ?? "Default",
          to: rawArgs.reasoningEffort || "Default",
        });
      }
    }

    if (ruleName) {
      return {
        requiresApproval: true,
        ruleName,
        headline,
        changes: approvalChanges,
      };
    }
  }

  return { requiresApproval: false, ruleName: null, headline: `Update ${targetName}`, changes: [] };
}

/**
 * Builds the human-readable diff items (`label: from → to`) for `update_agent`.
 */
export function describeAgentPatchChanges(
  before: AgentSnapshotForConfig,
  rawArgs: Record<string, unknown>
): ClientAgentChangeItem[] {
  const changes: ClientAgentChangeItem[] = [];
  if (typeof rawArgs.name === "string" && rawArgs.name.trim() && rawArgs.name.trim() !== before.name) {
    changes.push({ label: "Name", from: before.name, to: rawArgs.name.trim() });
  }
  if (typeof rawArgs.role === "string" && rawArgs.role.trim() !== before.role) {
    changes.push({ label: "Role", from: before.role || "None", to: rawArgs.role.trim() || "None" });
  }
  if (typeof rawArgs.style === "string" && rawArgs.style !== before.style) {
    const prev = normalizeStyle(before.style);
    const next = normalizeStyle(rawArgs.style);
    changes.push({ label: "Style", from: AGENT_STYLE_LABEL[prev], to: AGENT_STYLE_LABEL[next] });
  }
  if (typeof rawArgs.instructions === "string" && rawArgs.instructions.trim() !== before.instructions.trim()) {
    changes.push({
      label: "Instructions",
      from: before.instructions.trim() ? `${before.instructions.trim().slice(0, 60)}${before.instructions.trim().length > 60 ? "…" : ""}` : "Empty",
      to: rawArgs.instructions.trim() ? `${rawArgs.instructions.trim().slice(0, 60)}${rawArgs.instructions.trim().length > 60 ? "…" : ""}` : "Empty",
    });
  } else if (typeof rawArgs.addToInstructions === "string" && rawArgs.addToInstructions.trim()) {
    changes.push({
      label: "Instructions",
      to: `+ ${rawArgs.addToInstructions.trim().slice(0, 60)}`,
    });
  }
  const rawAutonomy = typeof rawArgs.approvalMode === "string" ? rawArgs.approvalMode : rawArgs.autonomy;
  if (typeof rawAutonomy === "string" && rawAutonomy !== before.approvalMode) {
    const prev = normalizeAutonomy(before.approvalMode);
    const next = normalizeAutonomy(rawAutonomy);
    changes.push({ label: "Autonomy", from: WORK_APPROVAL_MODE_LABEL[prev], to: WORK_APPROVAL_MODE_LABEL[next] });
  }
  if (typeof rawArgs.notify === "string" && rawArgs.notify !== normalizeNotify(before.notify)) {
    const prev = normalizeNotify(before.notify);
    const next = normalizeNotify(rawArgs.notify);
    changes.push({ label: "Notifications", from: AGENT_NOTIFY_LABEL[prev], to: AGENT_NOTIFY_LABEL[next] });
  }
  if (typeof rawArgs.proactive === "boolean" && rawArgs.proactive !== before.proactive) {
    changes.push({ label: "Proactive ideas", from: before.proactive ? "On" : "Off", to: rawArgs.proactive ? "On" : "Off" });
  }
  if (typeof rawArgs.pinned === "boolean") {
    changes.push({ label: "Pinned", to: rawArgs.pinned ? "Pinned" : "Unpinned" });
  }
  if (typeof rawArgs.status === "string" && rawArgs.status !== before.status) {
    changes.push({
      label: "Status",
      from: before.status === "paused" ? "Paused" : "Active",
      to: rawArgs.status === "paused" ? "Paused" : "Active",
    });
  }
  if (rawArgs.model !== undefined && rawArgs.model !== before.model) {
    changes.push({
      label: "Model",
      from: before.model ?? "Default",
      to: typeof rawArgs.model === "string" ? rawArgs.model : "Default",
    });
  }
  if (Array.isArray(rawArgs.connectorIds)) {
    const nextIds = rawArgs.connectorIds.filter((c): c is string => typeof c === "string");
    if (nextIds.join(",") !== before.connectorIds.join(",")) {
      changes.push({
        label: "Connected apps",
        from: before.connectorIds.length > 0 ? before.connectorIds.join(", ") : "None",
        to: nextIds.length > 0 ? nextIds.join(", ") : "None",
      });
    }
  }
  const computerObj =
    rawArgs.computer && typeof rawArgs.computer === "object" && !Array.isArray(rawArgs.computer)
      ? (rawArgs.computer as Record<string, unknown>)
      : null;
  const computerMode =
    typeof rawArgs.computer === "string"
      ? rawArgs.computer
      : computerObj?.enabled === true
        ? "on"
        : computerObj?.enabled === false
          ? "off"
          : null;
  if (computerMode === "reset") {
    changes.push({
      label: "Computer",
      from: "Enabled",
      to: "Reset",
    });
  } else if (computerMode === "on" || computerMode === "off") {
    const nextEnabled = computerMode === "on";
    if (nextEnabled !== Boolean(before.computerEnabled)) {
      changes.push({
        label: "Computer",
        from: before.computerEnabled ? "Enabled" : "Off",
        to: nextEnabled ? "Enabled" : "Off",
      });
    }
  }
  return changes;
}

/**
 * Formats a concise activity summary for the tool call pill in the transcript.
 */
export function summarizeAgentConfigToolInput(toolName: string, argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (toolName === CREATE_AGENT_TOOL_NAME && typeof parsed.name === "string") {
      return `Hire ${parsed.name.trim()}`;
    }
    if (toolName === UPDATE_AGENT_TOOL_NAME) {
      const keys = Object.keys(parsed);
      return keys.length > 0 ? `Update ${keys.join(", ")}` : "Update profile";
    }
    if (toolName === AGENT_GOAL_TOOL_NAME) {
      const action = typeof parsed.action === "string" ? parsed.action : "update";
      const title = typeof parsed.title === "string" ? `: ${parsed.title.trim()}` : "";
      return `Goal (${action})${title}`;
    }
    if (toolName === AGENT_ROUTINE_TOOL_NAME) {
      const action = typeof parsed.action === "string" ? parsed.action : "add";
      const name = typeof parsed.name === "string" ? `: ${parsed.name.trim()}` : "";
      return `Routine (${action})${name}`;
    }
    if (toolName === AGENT_MEMORY_TOOL_NAME) {
      const action = typeof parsed.action === "string" ? parsed.action : "remember";
      return action === "forget" ? "Forget note" : "Remember note";
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server tool factory
// ---------------------------------------------------------------------------

export interface AgentConfigToolsContext {
  user: { id: string; email?: string | null; name?: string | null };
  conversation: { id: string; projectId: string | null };
  /** Present when the conversation is an agent's thread; null in a general Juno chat. */
  agent: AgentSnapshotForConfig | null;
  userMessageId: string;
  /** True when any connector, web search, fetched URL or untrusted source ran in this turn. */
  untrustedContent: boolean;
  /** The user's IANA timezone from the chat request body, or undefined. */
  timeZone?: string;
  generationId: string;
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  onAgentChange?: (change: ClientAgentChange) => void;
}

function jsonExecution(payload: Record<string, unknown>, extra?: Partial<ToolExecution>): ToolExecution {
  const ok = payload.status !== "refused";
  const body =
    typeof payload.message === "string"
      ? payload.message
      : extra?.agentChange?.summary ??
        (typeof payload.status === "string" ? payload.status : "Done.");
  return {
    text: JSON.stringify(payload),
    body,
    ok,
    ...extra,
  };
}

export function createAgentConfigTools(ctx: AgentConfigToolsContext): NativeChatTool[] {
  let queue: Promise<unknown> = Promise.resolve();
  let callIndex = 0;

  const serializeCall = (fn: () => Promise<ToolExecution>): Promise<ToolExecution> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const guardAndApprove = async (
    toolName: AgentConfigToolName,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<
    | { ok: false; response: ToolExecution }
    | { ok: true; freshAgent: import("@prisma/client").Agent | null }
  > => {
    if (signal?.aborted) {
      return {
        ok: false,
        response: jsonExecution({ status: "refused", reason: "stopped", message: "The reply was stopped." }),
      };
    }

    // Rule 1: Prompt injection defense — never self-modify when untrusted content is in the turn.
    if (ctx.untrustedContent) {
      return {
        ok: false,
        response: jsonExecution({
          status: "refused",
          reason: "untrusted_content_in_turn",
          message: UNTRUSTED_CONFIG_REFUSAL_MESSAGE,
        }),
      };
    }

    const [{ prisma }, agents, approvals, { rateLimit }] = await Promise.all([
      import("@/lib/prisma"),
      import("@/lib/agents/store"),
      import("@/lib/action-approval-store"),
      import("@/lib/rate-limit"),
    ]);

    let freshAgent: import("@prisma/client").Agent | null = null;
    if (ctx.agent) {
      freshAgent = await agents.findAgent(ctx.user.id, ctx.agent.id);
      if (!freshAgent) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: "not_found",
            message: "This agent no longer exists.",
          }),
        };
      }
    } else if (toolName === UPDATE_AGENT_TOOL_NAME) {
      const requestedName = typeof rawArgs.agent === "string" ? rawArgs.agent.trim() : "";
      if (!requestedName) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: "invalid_arguments",
            message: "Specify the agent name when updating an agent from outside its thread.",
          }),
        };
      }
      const roster = await prisma.agent.findMany({
        where: { userId: ctx.user.id, status: { not: "retired" } },
      });
      const exact = roster.filter((a) => a.name === requestedName);
      const matches =
        exact.length > 0
          ? exact
          : roster.filter((a) => a.name.toLowerCase() === requestedName.toLowerCase());
      if (matches.length === 0) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: "not_found",
            message: `Could not find an agent named "${requestedName}".`,
          }),
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: "ambiguous_agent",
            message: `More than one agent is named "${requestedName}". Rename one first.`,
          }),
        };
      }
      freshAgent = matches[0]!;
    }

    if (freshAgent && toolName !== CREATE_AGENT_TOOL_NAME) {
      const isResumingSelf =
        toolName === UPDATE_AGENT_TOOL_NAME && rawArgs.status === "active";
      if (freshAgent.status !== "active" && !isResumingSelf) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: "agent_paused",
            message: PAUSED_CONFIG_REFUSAL_MESSAGE,
          }),
        };
      }
    }

    const limit = await rateLimit({ key: `agents:config:${ctx.user.id}`, ...AGENT_CONFIG_RATE_LIMIT });
    if (!limit.success) {
      return {
        ok: false,
        response: jsonExecution({
          status: "refused",
          reason: "rate_limited",
          message: "Too many configuration changes were made this hour. Try again shortly.",
        }),
      };
    }

    let snapshot = ctx.agent;
    if (freshAgent) {
      const compRow = await prisma.agentComputer
        .findUnique({ where: { agentId: freshAgent.id }, select: { status: true } })
        .catch(() => null);
      snapshot = {
        id: freshAgent.id,
        name: freshAgent.name,
        role: freshAgent.role,
        style: freshAgent.style,
        instructions: freshAgent.instructions,
        approvalMode: freshAgent.approvalMode,
        notify: (freshAgent as { notify?: string | null }).notify ?? "results",
        proactive: freshAgent.proactive,
        status: freshAgent.status,
        model: freshAgent.model,
        reasoningEffort: freshAgent.reasoningEffort,
        connectorIds: freshAgent.connectorIds,
        computerEnabled: Boolean(compRow && compRow.status !== "disabled"),
      };
    }

    const classification = classifyAgentConfigApproval(
      toolName,
      rawArgs,
      snapshot,
      ctx.timeZone || "UTC"
    );

    if (classification.requiresApproval && classification.ruleName) {
      const requestedUpdatedAt = freshAgent?.updatedAt;
      const seq = ++callIndex;
      const approval = await approvals.requestActionApproval({
        userId: ctx.user.id,
        conversationId: ctx.conversation.id,
        generationId: ctx.generationId,
        callId: `agent-config-approval:${ctx.userMessageId}:${toolName}:${seq}`,
        provider: "juno_agents",
        toolName: classification.ruleName,
        args: {
          ...rawArgs,
          preview: {
            headline: classification.headline,
            changes: classification.changes,
          },
        },
        allowAlways: false,
        signal,
        onCreated: (created) => ctx.onApprovalRequest?.(created),
      });
      if (!approval.approved) {
        return {
          ok: false,
          response: jsonExecution({
            status: "refused",
            reason: approval.reason,
            message:
              approval.reason === "denied"
                ? "The user declined this configuration change."
                : "The configuration change was not approved.",
          }),
        };
      }
      if (freshAgent) {
        const latestAgent = await agents.findAgent(ctx.user.id, freshAgent.id);
        if (!latestAgent || isStaleAgentApproval(requestedUpdatedAt, latestAgent.updatedAt)) {
          return {
            ok: false,
            response: jsonExecution({
              status: "refused",
              reason: "stale_approval",
              message: `${freshAgent.name} changed since you were asked. Ask again.`,
            }),
          };
        }
        freshAgent = latestAgent;
      }
    }

    return { ok: true, freshAgent };
  };

  const createTool: NativeChatTool = {
    tool: CREATE_AGENT_TOOL,
    label: AGENT_CONFIG_TOOL_LABELS.create_agent,
    access: "write",
    execute: (rawArgs: Record<string, unknown>, signal?: AbortSignal) =>
      serializeCall(async () => {
        const check = await guardAndApprove(CREATE_AGENT_TOOL_NAME, rawArgs, signal);
        if (!check.ok) return check.response;

        const avatarArg: Record<string, unknown> = {};
        if (typeof rawArgs.faceShape === "string") avatarArg.shape = rawArgs.faceShape;
        if (typeof rawArgs.faceTone === "string") avatarArg.tone = rawArgs.faceTone;
        if (typeof rawArgs.faceEyes === "string") avatarArg.eyes = rawArgs.faceEyes;
        if (typeof rawArgs.faceMark === "string") avatarArg.mark = rawArgs.faceMark;

        const parsed = createAgentSchema.safeParse({
          name: rawArgs.name,
          role: rawArgs.role,
          template: rawArgs.template,
          style: rawArgs.style,
          instructions: rawArgs.instructions,
          ...(Object.keys(avatarArg).length > 0 ? { avatar: avatarArg } : {}),
          approvalMode: rawArgs.approvalMode ?? rawArgs.autonomy,
          connectorIds: Array.isArray(rawArgs.apps) ? rawArgs.apps : rawArgs.connectorIds,
          notify: rawArgs.notify,
          firstGoal: rawArgs.firstGoal,
          projectId: ctx.conversation.projectId ?? undefined,
        });
        if (!parsed.success) {
          return jsonExecution({
            status: "refused",
            reason: "invalid_arguments",
            message: parsed.error.issues[0]?.message ?? "Invalid agent configuration.",
          });
        }

        const agents = await import("@/lib/agents/store");
        const created = await agents.createAgentForUser(ctx.user, parsed.data);
        if (created.status !== 201 || !created.value) {
          return jsonExecution({
            status: "refused",
            reason: String(created.body.error ?? "create_failed"),
            message: String(created.body.message ?? "Could not create the agent."),
          });
        }

        const changes: ClientAgentChangeItem[] = [
          { label: "Name", to: created.value.name },
          ...(created.value.role ? [{ label: "Role", to: created.value.role }] : []),
        ];

        if (parsed.data.firstGoal) {
          changes.push({ label: "Goal", to: parsed.data.firstGoal });
        }

        if (rawArgs.computer === true || (rawArgs.computer && typeof rawArgs.computer === "object" && (rawArgs.computer as Record<string, unknown>).enabled === true)) {
          const computer = await import("@/lib/computer/store");
          await computer.enableComputer(ctx.user.id, created.value.id).catch(() => {});
          changes.push({ label: "Computer", to: "Enabled" });
        }

        const routineRaw =
          rawArgs.routine && typeof rawArgs.routine === "object" && !Array.isArray(rawArgs.routine)
            ? (rawArgs.routine as Record<string, unknown>)
            : null;
        if (routineRaw) {
          const freshRow = await agents.findAgent(ctx.user.id, created.value.id);
          const routineInput = createRoutineSchema.safeParse({
            ...routineRaw,
            timezone:
              typeof routineRaw.timezone === "string" && routineRaw.timezone.trim()
                ? routineRaw.timezone.trim()
                : ctx.timeZone || "UTC",
          });
          if (freshRow && routineInput.success) {
            const routineRes = await agents.createAgentRoutine(ctx.user, freshRow, routineInput.data);
            if (routineRes.status === 201 && routineRes.value) {
              changes.push({
                label: "Routine",
                to: `${routineRes.value.name} (${routineRes.value.schedule})`,
              });
            }
          }
        }

        const change: ClientAgentChange = {
          agentId: created.value.id,
          agentName: created.value.name,
          summary: `Hired ${created.value.name}`,
          changes,
        };
        ctx.onAgentChange?.(change);

        return jsonExecution(
          {
            status: "created",
            agentId: created.value.id,
            name: created.value.name,
            role: created.value.role,
            conversationId: created.value.conversationId,
            url: created.value.conversationId ? `/chat/${created.value.conversationId}` : `/agents/${created.value.id}`,
          },
          { agentChange: change }
        );
      }),
  };

  const updateTool: NativeChatTool = {
    tool: UPDATE_AGENT_TOOL,
    label: AGENT_CONFIG_TOOL_LABELS.update_agent,
    access: "write",
    execute: (rawArgs: Record<string, unknown>, signal?: AbortSignal) =>
      serializeCall(async () => {
        const check = await guardAndApprove(UPDATE_AGENT_TOOL_NAME, rawArgs, signal);
        if (!check.ok) return check.response;
        const freshAgent = check.freshAgent!;

        const [{ prisma }, agents, computer] = await Promise.all([
          import("@/lib/prisma"),
          import("@/lib/agents/store"),
          import("@/lib/computer/store"),
        ]);

        const compRow = await prisma.agentComputer
          .findUnique({ where: { agentId: freshAgent.id }, select: { status: true } })
          .catch(() => null);
        const beforeSnapshot: AgentSnapshotForConfig = {
          id: freshAgent.id,
          name: freshAgent.name,
          role: freshAgent.role,
          style: freshAgent.style,
          instructions: freshAgent.instructions,
          approvalMode: freshAgent.approvalMode,
          notify: (freshAgent as { notify?: string | null }).notify ?? "results",
          proactive: freshAgent.proactive,
          status: freshAgent.status,
          model: freshAgent.model,
          reasoningEffort: freshAgent.reasoningEffort,
          connectorIds: freshAgent.connectorIds,
          computerEnabled: Boolean(compRow && compRow.status !== "disabled"),
        };

        const computerObj =
          rawArgs.computer && typeof rawArgs.computer === "object" && !Array.isArray(rawArgs.computer)
            ? (rawArgs.computer as Record<string, unknown>)
            : null;
        const computerMode =
          typeof rawArgs.computer === "string"
            ? rawArgs.computer
            : computerObj?.enabled === true
              ? "on"
              : computerObj?.enabled === false
                ? "off"
                : null;

        const {
          computer: _ignoredComputer,
          agent: _ignoredAgent,
          autonomy,
          addToInstructions,
          faceShape,
          faceTone,
          faceEyes,
          faceMark,
          addApps,
          removeApps,
          ...restPatch
        } = rawArgs;

        const agentPatchFields: Record<string, unknown> = { ...restPatch };
        if (agentPatchFields.approvalMode === undefined && typeof autonomy === "string") {
          agentPatchFields.approvalMode = autonomy;
        }
        if (typeof addToInstructions === "string" && addToInstructions.trim()) {
          const currentInstructions = freshAgent.instructions.trim();
          agentPatchFields.instructions = currentInstructions
            ? `${currentInstructions}\n${addToInstructions.trim()}`
            : addToInstructions.trim();
        }
        if (
          typeof faceShape === "string" ||
          typeof faceTone === "string" ||
          typeof faceEyes === "string" ||
          typeof faceMark === "string"
        ) {
          const prevAvatar =
            typeof freshAgent.avatar === "object" &&
            freshAgent.avatar !== null &&
            !Array.isArray(freshAgent.avatar)
              ? (freshAgent.avatar as Record<string, unknown>)
              : {};
          agentPatchFields.avatar = {
            shape: typeof faceShape === "string" ? faceShape : prevAvatar.shape,
            tone: typeof faceTone === "string" ? faceTone : prevAvatar.tone,
            eyes: typeof faceEyes === "string" ? faceEyes : prevAvatar.eyes,
            mark: typeof faceMark === "string" ? faceMark : prevAvatar.mark,
          };
        }
        if (agentPatchFields.connectorIds === undefined && (Array.isArray(addApps) || Array.isArray(removeApps))) {
          const removeSet = new Set(
            Array.isArray(removeApps) ? removeApps.filter((c): c is string => typeof c === "string") : []
          );
          const added = Array.isArray(addApps) ? addApps.filter((c): c is string => typeof c === "string") : [];
          agentPatchFields.connectorIds = [
            ...new Set([...freshAgent.connectorIds.filter((c) => !removeSet.has(c)), ...added]),
          ];
        }

        let eventId: string | undefined;
        let updatedName = freshAgent.name;

        if (Object.keys(agentPatchFields).length > 0) {
          const parsedPatch = patchAgentSchema.safeParse(agentPatchFields);
          if (!parsedPatch.success) {
            return jsonExecution({
              status: "refused",
              reason: "invalid_arguments",
              message: parsedPatch.error.issues[0]?.message ?? "Invalid agent update fields.",
            });
          }
          const result = await agents.updateAgentForUser(ctx.user, freshAgent.id, parsedPatch.data);
          if (result.status !== 200 || !result.value) {
            return jsonExecution({
              status: "refused",
              reason: String(result.body.error ?? "update_failed"),
              message: String(result.body.message ?? "Could not update the agent."),
            });
          }
          eventId = result.eventId;
          updatedName = result.value.name;
        }

        if (computerMode === "on") {
          await computer.enableComputer(ctx.user.id, freshAgent.id);
        } else if (computerMode === "off") {
          await computer.disableComputer(ctx.user.id, freshAgent.id);
        } else if (computerMode === "reset") {
          await computer.resetComputer(ctx.user.id, freshAgent.id);
        }

        const changes = describeAgentPatchChanges(beforeSnapshot, rawArgs);
        const change: ClientAgentChange = {
          agentId: freshAgent.id,
          agentName: updatedName,
          ...(eventId ? { eventId } : {}),
          summary: `Updated ${updatedName}`,
          changes: changes.length > 0 ? changes : [{ label: "Profile", to: "Updated" }],
        };
        ctx.onAgentChange?.(change);

        return jsonExecution(
          {
            status: "updated",
            agentId: freshAgent.id,
            ...(eventId ? { eventId } : {}),
            changes: change.changes,
          },
          { agentChange: change }
        );
      }),
  };

  if (!ctx.agent) {
    return [createTool, updateTool];
  }

  const goalTool: NativeChatTool = {
    tool: AGENT_GOAL_TOOL,
    label: AGENT_CONFIG_TOOL_LABELS.agent_goal,
    access: "write",
    execute: (rawArgs: Record<string, unknown>, signal?: AbortSignal) =>
      serializeCall(async () => {
        const check = await guardAndApprove(AGENT_GOAL_TOOL_NAME, rawArgs, signal);
        if (!check.ok) return check.response;
        const freshAgent = check.freshAgent!;

        const [{ prisma }, agents] = await Promise.all([
          import("@/lib/prisma"),
          import("@/lib/agents/store"),
        ]);

        const action = typeof rawArgs.action === "string" ? rawArgs.action : "add";
        const title = typeof rawArgs.title === "string" ? rawArgs.title.trim() : "";
        const detail = typeof rawArgs.detail === "string" ? rawArgs.detail.trim() : "";
        const cadence =
          typeof rawArgs.cadence === "string" && (AGENT_GOAL_CADENCES as readonly string[]).includes(rawArgs.cadence)
            ? rawArgs.cadence
            : "weekly";
        const dueAt = typeof rawArgs.dueAt === "string" ? rawArgs.dueAt : null;

        if (action === "add") {
          if (!title) {
            return jsonExecution({
              status: "refused",
              reason: "invalid_arguments",
              message: "A goal needs a title.",
            });
          }
          const created = await agents.createAgentGoal(ctx.user, freshAgent, {
            title,
            detail,
            cadence,
            dueAt,
          });
          if (created.status !== 201) {
            return jsonExecution({
              status: "refused",
              reason: String(created.body.error ?? "goal_failed"),
              message: String(created.body.message ?? "Could not add goal."),
            });
          }
          const change: ClientAgentChange = {
            agentId: freshAgent.id,
            agentName: freshAgent.name,
            ...(created.eventId ? { eventId: created.eventId } : {}),
            summary: `Added goal for ${freshAgent.name}`,
            changes: [{ label: "Goal", to: title }],
          };
          ctx.onAgentChange?.(change);
          return jsonExecution(
            { status: "updated", action: "add", goal: created.body.goal, eventId: created.eventId },
            { agentChange: change }
          );
        }

        // Locate existing goal by goalId or case-insensitive title match
        let targetGoalId = typeof rawArgs.goalId === "string" ? rawArgs.goalId.trim() : "";
        let existingTitle = title;
        let previousStatus = "active";
        if (!targetGoalId && title) {
          const existing = await prisma.agentGoal.findFirst({
            where: {
              userId: ctx.user.id,
              agentId: freshAgent.id,
              title: { equals: title, mode: "insensitive" },
            },
            orderBy: { createdAt: "desc" },
          });
          if (existing) {
            targetGoalId = existing.id;
            existingTitle = existing.title;
            previousStatus = existing.status;
          }
        } else if (targetGoalId) {
          const existing = await prisma.agentGoal.findFirst({
            where: { id: targetGoalId, userId: ctx.user.id, agentId: freshAgent.id },
          });
          if (existing) {
            existingTitle = existing.title;
            previousStatus = existing.status;
          }
        }

        if (!targetGoalId) {
          return jsonExecution({
            status: "refused",
            reason: "not_found",
            message: "Could not find a matching goal to update.",
          });
        }

        const nextStatus =
          action === "achieve"
            ? "achieved"
            : action === "pause"
              ? "paused"
              : action === "resume"
                ? "active"
                : action === "drop"
                  ? "dropped"
                  : typeof rawArgs.status === "string" && (AGENT_GOAL_STATUSES as readonly string[]).includes(rawArgs.status)
                    ? rawArgs.status
                    : undefined;

        const updated = await agents.updateAgentGoal(ctx.user, freshAgent, targetGoalId, {
          ...(title ? { title } : {}),
          ...(rawArgs.detail !== undefined ? { detail } : {}),
          ...(rawArgs.cadence !== undefined ? { cadence } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(rawArgs.dueAt !== undefined ? { dueAt } : {}),
        });
        if (updated.status !== 200) {
          return jsonExecution({
            status: "refused",
            reason: String(updated.body.error ?? "goal_failed"),
            message: String(updated.body.message ?? "Could not update goal."),
          });
        }

        const change: ClientAgentChange = {
          agentId: freshAgent.id,
          agentName: freshAgent.name,
          ...(updated.eventId ? { eventId: updated.eventId } : {}),
          summary: `Updated goal for ${freshAgent.name}`,
          changes: [
            {
              label: `Goal (${existingTitle || "goal"})`,
              from: previousStatus,
              to: nextStatus ?? (title || "updated"),
            },
          ],
        };
        ctx.onAgentChange?.(change);
        return jsonExecution(
          { status: "updated", action, goal: updated.body.goal, eventId: updated.eventId },
          { agentChange: change }
        );
      }),
  };

  const routineTool: NativeChatTool = {
    tool: AGENT_ROUTINE_TOOL,
    label: AGENT_CONFIG_TOOL_LABELS.agent_routine,
    access: "write",
    execute: (rawArgs: Record<string, unknown>, signal?: AbortSignal) =>
      serializeCall(async () => {
        const check = await guardAndApprove(AGENT_ROUTINE_TOOL_NAME, rawArgs, signal);
        if (!check.ok) return check.response;
        const freshAgent = check.freshAgent!;

        const [{ prisma }, agents] = await Promise.all([
          import("@/lib/prisma"),
          import("@/lib/agents/store"),
        ]);

        const action = typeof rawArgs.action === "string" ? rawArgs.action : "add";
        if (action === "add" || action === "create") {
          const parsed = createRoutineSchema.safeParse({
            name: rawArgs.name,
            instructions: rawArgs.instructions,
            cadence: rawArgs.cadence ?? "daily",
            hour: rawArgs.hour ?? 9,
            minute: rawArgs.minute ?? 0,
            weekday: rawArgs.weekday ?? 1,
            monthday: rawArgs.monthday ?? 1,
            timezone:
              typeof rawArgs.timezone === "string" && rawArgs.timezone.trim()
                ? rawArgs.timezone.trim()
                : ctx.timeZone || "UTC",
          });
          if (!parsed.success) {
            return jsonExecution({
              status: "refused",
              reason: "invalid_arguments",
              message: parsed.error.issues[0]?.message ?? "Invalid routine schedule.",
            });
          }
          const created = await agents.createAgentRoutine(ctx.user, freshAgent, parsed.data);
          if (created.status !== 201 || !created.value) {
            return jsonExecution({
              status: "refused",
              reason: String(created.body.error ?? "routine_failed"),
              message: String(created.body.message ?? "Could not create routine."),
            });
          }
          const change: ClientAgentChange = {
            agentId: freshAgent.id,
            agentName: freshAgent.name,
            ...(created.eventId ? { eventId: created.eventId } : {}),
            summary: `Scheduled ${created.value.name}`,
            changes: [
              {
                label: "Routine",
                to: `${created.value.name} · ${created.value.schedule} (${created.value.timezone})`,
              },
            ],
          };
          ctx.onAgentChange?.(change);
          return jsonExecution(
            { status: "created", routine: created.value, eventId: created.eventId },
            { agentChange: change }
          );
        }

        // Pause, resume, or delete existing routine
        let scheduleId =
          typeof rawArgs.routineId === "string" && rawArgs.routineId.trim()
            ? rawArgs.routineId.trim()
            : typeof rawArgs.scheduleId === "string"
              ? rawArgs.scheduleId.trim()
              : "";
        const name = typeof rawArgs.name === "string" ? rawArgs.name.trim() : "";
        if (!scheduleId && name) {
          const match = await prisma.workSchedule.findFirst({
            where: {
              userId: ctx.user.id,
              session: { userId: ctx.user.id, agentId: freshAgent.id, deletedAt: null },
              name: { equals: name, mode: "insensitive" },
            },
            orderBy: { createdAt: "desc" },
          });
          if (match) scheduleId = match.id;
        }
        if (!scheduleId) {
          return jsonExecution({
            status: "refused",
            reason: "not_found",
            message: "Could not find a matching routine.",
          });
        }

        if (action === "delete") {
          const existingSchedule = await prisma.workSchedule.findFirst({
            where: { id: scheduleId, userId: ctx.user.id },
          });
          if (!existingSchedule) {
            return jsonExecution({
              status: "refused",
              reason: "not_found",
              message: "Could not find a matching routine.",
            });
          }
          await prisma.workSchedule.delete({ where: { id: scheduleId } });
          const change: ClientAgentChange = {
            agentId: freshAgent.id,
            agentName: freshAgent.name,
            summary: `Deleted routine ${existingSchedule.name}`,
            changes: [{ label: `Routine (${existingSchedule.name})`, from: "Scheduled", to: "Deleted" }],
          };
          ctx.onAgentChange?.(change);
          return jsonExecution(
            { status: "deleted", routineId: scheduleId },
            { agentChange: change }
          );
        }

        const enabled = action === "resume";
        const updated = await agents.updateAgentRoutine(ctx.user, freshAgent, scheduleId, enabled);
        if (updated.status !== 200 || !updated.value) {
          return jsonExecution({
            status: "refused",
            reason: String(updated.body.error ?? "routine_failed"),
            message: String(updated.body.message ?? "Could not update routine."),
          });
        }
        const change: ClientAgentChange = {
          agentId: freshAgent.id,
          agentName: freshAgent.name,
          ...(updated.eventId ? { eventId: updated.eventId } : {}),
          summary: `${enabled ? "Resumed" : "Paused"} ${updated.value.name}`,
          changes: [
            {
              label: `Routine (${updated.value.name})`,
              from: enabled ? "Paused" : "Active",
              to: enabled ? "Active" : "Paused",
            },
          ],
        };
        ctx.onAgentChange?.(change);
        return jsonExecution(
          { status: "updated", routine: updated.value, eventId: updated.eventId },
          { agentChange: change }
        );
      }),
  };

  const memoryTool: NativeChatTool = {
    tool: AGENT_MEMORY_TOOL,
    label: AGENT_CONFIG_TOOL_LABELS.agent_memory,
    access: "write",
    execute: (rawArgs: Record<string, unknown>, signal?: AbortSignal) =>
      serializeCall(async () => {
        const check = await guardAndApprove(AGENT_MEMORY_TOOL_NAME, rawArgs, signal);
        if (!check.ok) return check.response;
        const freshAgent = check.freshAgent!;

        const agents = await import("@/lib/agents/store");
        const action = typeof rawArgs.action === "string" ? rawArgs.action : "remember";
        const rawText = typeof rawArgs.text === "string" ? rawArgs.text : rawArgs.content;
        const content = typeof rawText === "string" ? rawText.trim().slice(0, 500) : "";

        if (action === "list") {
          const notes = await agents.listAgentNotes(ctx.user, freshAgent);
          return jsonExecution({
            status: "listed",
            notes: notes.map((n) => ({ id: n.id, content: n.content, createdAt: n.createdAt })),
          });
        }

        if (action === "remember") {
          if (!content) {
            return jsonExecution({
              status: "refused",
              reason: "invalid_arguments",
              message: "Provide the note content to remember.",
            });
          }
          const created = await agents.createAgentNote(ctx.user, freshAgent, content, "agent");
          if (created.status !== 201) {
            return jsonExecution({
              status: "refused",
              reason: String(created.body.error ?? "note_failed"),
              message: String(created.body.message ?? "Could not save note."),
            });
          }
          const change: ClientAgentChange = {
            agentId: freshAgent.id,
            agentName: freshAgent.name,
            ...(created.eventId ? { eventId: created.eventId } : {}),
            summary: `${freshAgent.name} saved a note`,
            changes: [{ label: "Memory note", to: content }],
          };
          ctx.onAgentChange?.(change);
          return jsonExecution(
            { status: "remembered", note: created.body.note, eventId: created.eventId },
            { agentChange: change }
          );
        }

        // Forget note by noteId or matching decrypted content
        let noteId = typeof rawArgs.noteId === "string" ? rawArgs.noteId.trim() : "";
        if (!noteId && content) {
          const allNotes = await agents.listAgentNotes(ctx.user, freshAgent);
          const found = allNotes.find(
            (n) => n.content.toLowerCase() === content.toLowerCase() || n.content.toLowerCase().includes(content.toLowerCase())
          );
          if (found) noteId = found.id;
        }
        if (!noteId) {
          return jsonExecution({
            status: "refused",
            reason: "not_found",
            message: "Could not find a matching note to remove.",
          });
        }
        const deleted = await agents.deleteAgentNote(ctx.user, freshAgent, noteId);
        if (deleted.status !== 200) {
          return jsonExecution({
            status: "refused",
            reason: String(deleted.body.error ?? "note_failed"),
            message: String(deleted.body.message ?? "Could not remove note."),
          });
        }
        const change: ClientAgentChange = {
          agentId: freshAgent.id,
          agentName: freshAgent.name,
          ...(deleted.eventId ? { eventId: deleted.eventId } : {}),
          summary: `${freshAgent.name} removed a note`,
          changes: [{ label: "Memory note", from: content || "Saved note", to: "Removed" }],
        };
        ctx.onAgentChange?.(change);
        return jsonExecution(
          { status: "forgotten", noteId, eventId: deleted.eventId },
          { agentChange: change }
        );
      }),
  };

  return [updateTool, goalTool, routineTool, memoryTool, createTool];
}
