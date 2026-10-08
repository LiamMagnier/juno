/**
 * Realistic Live UI replies for the dev gallery: each one is a whole assistant
 * message (prose around one ```live-ui fence), written the way the prompt
 * contract asks a model to write them. The source of truth is
 * contracts/live-ui/samples.json, which the native snapshot tests render too.
 */
import data from "../../../../contracts/live-ui/samples.json";

export interface LiveUISample {
  id: string;
  label: string;
  prompt: string;
  reply: string;
}

export const LIVE_UI_SAMPLES: LiveUISample[] = data.samples;
