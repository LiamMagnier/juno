/** Explain the setup without granting permissions or starting work. */
export const ORBIT_SETUP_STEPS = [
  { id: "job", title: "Start with one useful task", detail: "Describe a clear outcome, or choose a starter below." },
  { id: "workspace", title: "Choose where it works", detail: "Select cloud tools or a connected Mac in the composer." },
  { id: "control", title: "Stay in control", detail: "Review requests and results in your agent’s chat." },
] as const;

export const AGENT_CONTROL_COPY = {
  pauseLabel: "Pause future work",
  resumeLabel: "Resume agent",
  pauseHint: "Pauses routines and new work. Stop an active task from its chat.",
  resumeHint: "Allows new work and restores routines paused with this agent.",
  paused: "Paused for new work. Stop active tasks from their chats.",
  resumed: "Ready for new work.",
} as const;
