import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ProfileGallery } from "./gallery";

/**
 * Dev-only gallery for /profile: the real page component fed by fixtures
 * instead of a signed-in account.
 *
 *   /dev/profile                    a heavy user, a year of work
 *   /dev/profile?fixture=new        a new account with no usage
 *   /dev/profile?fixture=loading    the page while its request is out
 *   /dev/profile?fixture=error      the request failed
 *   /dev/profile?theme=dark         any of the above, dark
 *
 * Not linked from anywhere and 404s outside development.
 */
export default function ProfileDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <ProfileGallery />
    </Suspense>
  );
}
