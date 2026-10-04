/**
 * Juno Multi-Agent Team Orchestrator (DAG-based Runtime Coordination)
 *
 * Integrates directly with Juno's Unified Agent Runtime and Work Event Stream.
 * Coordinates multi-agent specialist teams across a Directed Acyclic Graph (DAG)
 * with role-scoped tools, dependency management, budget limits, cancellation,
 * error boundaries, and timeline progress tracking.
 */

import type { AgentExecutionContext, AgentRuntimeEvent } from "@/lib/agent/types";

// Web Crypto (Node 19+ and every browser), so the DAG rules are client-safe: the team
// vocabulary in src/lib/agents/team.ts reaches the chat panel through this module.
const crypto = globalThis.crypto;

export type SwarmAgentRole =
  | "planner"
  | "researcher"
  | "coder"
  | "tester"
  | "reviewer"
  | "designer"
  | "critic"
  | "synthesizer";

/**
 * Which nodes of a DAG may start now, shared by the in-memory coordinator
 * below and the durable team coordinator (src/lib/agents/team-store.ts).
 *
 * `strict` (the in-memory default) starts a node only when every dependency
 * completed and skips it when one failed. `contained` starts a node once every
 * dependency has ended, however it ended, as long as at least one of them
 * completed: a critic still reviews what two of three specialists produced.
 * A node with no dependencies is always ready.
 */
