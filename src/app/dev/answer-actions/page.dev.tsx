import { notFound } from "next/navigation";

import { AnswerActionsGallery } from "./gallery";

/**
 * Dev-only gallery for what a reader can do with a finished answer (G10, G14,
 * G33), in the real components:
 *
 *   select    select any passage of the answer: Ask, Quote, Explain, Copy
 *   thought   the run strip unfolding in place, live and settled, with the
 *             full trace one press further (dock here, a sheet on a phone)
 *   feedback  the thumbs: up swells, down opens the reason picker
 *
 * Not linked from anywhere; the page extension exists only outside
 * production builds and it 404s there anyway.
 */
export default async function AnswerActionsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AnswerActionsGallery />;
}
