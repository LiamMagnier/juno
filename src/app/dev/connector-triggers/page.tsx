import { notFound } from "next/navigation";
import { ConnectorTriggerFixture } from "./fixture";

export default function ConnectorTriggersDevPage() {
  if (process.env.NODE_ENV === "production" && process.env.JUNO_E2E_SMOKE_PROVIDER !== "1") notFound();
  return <ConnectorTriggerFixture />;
}
