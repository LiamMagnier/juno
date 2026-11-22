import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { CodeLanding } from "@/components/code/code-landing";
import { parseCodePrefill, type PrefillParams } from "@/lib/code-prefill";

export const dynamic = "force-dynamic";

/**
 * Prefill a new Code session from a link. The user chooses when to start the
 * run. A project link supplies context only after the owner is verified.
 */
export default async function CodePage({ searchParams }: { searchParams: Promise<PrefillParams> }) {
  const user = await requireUser();
  const params = await searchParams;
  const prefill = parseCodePrefill(params);
  if (params.project === undefined) return <CodeLanding prefill={prefill} />;
  if (typeof params.project !== "string" || !params.project || params.project.length > 200) notFound();

  const project = await prisma.project.findFirst({
    where: { id: params.project, userId: user.id },
    select: { id: true, name: true },
  });
  if (!project) notFound();
  return <CodeLanding prefill={prefill} project={project} />;
}
