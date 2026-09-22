import { notFound } from "next/navigation";
import { TaskHandoffGallery } from "./gallery";

/**
 * Dev-only gallery for the approval card a model-started task raises.
 *
 * The card only appears mid-generation, behind a signed-in chat, a model that
 * chose to call `start_task`, and either an estimate above the preflight bar or
 * outside content in the turn. None of that can be arranged on demand, so the
 * real component is rendered here against fixture receipts, beside the
 * connector variant it has to sit next to. Not linked from anywhere and 404s
 * outside development, like the other /dev pages.
 */
export default function TaskHandoffDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TaskHandoffGallery />;
}
