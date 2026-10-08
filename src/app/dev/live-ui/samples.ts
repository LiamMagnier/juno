/**
 * Realistic Live UI replies for the dev gallery: each one is a whole assistant
 * message (prose around one ```live-ui fence), written the way the prompt
 * contract asks a model to write them. The source of truth is
 * contracts/live-ui/samples.json, which the native snapshot tests render too.
 */
import data from "../../../../contracts/live-ui/samples.json";
import legacy from "../../../../contracts/live-ui/legacy-reply.json";

export interface LiveUISample {
  id: string;
  label: string;
  prompt: string;
  reply: string;
}

export const LIVE_UI_SAMPLES: LiveUISample[] = data.samples;


/** A reply saved with the retired `:::` learning blocks, to show history converting. */
export const LEGACY_REPLY: { prompt: string; reply: string } = legacy;

/** Mermaid, which stays for diagrams with branches; drawn in the app's colours, fitted to the column. */
export const MERMAID_REPLY = [
  "A request to the API goes through the edge cache first; only a miss reaches the model.",
  "",
  "```mermaid",
  "flowchart LR",
  "  U[User] --> E{Edge cache}",
  "  E -- hit --> R[Cached reply]",
  "  E -- miss --> A[API server]",
  "  A --> Q[(Queue)] --> W[Worker] --> M[Model]",
  "  M --> A",
  "  A --> R",
  "```",
  "",
  "And the same handshake as a sequence:",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant C as Client",
  "  participant S as Server",
  "  C->>S: ClientHello",
  "  S-->>C: ServerHello, certificate",
  "  C->>S: Key exchange",
  "  S-->>C: Finished",
  "```",
].join("\n");
