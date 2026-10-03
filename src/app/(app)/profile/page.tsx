import { ProfilePage } from "@/components/profile/profile-page";

/**
 * The account's profile: name, photo, and a year of tokens and models
 * (src/components/profile). Editing the name and photo stays in Settings,
 * Account; this page reads, it does not edit.
 */
export default function Profile() {
  return <ProfilePage />;
}
