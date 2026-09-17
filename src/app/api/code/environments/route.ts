import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { encryptSecret } from "@/lib/crypto";
import {
  createEnvironmentSchema,
  describeEnvVarRejection,
  DEFAULT_CODE_NETWORK_ACCESS,
  MAX_CODE_ENVIRONMENTS,
  parseEnvVars,
  serializeCodeEnvironment,
} from "@/lib/code-environments";

export const runtime = "nodejs";

/**
 * The cloud environments a Code run can be dispatched into.
 *
 *   GET  → { environments: [...] } — names, egress level, the NAMES of the
 *          variables, and whether a setup script exists. Never a value.
 *   POST { name, network?, envVars?, setupScript?, isDefault? } → 201
 *
 * THE VARIABLES ARE SECRETS. They are sealed on the way in with the same
 * keyring that holds the connector OAuth tokens (src/lib/crypto.ts) and there
 * is no read path back out to a browser — not here, not on the single-
 * environment GET, not for the person who typed them. The only endpoint that
 * unseals them is runner-context, which authenticates a GitHub Actions OIDC
 * token and refuses a browser session with 403. That asymmetry is the whole
 * design: a stolen session cookie can rename an environment, and cannot read
 * one. A client that needs to show what a run will carry shows `envVarNames`.
 */

const LIST_SELECT = {
  id: true,
  name: true,
  network: true,
  envVarNames: true,
  setupScript: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const environments = await prisma.codeEnvironment.findMany({
    where: { userId: user.id },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: LIST_SELECT,
  });
  return NextResponse.json({
    environments: environments.map((row) => serializeCodeEnvironment(row)),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createEnvironmentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { name, network, setupScript, envVars, isDefault } = parsed.data;

  const vars = parseEnvVars(envVars ?? {});
  if (!vars.ok) {
    return NextResponse.json(
      { error: "invalid_env_var", message: describeEnvVarRejection(vars.rejection) },
      { status: 400 },
    );
  }

  const count = await prisma.codeEnvironment.count({ where: { userId: user.id } });
  if (count >= MAX_CODE_ENVIRONMENTS) {
    return NextResponse.json(
      {
        error: "too_many_environments",
        message: `You already have ${MAX_CODE_ENVIRONMENTS} environments. Delete one to add another.`,
      },
      { status: 409 },
    );
  }

  try {
    // The default flag and the row are written together, because the partial
    // unique index in the migration refuses a second default outright: clearing
    // the old one has to happen in the same transaction or the create fails.
    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.codeEnvironment.updateMany({
          where: { userId: user.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.codeEnvironment.create({
        data: {
          userId: user.id,
          name,
          network: network ?? DEFAULT_CODE_NETWORK_ACCESS,
          // An empty map is stored as NULL rather than as the ciphertext of
          // "{}", so "this environment carries nothing" is a fact a reader can
          // see without a key.
          envVars: vars.names.length > 0 ? encryptSecret(JSON.stringify(vars.vars)) : null,
          envVarNames: vars.names,
          setupScript: setupScript?.trim() ? setupScript : null,
          isDefault: isDefault ?? false,
        },
        select: LIST_SELECT,
      });
    });
    return NextResponse.json(
      { environment: serializeCodeEnvironment(created, { includeSetupScript: true }) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "duplicate_name", message: `You already have an environment called “${name}”.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
