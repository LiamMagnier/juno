import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/lib/providers";

const LOGO_SRC: Record<Provider, { light: string; dark: string }> = {
  anthropic: {
    light: "/provider-logos/light/anthropic.png",
    dark: "/provider-logos/dark/anthropic.png",
  },
  openai: {
    light: "/provider-logos/light/openai.png",
    dark: "/provider-logos/dark/openai.png",
  },
  google: {
    light: "/provider-logos/light/google.png",
    dark: "/provider-logos/dark/google.png",
  },
  meta: {
    light: "/provider-logos/light/meta.png",
    dark: "/provider-logos/dark/meta.png",
  },
  zhipu: {
    light: "/provider-logos/light/zhipu.png",
    dark: "/provider-logos/dark/zhipu.png",
  },
  moonshot: {
    light: "/provider-logos/light/moonshot.png",
    dark: "/provider-logos/dark/moonshot.png",
  },
  deepseek: {
    light: "/provider-logos/light/deepseek.png",
    dark: "/provider-logos/dark/deepseek.png",
  },
  mistral: {
    light: "/provider-logos/light/mistral.png",
    dark: "/provider-logos/dark/mistral.png",
  },
  xai: {
    light: "/provider-logos/light/xai.png",
    dark: "/provider-logos/dark/xai.png",
  },
  seedance: {
    light: "/provider-logos/light/seedance.png",
    dark: "/provider-logos/dark/seedance.png",
  },
  minimax: {
    light: "/provider-logos/light/minimax.png",
    dark: "/provider-logos/dark/minimax.png",
  },
  mimo: {
    light: "/provider-logos/light/mimo.png",
    dark: "/provider-logos/dark/mimo.png",
  },
};

export function providerLogoSrc(provider: Provider, theme: "light" | "dark" = "light"): string {
  return LOGO_SRC[provider]?.[theme] ?? LOGO_SRC.openai[theme];
}

export function ProviderLogo({
  provider,
  className,
  label,
}: {
  provider: Provider;
  className?: string;
  label?: string;
}) {
  const src = LOGO_SRC[provider] ?? LOGO_SRC.openai;
  const alt = label ?? PROVIDERS[provider]?.label ?? provider;

  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[32%] border border-border/55 bg-card shadow-sm",
        className
      )}
    >
      <img src={src.light} alt={alt} className="h-full w-full object-contain p-[12%] dark:hidden" draggable={false} loading="lazy" />
      <img src={src.dark} alt="" className="hidden h-full w-full object-contain p-[12%] dark:block" draggable={false} loading="lazy" />
    </span>
  );
}
