import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { branchRefusalResponse, selectBranch } from "@/lib/chat/branches";
import { isRefusal } from "@/lib/chat/branch-model";
import { MAX_PAGE_MESSAGES } from "@/lib/chat/history-page";
import { getBranchPath } from "@/lib/queries";

/**
 * Show the branch this message starts: the "‹ 2/3 ›" pager under an edited
 * question or a regenerated answer (src/lib/chat/branches.ts).
 *
 * The alternative shown at this point, and everything after it, leave the
 * shown path; this message and the choices made inside its branch the last
 * time it was shown come back. Nothing is deleted either way.
 *
 * Response:
 *   replacedId  the row that was shown here before; the client keeps every row
 *               above it and replaces it and everything after it with
 *   messages    the new shown rows from this message to the leaf, or null when
 *               the branch is longer than a page — then the client reads the
 *               newest page instead.
 *   changed     false when this message was already the one shown.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const selected = await selectBranch(user.id, id);
  if (isRefusal(selected)) {
    const refusal = branchRefusalResponse(selected);
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  const messages = await getBranchPath(selected.conversationId, selected.path, MAX_PAGE_MESSAGES);
  return NextResponse.json({ replacedId: selected.replacedId, messages, changed: selected.changed });
}
