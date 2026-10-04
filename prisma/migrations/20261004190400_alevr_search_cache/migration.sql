-- Alevr Search (BRIEF §16): the page cache/index, the exact-query cache and the call log.
-- No column here holds a user, a conversation or a query's text.

CREATE TABLE "WebPageCache" (
    "canonicalKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "etag" TEXT,
    "lastModified" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "freshUntil" TIMESTAMP(3) NOT NULL,
    "language" TEXT,
    "contentType" TEXT NOT NULL,
    "admission" TEXT NOT NULL,
    "links" JSONB,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, coalesce("title", '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, left(coalesce("text", ''), 100000)), 'B')
    ) STORED,

    CONSTRAINT "WebPageCache_pkey" PRIMARY KEY ("canonicalKey")
);

CREATE INDEX "WebPageCache_contentHash_idx" ON "WebPageCache"("contentHash");
CREATE INDEX "WebPageCache_host_idx" ON "WebPageCache"("host");
CREATE INDEX "WebPageCache_validatedAt_idx" ON "WebPageCache"("validatedAt");
CREATE INDEX "WebPageCache_searchVector_idx" ON "WebPageCache" USING GIN ("searchVector");

CREATE TABLE "WebQueryCache" (
    "key" TEXT NOT NULL,
    "hits" JSONB NOT NULL,
    "backend" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "served" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WebQueryCache_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "WebQueryCache_expiresAt_idx" ON "WebQueryCache"("expiresAt");

CREATE TABLE "WebSearchCall" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "surface" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "servedBy" TEXT NOT NULL,
    "backend" TEXT,
    "results" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costMicroUsd" INTEGER NOT NULL,
    "cachedPages" INTEGER NOT NULL,
    "backends" JSONB NOT NULL,

    CONSTRAINT "WebSearchCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebSearchCall_at_idx" ON "WebSearchCall"("at");
CREATE INDEX "WebSearchCall_servedBy_at_idx" ON "WebSearchCall"("servedBy", "at");
