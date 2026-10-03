"use client";

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { profileHandle, type ProfileActivity } from "@/lib/profile-activity";
import { ProfileView } from "@/components/profile/profile-view";

/**
 * /profile for the signed-in account: identity from the app shell (already
 * loaded), activity from /api/profile/activity in the browser's time zone, so
 * the grid's days are the reader's days.
 */
export function ProfilePage() {
  const { user } = useApp();
  const [activity, setActivity] = React.useState<ProfileActivity | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let tz = "UTC";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      /* UTC */
    }
    setFailed(false);
    fetch(`/api/profile/activity?tz=${encodeURIComponent(tz)}`, { signal: controller.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ProfileActivity>;
      })
      .then((body) => {
        if (!body || !Array.isArray(body.days) || !Array.isArray(body.models)) throw new Error("malformed activity");
        setActivity(body);
      })
      .catch((error: unknown) => {
        if ((error as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <ProfileView
      identity={{ id: user.id, name: user.name, image: user.image, handle: profileHandle(user) }}
      activity={activity}
      failed={failed}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}
