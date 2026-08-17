/**
 * Juno Multi-Agent Swarm Orchestrator
 *
 * Coordinates concurrent multi-subagent teams across specialized roles:
 * - Architect / Planner: Analyzes requirements and splits into independent tasks.
 * - Researcher: Fetches documentation, searches web, queries RAG knowledge.
 * - Coder: Applies file modifications, refactors, and implements functions.
 * - Reviewer / Tester: Runs linters, types, unit tests, and verifies correctness.
 */

export type SwarmAgentRole = "planner" | "researcher" | "coder" | "tester" | "reviewer";

export interface SwarmTask {
  id: string;
  role: SwarmAgentRole;
  prompt: string;
  assignedDeviceId?: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface SwarmPlan {
  swarmId: string;
  goal: string;
  tasks: SwarmTask[];
  status: "planning" | "in_progress" | "completed" | "failed";
  completedCount: number;
  totalCount: number;
}

export class AgentSwarmCoordinator {
  private swarmId: string;
  private goal: string;
  private tasks: Map<string, SwarmTask> = new Map();
  private maxConcurrency: number;

  constructor(swarmId: string, goal: string, maxConcurrency = 4) {
    this.swarmId = swarmId;
    this.goal = goal;
    this.maxConcurrency = maxConcurrency;
  }

  public addTask(role: SwarmAgentRole, prompt: string, assignedDeviceId?: string): SwarmTask {
    const task: SwarmTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role,
      prompt,
      assignedDeviceId,
      status: "pending",
    };
    this.tasks.set(task.id, task);
    return task;
  }

  public getPlan(): SwarmPlan {
    const taskList = Array.from(this.tasks.values());
    const completed = taskList.filter((t) => t.status === "completed").length;
    const isFinished = taskList.length > 0 && taskList.every((t) => t.status === "completed" || t.status === "failed");

    return {
      swarmId: this.swarmId,
      goal: this.goal,
      tasks: taskList,
      status: isFinished ? "completed" : taskList.some((t) => t.status === "running") ? "in_progress" : "planning",
      completedCount: completed,
      totalCount: taskList.length,
    };
  }

  /**
   * Dispatches pending tasks up to the concurrency limit.
   */
  public async executeSwarm(
    executor: (task: SwarmTask) => Promise<{ success: boolean; output: string; error?: string }>
  ): Promise<SwarmPlan> {
    const pendingTasks = Array.from(this.tasks.values()).filter((t) => t.status === "pending");

    // Process in batches respecting maxConcurrency
    for (let i = 0; i < pendingTasks.length; i += this.maxConcurrency) {
      const batch = pendingTasks.slice(i, i + this.maxConcurrency);

      await Promise.all(
        batch.map(async (task) => {
          task.status = "running";
          const start = Date.now();
          try {
            const res = await executor(task);
            task.durationMs = Date.now() - start;
            if (res.success) {
              task.status = "completed";
              task.result = res.output;
            } else {
              task.status = "failed";
              task.error = res.error ?? "Execution failed";
            }
          } catch (err) {
            task.durationMs = Date.now() - start;
            task.status = "failed";
            task.error = err instanceof Error ? err.message : String(err);
          }
        })
      );
    }

    return this.getPlan();
  }
}
