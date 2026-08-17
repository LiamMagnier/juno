import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { addProjectMember, listProjectMembers } from "@/lib/project-collaboration";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const members = await listProjectMembers(user.id, id);
    return NextResponse.json({ members });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden" }, { status: 403 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { emailOrUserId, role } = body;

  if (!emailOrUserId) {
    return NextResponse.json({ error: "emailOrUserId is required" }, { status: 400 });
  }

  try {
    const member = await addProjectMember(user.id, id, emailOrUserId, role ?? "EDITOR");
    return NextResponse.json({ member });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to add member" }, { status: 400 });
  }
}
