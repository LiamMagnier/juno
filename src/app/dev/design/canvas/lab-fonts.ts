import {
  Hanken_Grotesk,
  Inter,
  Libre_Franklin,
  Manrope,
  Nunito_Sans,
  Plus_Jakarta_Sans,
  Source_Sans_3,
  Wix_Madefor_Display,
  Wix_Madefor_Text,
} from "next/font/google";

/* Candidate faces for the type lab only (scene=type). Every one covers Latin, Cyrillic and Vietnamese. */
const inter = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-inter", display: "swap" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-hanken", display: "swap" });
const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-manrope", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-jakarta", display: "swap" });
const wixText = Wix_Madefor_Text({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-wixtext", display: "swap" });
const wixDisplay = Wix_Madefor_Display({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-wixdisplay", display: "swap" });
const franklin = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-franklin", display: "swap" });
const source = Source_Sans_3({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-source", display: "swap" });
const nunito = Nunito_Sans({ subsets: ["latin"], weight: ["400", "500"], variable: "--lab-nunito", display: "swap" });

export const LAB_FONT_CLASSES = [inter, hanken, manrope, jakarta, wixText, wixDisplay, franklin, source, nunito]
  .map((f) => f.variable)
  .join(" ");

export const LAB_FACES: { id: string; name: string; display: string; text: string }[] = [
  { id: "inter", name: "Inter (baseline)", display: "var(--lab-inter)", text: "var(--lab-inter)" },
  { id: "hanken", name: "Hanken Grotesk", display: "var(--lab-hanken)", text: "var(--lab-hanken)" },
  { id: "manrope", name: "Manrope", display: "var(--lab-manrope)", text: "var(--lab-manrope)" },
  { id: "jakarta", name: "Plus Jakarta Sans", display: "var(--lab-jakarta)", text: "var(--lab-jakarta)" },
  { id: "wix", name: "Wix Madefor Display + Text", display: "var(--lab-wixdisplay)", text: "var(--lab-wixtext)" },
  { id: "franklin", name: "Libre Franklin", display: "var(--lab-franklin)", text: "var(--lab-franklin)" },
  { id: "source", name: "Source Sans 3", display: "var(--lab-source)", text: "var(--lab-source)" },
  { id: "nunito", name: "Nunito Sans", display: "var(--lab-nunito)", text: "var(--lab-nunito)" },
];
