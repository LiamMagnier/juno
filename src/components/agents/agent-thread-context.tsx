"use client";

import * as React from "react";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";

/**
 * Whose thread this is, for the parts of the transcript that should speak as
 * the agent rather than as Juno: the pending row ("Mira is thinking", drawn
 * with her face) and the byline on her replies. Null in every other chat.
 */
export interface AgentThreadIdentity {
  name: string;
  avatar: AgentAvatar;
  state: AgentState;
}

export const AgentThreadContext = React.createContext<AgentThreadIdentity | null>(null);

export function useAgentThread(): AgentThreadIdentity | null {
  return React.useContext(AgentThreadContext);
}
