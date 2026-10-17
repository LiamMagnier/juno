import { notFound } from "next/navigation";
import { ConnectorTriggerFixture } from "./fixture";

export default function ConnectorTriggersDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ConnectorTriggerFixture />;
}
