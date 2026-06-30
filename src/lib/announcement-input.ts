import { z } from "zod";
import { isAnnouncementProvider } from "@/lib/announcements";

export const announcementInputSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(8).max(1200),
  imageUrl: z.string().trim().max(1000).nullable().optional(),
  videoUrl: z.string().trim().max(1000).nullable().optional(),
  provider: z.string().trim().max(40).nullable().optional(),
  modelName: z.string().trim().max(120).nullable().optional(),
  newsLabel: z.string().trim().max(40).nullable().optional(),
  newsHref: z.string().trim().max(1000).nullable().optional(),
  ctaLabel: z.string().trim().max(40).nullable().optional(),
  ctaHref: z.string().trim().max(1000).nullable().optional(),
  published: z.boolean().optional(),
  startsAt: z.string().trim().nullable().optional(),
  endsAt: z.string().trim().nullable().optional(),
});

function optionalText(value?: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function optionalHref(value?: string | null): string | null {
  const text = optionalText(value);
  if (!text) return null;
  if (text.startsWith("/") || /^https?:\/\//i.test(text)) return text;
  throw new Error("Links must start with /, http://, or https://.");
}

function optionalMediaUrl(value?: string | null, label = "URL"): string | null {
  const text = optionalText(value);
  if (!text) return null;
  if (text.startsWith("/") || /^https?:\/\//i.test(text)) return text;
  throw new Error(`${label} must start with /, http://, or https://.`);
}

function optionalDate(value?: string | null): Date | null {
  const text = optionalText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  return date;
}

export function normalizeAnnouncementInput(input: z.infer<typeof announcementInputSchema>) {
  const provider = optionalText(input.provider);
  if (provider && !isAnnouncementProvider(provider)) throw new Error("Unknown provider.");

  const startsAt = optionalDate(input.startsAt) ?? new Date();
  const endsAt = optionalDate(input.endsAt);
  if (endsAt && endsAt <= startsAt) throw new Error("End date must be after the start date.");

  return {
    title: input.title,
    description: input.description,
    imageUrl: optionalMediaUrl(input.imageUrl, "Image URL"),
    videoUrl: optionalMediaUrl(input.videoUrl, "Video URL"),
    provider,
    modelName: optionalText(input.modelName),
    newsLabel: optionalText(input.newsLabel),
    newsHref: optionalHref(input.newsHref),
    ctaLabel: optionalText(input.ctaLabel),
    ctaHref: optionalHref(input.ctaHref),
    published: input.published ?? false,
    startsAt,
    endsAt,
  };
}
