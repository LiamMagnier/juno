import { Suspense } from "react";
import { TeachPage } from "@/components/skills/teach/teach-page";
import TeachSkillLoading from "./loading";

/**
 * /skills/teach: teach a method once, review it as a skill, switch it on.
 *
 * Everything is in `TeachPage` (src/components/skills/teach); it reads its
 * mode from the query string, which needs a Suspense boundary to prerender.
 */
export default function TeachSkillPage() {
  return (
    <Suspense fallback={<TeachSkillLoading />}>
      <TeachPage />
    </Suspense>
  );
}
