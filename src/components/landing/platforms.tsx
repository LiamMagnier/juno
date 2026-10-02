import { PlatformChooser } from "./platform-chooser";
import { Section } from "./section";
import { Reveal } from "./reveal";

export function Platforms() {
  return <Section id="apps" heading="Make it your workspace." lede="One account for the browser and native apps. Choose where you want to work."><Reveal amount={0.15}><PlatformChooser /></Reveal></Section>;
}
