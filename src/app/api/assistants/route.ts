import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listUserAssistants, createAssistant } from "@/lib/assistants";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const assistants = await listUserAssistants(user.id);
    return NextResponse.json({ assistants });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    if (!body.name || !body.systemPrompt) {
      return NextResponse.json({ error: "Missing required fields: name and systemPrompt" }, { status: 400 });
    }

    const assistant = await createAssistant(
      {
        name: body.name,
        description: body.description || "",
        avatarIcon: body.avatarIcon,
        systemPrompt: body.systemPrompt,
        starterPrompts: body.starterPrompts,
        preferredModelId: body.preferredModelId,
        reasoningEffort: body.reasoningEffort,
        allowedTools: body.allowedTools,
      },
      user.id
    );

    return NextResponse.json({ assistant }, { status: 201 });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
