import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { addProjectMember, listProjectMembers, ProjectCollaborationError } from "@/lib/project-collaboration";

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
    // Only the collaboration layer's own refusals are echoed; anything else
    // (a Prisma failure, say) is logged and answered with a fixed sentence.
    if (error instanceof ProjectCollaborationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[projects] listing members failed", { projectId: id, message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Could not load project members." }, { status: 500 });
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
    if (error instanceof ProjectCollaborationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[projects] adding member failed", { projectId: id, message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Could not add the member." }, { status: 500 });
  }
}
