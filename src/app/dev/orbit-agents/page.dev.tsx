import { notFound } from "next/navigation";
import { OrbitAgentsBoard } from "./board";

/**
 * Dev only: the Orbit agent character proposal (two 3D directions, rendered
 * live with three.js). `?dir=A` simple matte vinyl, `?dir=B` velvet flock.
 * Not linked from anywhere; 404s outside development.
 */
export default async function OrbitAgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  return <OrbitAgentsBoard dir={sp.dir === "B" ? "B" : "A"} />;
}
