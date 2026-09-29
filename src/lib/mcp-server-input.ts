import { z } from "zod";

export const mcpConnectionInput = z.object({
  url: z.string().trim().min(1, "Server URL is required.").max(2000),
  authHeader: z.string().max(4000).nullable().optional(),
});

export const createMcpServerInput = mcpConnectionInput.extend({
  name: z.string().trim().min(1, "Name is required.").max(80),
});

/** Omitted credentials retain the saved secret; null explicitly removes it. */
export const testSavedMcpServerInput = mcpConnectionInput.partial();
