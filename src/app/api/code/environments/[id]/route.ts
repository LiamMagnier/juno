import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { encryptSecret } from "@/lib/crypto";
import {
  describeEnvVarRejection,
  parseEnvVars,
  patchEnvironmentSchema,
  serializeCodeEnvironment,
} from "@/lib/code-environments";

export const runtime = "nodejs";

/**
 * One cloud environment.
 *
 *   GET    → { environment } including the setup script, so an editor can load it
 *   PATCH  → the same, after the edit
 *   DELETE → 204. The runs that used it keep their history: the foreign key is
 *            ON DELETE SET NULL, so a past task simply stops naming an
 *            environment rather than disappearing with it.
 *
 * The variable VALUES are never in any of these responses. See the list route's
 * header for why that asymmetry is the design rather than an omission.
 */

const SELECT = {
  id: true,
  name: true,
  network: true,
  envVarNames: true,
  setupScript: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const environment = await prisma.codeEnvironment.findFirst({
    where: { id, userId: user.id },
    select: SELECT,
  });
  if (!environment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    environment: serializeCodeEnvironment(environment, { includeSetupScript: true }),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const parsed = patchEnvironmentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const patch = parsed.data;

  const data: Prisma.CodeEnvironmentUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.network !== undefined) data.network = patch.network;
  // `null` clears the script; an omitted key leaves it alone. The two are
  // different edits and the schema keeps them apart, because "I did not touch
  // the setup step" and "delete the setup step" cannot share a representation.
  if (patch.setupScript !== undefined) {
    data.setupScript = patch.setupScript && patch.setupScript.trim() ? patch.setupScript : null;
  }
  if (patch.envVars !== undefined) {
    const vars = parseEnvVars(patch.envVars);
    if (!vars.ok) {
      return NextResponse.json(
        { error: "invalid_env_var", message: describeEnvVarRejection(vars.rejection) },
        { status: 400 },
      );
    }
    // A patch that names `envVars` replaces the whole map — the column is one
    // ciphertext and the caller cannot read the old values back, so a merge
    // would be a merge with something it has never seen.
    data.envVars = vars.names.length > 0 ? encryptSecret(JSON.stringify(vars.vars)) : null;
    data.envVarNames = vars.names;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (patch.isDefault) {
        // The partial unique index refuses a second default, so the previous
        // one is cleared in the same transaction as this one is set. There is
        // no "unset the default" edit: an account either has a preselected
        // environment or has not chosen one, and a lone toggle that leaves
        // neither selected is a state no composer can draw honestly.
        await tx.codeEnvironment.updateMany({
          where: { userId: user.id, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
        data.isDefault = true;
      }
      // Ownership is a filter on the write itself rather than a preceding
      // read, so there is no window between the check and the edit — and the
      // ownership guard (src/lib/db.ts) requires the userId here anyway. A row
      // belonging to someone else matches nothing and raises P2025, which is
      // the 404 below.
      return tx.codeEnvironment.update({ where: { id, userId: user.id }, data, select: SELECT });
    });
    return NextResponse.json({
      environment: serializeCodeEnvironment(updated, { includeSetupScript: true }),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "duplicate_name", message: "You already have an environment with that name." },
        { status: 409 },
      );
    }
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  // Scoped to the owner in the delete itself rather than in a preceding read,
  // so there is no window between the check and the write.
  const deleted = await prisma.codeEnvironment.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
