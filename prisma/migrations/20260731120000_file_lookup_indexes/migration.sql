-- CreateIndex
--
-- `GET /api/files/[...key]` resolves authorization by looking the object key up
-- in three places in sequence (canReadObject): the attachment that owns it, a
-- user whose avatar it is, then an announcement that embeds it. None of those
-- columns was indexed, so every avatar render sequentially scanned "User" and
-- every attachment fetch scanned "Attachment".
--
-- This got hotter, not colder, when the route stopped buffering whole objects:
-- media is now served over HTTP Range, so one video costs several requests
-- instead of one, and each pays the same lookups.
--
-- IF NOT EXISTS keeps this safe on a database where an index was already added
-- out-of-band (avoids the P3009 failure that blocks every later `migrate
-- deploy`). Plain CREATE INDEX, not CONCURRENTLY: Prisma runs migrations inside
-- a transaction, and these tables are small enough that the brief write lock is
-- not worth the complexity of splitting them out.
CREATE INDEX IF NOT EXISTS "Attachment_storageKey_idx" ON "Attachment"("storageKey");
CREATE INDEX IF NOT EXISTS "User_image_idx" ON "User"("image");
CREATE INDEX IF NOT EXISTS "Announcement_imageUrl_idx" ON "Announcement"("imageUrl");
CREATE INDEX IF NOT EXISTS "Announcement_videoUrl_idx" ON "Announcement"("videoUrl");
