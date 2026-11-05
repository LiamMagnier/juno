import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import { VaultInputError } from "@/lib/computer/vault-policy";
import { deleteAgentCredential, isAgentVaultEnabled, updateAgentCredential } from "@/lib/computer/vault-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; credentialId: string }> };

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

const updateCredentialSchema = z.object({
  label: z.string().max(400).optional(),
  origin: z.string().max(2048).optional(),
  username: z.string().max(2048).optional(),
  password: z.string().max(4096).optional(),
  /** Empty or null removes the two-step secret. */
  totpSecret: z.string().max(4096).nullish(),
});

const notFound = () =>
  NextResponse.json({ error: "not_found", message: "That saved login no longer exists." }, { status: 404, headers: NO_STORE_HEADERS });

/**
 * PATCH: changes a saved login of this agent. A new site or username asks
 * the person again on its next use (vault-store.ts). Answers the view, never a value.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, credentialId } = await params;
  const limit = await rateLimit({ key: `agents:credentials:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many saved logins changed in an hour. Try again later." },
      { status: 429, headers: NO_STORE_HEADERS }
    );
  }
  const agent = await findAgent(user.id, id);
  if (!agent || !isAgentVaultEnabled()) return notFound();
  const parsed = updateCredentialSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That change could not be read." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    const credential = await updateAgentCredential({ userId: user.id, agentId: agent.id, id: credentialId, ...parsed.data });
    if (!credential) return notFound();
    return NextResponse.json({ credential }, { headers: NO_STORE_HEADERS });
  } catch (caught) {
    if (caught instanceof VaultInputError) {
      return NextResponse.json({ error: "invalid_input", message: caught.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    throw caught;
  }
}

/**
 * DELETE: removes it, with its sealed values. Allowed with the vault off, so
 * turning the switch off never strands a login the person wants gone.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, credentialId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return notFound();
  const deleted = await deleteAgentCredential({ userId: user.id, agentId: agent.id, id: credentialId });
  if (!deleted) return notFound();
  return NextResponse.json({ deleted: true }, { headers: NO_STORE_HEADERS });
}
