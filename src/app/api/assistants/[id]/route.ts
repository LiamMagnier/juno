import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getAssistantById, updateAssistant, deleteAssistant } from "@/lib/assistants";

export const runtime = "nodejs";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const assistant = await getAssistantById(id, user.id);
  if (!assistant) {
    return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
  }

  return NextResponse.json({ assistant });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const body = await req.json();

  const updated = await updateAssistant(id, body, user.id);
  if (!updated) {
    return NextResponse.json({ error: "Assistant not found or update failed" }, { status: 404 });
  }

  return NextResponse.json({ assistant: updated });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const success = await deleteAssistant(id, user.id);
  if (!success) {
    return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
