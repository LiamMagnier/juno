import { redirect } from "next/navigation";

/**
 * There is no hiring step any more: an agent starts from a sentence on Agents home
 * (docs/design/agents-rework/DIRECTION.md). Old links, bookmarks and the native
 * apps' former hire routes land there.
 */
export default function NewAgentPage() {
  redirect("/agents");
}
