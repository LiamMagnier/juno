import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { PLANS } from "@/lib/plans";
import { getUserPlan } from "@/lib/usage";
import { expandAuthoredDesign, authoredDesignSchema } from "@/lib/design/authoring";
import { serializeDesignDocument } from "@/lib/design/migrations";
import { artifactPath } from "@/lib/artifact-links";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled design"),
  /** A device preset, so a new design opens at a real size rather than 100×100. */
  preset: z.enum(["phone", "tablet", "desktop", "square"]).default("phone"),
  /** Start it inside one of the person's projects. */
  projectId: z.string().cuid().optional(),
});

const PRESETS = {
  phone: { width: 375, height: 812, name: "iPhone" },
  tablet: { width: 834, height: 1_194, name: "iPad" },
  desktop: { width: 1_440, height: 900, name: "Desktop" },
  square: { width: 1_080, height: 1_080, name: "Square" },
} as const;

/**
 * Start a design from nothing.
 *
 * An artifact belongs to its owner, not to a chat (PRODUCT_REFOUNDATION §10),
 * so a new design is just a design: no conversation is created. It used to
 * make an empty chat titled after the design to hold it, which put a chat
 * nobody sent a message in into Recents — and deleting that "chat" deleted
 * the design (audit B5).
 *
 * The document is built through the same authoring expansion a model's design
 * goes through, so a hand-started design and a Juno-authored one are the same
 * kind of object from their first revision.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].canvas) {
    return NextResponse.json({ error: "Your plan does not include the canvas." }, { status: 403 });
  }

  const limited = await artifactWriteLimited(user, "create");
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // A project id the person does not own is refused rather than dropped, so a
  // design never lands somewhere other than where they asked.
  const projectId = parsed.data.projectId ?? null;
  if (projectId) {
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const preset = PRESETS[parsed.data.preset];
  const identifier = `design-${Date.now().toString(36)}`;
  const document = expandAuthoredDesign(
    authoredDesignSchema.parse({
      name: parsed.data.title,
      background: "#f5f5f7",
      nodes: [
        {
          type: "frame",
          name: preset.name,
          width: preset.width,
          height: preset.height,
          fill: "#ffffff",
          clip: true,
        },
      ],
    }),
    identifier
  );

  const artifact = await prisma.artifact.create({
    data: {
      userId: user.id,
      projectId,
      conversationId: null,
      identifier,
      title: parsed.data.title,
      type: "DESIGN",
      currentVersion: 1,
      versions: { create: { version: 1, content: serializeDesignDocument(document), origin: "generated" } },
    },
  });

  return NextResponse.json({
    artifactId: artifact.id,
    // Kept in the response for clients that read it; a new design has no chat.
    conversationId: null,
    // Where to send the browser: the design's own window. This used to open the
    // chat that owns it with the canvas panel showing, which put the editor in a
    // side panel too narrow to keep its layers rail or inspector — a brand-new
    // design landed as a canvas with nothing to edit it with. The window is
    // the artifact's own address, `/a/{id}`, which draws the editor for a
    // design; `/design/{id}` only redirects there now (04-MERGE-PLAN.md §5.1).
    url: artifactPath(artifact.id),
  });
}