export function swarmReadyNodes<T extends { id: string; dependencies: readonly string[]; status: string }>(
  nodes: readonly T[],
  mode: "strict" | "contained" = "strict"
): { ready: T[]; skip: T[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ended = (status: string) => status === "completed" || status === "failed" || status === "skipped";
  const ready: T[] = [];
  const skip: T[] = [];
  for (const node of nodes) {
    if (node.status !== "pending") continue;
    const deps = node.dependencies.map((id) => byId.get(id));
    if (deps.some((dep) => !dep)) {
      skip.push(node);
      continue;
    }
    const statuses = deps.map((dep) => dep!.status);
    if (mode === "strict") {
      if (statuses.some((status) => status === "failed" || status === "skipped")) skip.push(node);
      else if (statuses.every((status) => status === "completed")) ready.push(node);
      continue;
    }
    if (!statuses.every(ended)) continue;
    if (statuses.length === 0 || statuses.some((status) => status === "completed")) ready.push(node);
    else skip.push(node);
  }
  return { ready, skip };
}

export interface SwarmTaskNode {
  id: string;
  role: SwarmAgentRole;
  prompt: string;
  dependencies: string[];
  allowedTools?: string[];
  timeoutMs?: number;
  assignedDeviceId?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
  durationMs?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface SwarmPlan {
  swarmId: string;
  goal: string;
  tasks: SwarmTaskNode[];
  status: "planning" | "in_progress" | "completed" | "failed";
  completedCount: number;
  totalCount: number;
  timeline: Array<{
    taskId: string;
    role: SwarmAgentRole;
    status: string;
    durationMs?: number;
    summary: string;
  }>;
  synthesizedOutput?: string;
}

export class AgentSwarmCoordinator {
  public readonly swarmId: string;
  public readonly goal: string;
  private tasks: Map<string, SwarmTaskNode> = new Map();
  private maxConcurrency: number;
  private defaultTimeoutMs: number;

  constructor(swarmId: string, goal: string, maxConcurrency = 4, defaultTimeoutMs = 60_000) {
    this.swarmId = swarmId || `swarm-${crypto.randomUUID().slice(0, 8)}`;
    this.goal = goal;
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Adds a task node to the execution DAG.
   */
  public addTask(
    role: SwarmAgentRole,
    prompt: string,
    options: {
      id?: string;
      dependencies?: string[];
      allowedTools?: string[];
      timeoutMs?: number;
      assignedDeviceId?: string;
    } = {}
  ): SwarmTaskNode {
    const taskId = options.id || `task-${this.tasks.size + 1}-${role}-${crypto.randomUUID().slice(0, 4)}`;
    
    // Verify all specified dependencies exist or will exist
    const node: SwarmTaskNode = {
      id: taskId,
      role,
      prompt,
      dependencies: options.dependencies || [],
      allowedTools: options.allowedTools,
      timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
      assignedDeviceId: options.assignedDeviceId,
      status: "pending",
    };

    this.tasks.set(node.id, node);
    this.validateAcyclicity();
    return node;
  }

  /**
   * Validates that the task dependency graph contains no cycles.
   */
  public validateAcyclicity(): void {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (nodeId: string) => {
      visited.add(nodeId);
      recStack.add(nodeId);

      const node = this.tasks.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            dfs(depId);
          } else if (recStack.has(depId)) {
            throw new Error(`Circular dependency detected in agent swarm DAG involving task '${nodeId}' -> '${depId}'`);
          }
        }
      }

      recStack.delete(nodeId);
    };

    for (const taskId of this.tasks.keys()) {
      if (!visited.has(taskId)) {
        dfs(taskId);
      }
    }
  }

  public getPlan(): SwarmPlan {
    const taskList = Array.from(this.tasks.values());
    const completed = taskList.filter((t) => t.status === "completed").length;
    const failed = taskList.filter((t) => t.status === "failed").length;
    const isFinished = taskList.length > 0 && taskList.every((t) => t.status === "completed" || t.status === "failed" || t.status === "skipped");

    const timeline = taskList.map((t) => ({
      taskId: t.id,
      role: t.role,
      status: t.status,
      durationMs: t.durationMs,
      summary: t.result ? t.result.slice(0, 160) : t.error || "Pending",
    }));

    return {
      swarmId: this.swarmId,
      goal: this.goal,
      tasks: taskList,
      status: isFinished ? (failed > 0 ? "failed" : "completed") : taskList.some((t) => t.status === "running") ? "in_progress" : "planning",
      completedCount: completed,
      totalCount: taskList.length,
      timeline,
      synthesizedOutput: taskList.find((t) => t.role === "synthesizer" && t.status === "completed")?.result,
    };
  }

  /**
   * Executes the swarm DAG respecting dependencies, concurrency limits, timeouts, and cancellation.
   */
  public async executeSwarm(
    executor: (task: SwarmTaskNode, workerContext?: Partial<AgentExecutionContext>) => Promise<{
      success: boolean;
      output: string;
      error?: string;
    }>,
    context?: AgentExecutionContext
  ): Promise<SwarmPlan> {
    this.validateAcyclicity();

    const running = new Set<string>();
    const completed = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();

    const emitEvent = async (event: AgentRuntimeEvent) => {
      if (context?.onEvent) {
        await context.onEvent(event);
      }
    };

    while (completed.size + failed.size + skipped.size < this.tasks.size) {
      if (context?.abortSignal?.aborted) {
        for (const task of this.tasks.values()) {
          if (task.status === "pending" || task.status === "running") {
            task.status = "failed";
            task.error = "Swarm execution cancelled by user.";
            failed.add(task.id);
          }
        }
        break;
      }

      // Ready and skipped nodes, by the same rule the durable team uses.
      const { ready: readyTasks, skip: skippedNow } = swarmReadyNodes([...this.tasks.values()], "strict");
      for (const task of skippedNow) {
        task.status = "skipped";
        task.error = "Skipped due to upstream dependency failure.";
        skipped.add(task.id);
      }

      if (readyTasks.length === 0 && running.size === 0) {
        // No tasks can make progress
        break;
      }

      // Launch up to maxConcurrency
      const slotsAvailable = this.maxConcurrency - running.size;
      const toLaunch = readyTasks.slice(0, Math.max(0, slotsAvailable));

      for (const task of toLaunch) {
        task.status = "running";
        task.startedAt = Date.now();
        running.add(task.id);

        void emitEvent({
          id: `swarm-evt-${task.id}-start`,
          type: "subagent_spawned",
          timestamp: Date.now(),
          title: `[${task.role.toUpperCase()}] Starting ${task.id}`,
          detail: task.prompt.slice(0, 120),
          status: "running",
          source: task.role,
        });

        // Run task asynchronously
        (async () => {
          const timeoutMs = task.timeoutMs || this.defaultTimeoutMs;
          const timeoutPromise = new Promise<{ success: boolean; output: string; error: string }>((_, reject) => {
            setTimeout(() => reject(new Error(`Task '${task.id}' timed out after ${timeoutMs}ms`)), timeoutMs);
          });

          try {
            const res = await Promise.race([
              executor(task, {
                userId: context?.userId,
                sessionId: context?.sessionId,
                abortSignal: context?.abortSignal,
              }),
              timeoutPromise,
            ]);

            task.completedAt = Date.now();
            task.durationMs = task.completedAt - (task.startedAt || task.completedAt);

            if (res.success) {
              task.status = "completed";
              task.result = res.output;
              completed.add(task.id);

              void emitEvent({
                id: `swarm-evt-${task.id}-done`,
                type: "subagent_finished",
                timestamp: Date.now(),
                title: `[${task.role.toUpperCase()}] Completed ${task.id}`,
                detail: res.output.slice(0, 120),
                status: "completed",
                source: task.role,
              });
            } else {
              task.status = "failed";
              task.error = res.error || "Task failed";
              failed.add(task.id);

              void emitEvent({
                id: `swarm-evt-${task.id}-fail`,
                type: "error",
                timestamp: Date.now(),
                title: `[${task.role.toUpperCase()}] Failed ${task.id}`,
                detail: task.error,
                status: "failed",
                source: task.role,
              });
            }
          } catch (err: unknown) {
            task.completedAt = Date.now();
            task.durationMs = task.completedAt - (task.startedAt || task.completedAt);
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
            failed.add(task.id);

            void emitEvent({
              id: `swarm-evt-${task.id}-err`,
              type: "error",
              timestamp: Date.now(),
              title: `[${task.role.toUpperCase()}] Error in ${task.id}`,
              detail: task.error,
              status: "failed",
              source: task.role,
            });
          } finally {
            running.delete(task.id);
          }
        })();
      }

      // Yield event loop briefly
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    return this.getPlan();
  }
}
