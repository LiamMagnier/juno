import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { PLANS } from "@/lib/plans";
import { getUserPlan } from "@/lib/usage";
import { expandAuthoredDesign, authoredDesignSchema } from "@/lib/design/authoring";
import { serializeDesignDocument } from "@/lib/design/migrations";

export const runtime = "nodejs";

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled design"),
  /** A device preset, so a new design opens at a real size rather than 100×100. */
  preset: z.enum(["phone", "tablet", "desktop", "square"]).default("phone"),
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
 * Until this existed the only way to reach the design editor was to ask Juno for
 * a design in the right words — which is not something anyone can discover by
 * looking at the app. An artifact belongs to a conversation, so this creates
 * both: an empty chat to hold it, and one blank frame to draw on.
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

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

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

  // One conversation to hold it. Titled after the design so it is findable in
  // Recents rather than showing up as an untitled chat nobody sent a message in.
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: parsed.data.title,
      titleSource: "manual",
      kind: "chat",
      lastMessageAt: new Date(),
    },
  });

  const artifact = await prisma.artifact.create({
    data: {
      conversationId: conversation.id,
      identifier,
      title: parsed.data.title,
      type: "DESIGN",
      currentVersion: 1,
      versions: { create: { version: 1, content: serializeDesignDocument(document), origin: "generated" } },
    },
  });

  return NextResponse.json({
    artifactId: artifact.id,
    conversationId: conversation.id,
    // Where to send the browser: the chat that owns it, with the canvas open.
    url: `/chat/${conversation.id}?artifact=${artifact.id}`,
  });
}
