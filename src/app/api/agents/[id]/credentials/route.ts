import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import { VaultInputError } from "@/lib/computer/vault-policy";
import { createAgentCredential, isAgentVaultEnabled, listAgentCredentials } from "@/lib/computer/vault-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Nothing here is cached anywhere, and no response carries a value. */
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

const VAULT_OFF_MESSAGE = "Saved logins are not turned on for this server.";

const createCredentialSchema = z.object({
  label: z.string().max(400),
  origin: z.string().max(2048),
  username: z.string().max(2048),
  password: z.string().max(4096),
  totpSecret: z.string().max(4096).nullish(),
});

/**
 * GET: `{ credentials }`, this agent's saved logins by label and site, never a
 * value; `credentials` is null when the vault is off on this server
 * (docs/design/agents-v2/VAULT.md), so the panel hides its section.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404, headers: NO_STORE_HEADERS });
  }
  if (!isAgentVaultEnabled()) return NextResponse.json({ credentials: null }, { headers: NO_STORE_HEADERS });
  return NextResponse.json({ credentials: await listAgentCredentials(user.id, agent.id) }, { headers: NO_STORE_HEADERS });
}

/** POST `{ label, origin, username, password, totpSecret? }`: saves a login. The values are sealed before the response and never echoed. */
export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const limit = await rateLimit({ key: `agents:credentials:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many saved logins changed in an hour. Try again later." },
      { status: 429, headers: NO_STORE_HEADERS }
    );
  }
  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404, headers: NO_STORE_HEADERS });
  }
  if (!isAgentVaultEnabled()) {
    return NextResponse.json({ error: "not_enabled", message: VAULT_OFF_MESSAGE }, { status: 404, headers: NO_STORE_HEADERS });
  }
  const parsed = createCredentialSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That login could not be read." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    const credential = await createAgentCredential({ userId: user.id, agentId: agent.id, ...parsed.data });
    return NextResponse.json({ credential }, { status: 201, headers: NO_STORE_HEADERS });
  } catch (caught) {
    if (caught instanceof VaultInputError) {
      return NextResponse.json({ error: "invalid_input", message: caught.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    throw caught;
  }
}
