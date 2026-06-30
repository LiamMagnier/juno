import type { Announcement } from "@prisma/client";
import { PROVIDER_LIST, type Provider } from "@/lib/providers";

export type ClientAnnouncement = {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  videoUrl: string | null;
  provider: Provider | null;
  modelName: string | null;
  newsLabel: string | null;
  newsHref: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  published: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function isAnnouncementProvider(value?: string | null): value is Provider {
  return !!value && (PROVIDER_LIST as string[]).includes(value);
}

export function serializeAnnouncement(row: Announcement): ClientAnnouncement {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    videoUrl: row.videoUrl,
    provider: isAnnouncementProvider(row.provider) ? row.provider : null,
    modelName: row.modelName,
    newsLabel: row.newsLabel,
    newsHref: row.newsHref,
    ctaLabel: row.ctaLabel,
    ctaHref: row.ctaHref,
    published: row.published,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
