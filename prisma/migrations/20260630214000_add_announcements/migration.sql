-- Product / model release announcements shown in-app.
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "imageUrl" TEXT,
    "provider" TEXT,
    "modelName" TEXT,
    "ctaLabel" TEXT,
    "ctaHref" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnnouncementDismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDismissal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Announcement_published_startsAt_idx" ON "Announcement"("published", "startsAt");
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");
CREATE UNIQUE INDEX "AnnouncementDismissal_userId_announcementId_key" ON "AnnouncementDismissal"("userId", "announcementId");
CREATE INDEX "AnnouncementDismissal_announcementId_idx" ON "AnnouncementDismissal"("announcementId");

ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnnouncementDismissal" ADD CONSTRAINT "AnnouncementDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnnouncementDismissal" ADD CONSTRAINT "AnnouncementDismissal_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
