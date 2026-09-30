import { notFound } from "next/navigation";
import { Libre_Franklin, Manrope, Nunito_Sans, Source_Sans_3, Wix_Madefor_Display, Wix_Madefor_Text } from "next/font/google";
import { LabStage } from "./lab-stage";
import { MarkLab } from "./mark-lab";

/*
 * Porcelain type and colour lab (dev only). Renders the candidate interface
 * faces at the sizes the product uses, in both themes, beside the candidate
 * signature hues, so the choice is made on rendered evidence.
 *
 *   /dev/design/porcelain/lab?theme=light|dark
 */

const wixDisplay = Wix_Madefor_Display({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-wix-display", display: "swap" });
const wixText = Wix_Madefor_Text({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-wix-text", display: "swap" });
const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-manrope", display: "swap" });
const franklin = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-franklin", display: "swap" });
const source = Source_Sans_3({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-source", display: "swap" });
const nunito = Nunito_Sans({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-nunito", display: "swap" });

export const metadata = { title: "Porcelain lab" };

export default async function PorcelainLab({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { theme, part } = await searchParams;
  if (part === "mark") {
    const dark = theme === "dark";
    return (
      <div className={wixText.variable} style={{ fontFamily: "var(--lab-wix-text)" }}>
        <MarkLab ink={dark ? "#ECEDEE" : "#1A1C1E"} bg={dark ? "#111213" : "#F1F2F3"} sig={dark ? "#82C8B0" : "#3A816A"} />
      </div>
    );
  }
  const cls = [wixDisplay, wixText, manrope, franklin, source, nunito].map((f) => f.variable).join(" ");
  return <LabStage className={cls} theme={theme === "dark" ? "dark" : "light"} part={part === "color" ? "color" : "type"} />;
}
