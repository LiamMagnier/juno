import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { LandingPage } from "@/components/landing/landing-page";

// Signed-in users go straight to the app; strangers get the front door.
export const metadata: Metadata = {
  title: { absolute: "Juno — every frontier AI model, one honest subscription" },
  description:
    "Chat with Claude, GPT, Gemini and models from a dozen more labs in one calm workspace. Plans are metered by real API cost — you see what every answer costs. Hosted in France, GDPR by default.",
  alternates: { canonical: "/" },
};

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/chat");
  return <LandingPage />;
}
