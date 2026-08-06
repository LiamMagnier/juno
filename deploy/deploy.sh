#!/bin/bash
set -e

# Print color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Juno Backend Deployment...${NC}"

# Navigate to project root directory
cd "$(dirname "$0")/.."

# Fetch latest code. A previous deploy's on-VM model sync may have modified the
# generated registry — discard it first so the pull never conflicts (the sync
# below regenerates it from the live provider APIs anyway).
echo -e "${YELLOW}📥 Fetching latest code from Git...${NC}"
git checkout -- src/lib/models.generated.ts 2>/dev/null || true
git pull origin main

# --- One-time environment fixes (idempotent) --------------------------------
# AUTH_URL must be the public origin: without it Auth.js derives redirect URLs
# from the internal http://localhost:3000 seen behind nginx, so sign-out (and
# OAuth callbacks) bounce users to localhost in production.
if [ -f .env ] && ! grep -q "^AUTH_URL=" .env; then
    # Strip any trailing inline comment BEFORE the quotes are removed, then the quotes.
    APP_URL=$(grep "^NEXT_PUBLIC_APP_URL=" .env | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' | tr -d '"')
    if [ -n "$APP_URL" ]; then
        echo -e "${YELLOW}🔧 Adding AUTH_URL=$APP_URL to .env (fixes logout → localhost)...${NC}"
        printf '\n# Public origin for Auth.js redirects (sign-out, OAuth callbacks)\nAUTH_URL="%s"\n' "$APP_URL" >> .env
    else
        echo -e "${RED}⚠️ AUTH_URL is missing from .env and NEXT_PUBLIC_APP_URL was not found — set AUTH_URL manually or logout will redirect to localhost.${NC}"
    fi
fi

# nginx's default client_max_body_size is 1 MB, which 413-rejects announcement
# image/video uploads before they ever reach Next.js. Patch the live site
# config in place (never overwrite it — certbot manages parts of that file).
NGINX_SITE="/etc/nginx/sites-available/juno"
if [ -f "$NGINX_SITE" ] && ! sudo grep -q "client_max_body_size" "$NGINX_SITE"; then
    echo -e "${YELLOW}🔧 Adding client_max_body_size 120m to nginx config (fixes news media uploads)...${NC}"
    # Insert inside the TLS server block, right after its IPv4 listen line.
    sudo sed -i '/^[[:space:]]*listen 443 ssl/a\    client_max_body_size 120m;' "$NGINX_SITE"
    if sudo grep -q "client_max_body_size" "$NGINX_SITE" && sudo nginx -t; then
        sudo systemctl reload nginx
        echo -e "${GREEN}✅ nginx reloaded with 120m upload limit.${NC}"
    else
        echo -e "${RED}⚠️ Could not patch $NGINX_SITE automatically — add 'client_max_body_size 120m;' to the 443 server block manually.${NC}"
    fi
fi
# nginx default header buffers (8 × 8k) return 414 Request-URI Too Large on
# long request lines / fat cookies. Bump once if missing.
if [ -f "$NGINX_SITE" ] && ! sudo grep -q "large_client_header_buffers" "$NGINX_SITE"; then
    echo -e "${YELLOW}🔧 Raising nginx large_client_header_buffers (fixes 414 on large requests)...${NC}"
    sudo sed -i '/client_max_body_size/a\    client_header_buffer_size 32k;\n    large_client_header_buffers 8 64k;' "$NGINX_SITE"
    if sudo grep -q "large_client_header_buffers" "$NGINX_SITE" && sudo nginx -t; then
        sudo systemctl reload nginx
        echo -e "${GREEN}✅ nginx reloaded with larger header buffers.${NC}"
    else
        echo -e "${RED}⚠️ Could not patch header buffers on $NGINX_SITE — add large_client_header_buffers 8 64k; manually.${NC}"
    fi
fi
# -----------------------------------------------------------------------------

# Install dependencies
echo -e "${YELLOW}📦 Installing npm dependencies...${NC}"
npm ci

# Apply committed production migrations. Historical production deploys used
# `db push`, so the first run safely converges the existing schema and records
# that baseline; later runs use only `migrate deploy`.
echo -e "${YELLOW}🗄️ Applying database migrations...${NC}"
if node scripts/baseline-production-migrations.mjs --status; then
  npx prisma migrate deploy
else
  npx prisma db push --skip-generate
  npx prisma db execute --file prisma/migrations/20260716200000_account_change_log/migration.sql --schema prisma/schema.prisma
  JUNO_ALLOW_MIGRATION_BASELINE=1 node scripts/baseline-production-migrations.mjs --apply
  npx prisma migrate deploy
fi

# Generate prisma client
echo -e "${YELLOW}💎 Generating Prisma client...${NC}"
npx prisma generate

# Auto-discover new provider models (keys come from .env). Best-effort: a
# provider API hiccup must never block a deploy — the build just ships with
# the registry as pulled from git.
echo -e "${YELLOW}🤖 Syncing model registry from provider APIs...${NC}"
npm run sync:models:write || echo -e "${RED}⚠️ Model sync failed — deploying with the committed registry.${NC}"

# Build Next.js
echo -e "${YELLOW}🏗️ Building application...${NC}"
npm run build

# Build the voice relay (standalone ws service on :8787, proxied at /voice-relay)
echo -e "${YELLOW}🎙️ Building voice relay...${NC}"
npm ci --prefix relay
npm run build --prefix relay

# Reload every production process from the single ecosystem definition. The
# old script reloaded only backend, voice and the scheduled-task worker, leaving
# Work and Code sweeper changes dormant until someone manually restarted them.
echo -e "${YELLOW}🔄 Reloading the complete PM2 ecosystem...${NC}"
pm2 startOrReload deploy/ecosystem.config.js --update-env
pm2 save
echo -e "${GREEN}✅ Backend, Work, Code sweeper, scheduler and voice relay are active!${NC}"

# Do not report success merely because PM2 accepted the reload. Wait for the
# public app to answer with the build that was just pulled. This catches a
# crash-loop, missing migration, or stale process before the deploy script
# hands control back to its caller.
APP_URL="$(grep -m1 '^NEXT_PUBLIC_APP_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)"
APP_URL="${APP_URL%/}"
[ -n "$APP_URL" ] || APP_URL="https://chat.liams.dev"
for attempt in $(seq 1 30); do
    if body=$(curl --silent --show-error --max-time 12 "$APP_URL/api/health" 2>/dev/null); then
        if printf '%s' "$body" | grep -Fq '"ok":true'; then
            echo -e "${GREEN}✅ $APP_URL is healthy (attempt $attempt).${NC}"
            echo -e "${GREEN}🎉 Juno Backend successfully deployed and active!${NC}"
            exit 0
        fi
    fi
    echo -e "${YELLOW}⏳ Waiting for $APP_URL/api/health (attempt $attempt/30)...${NC}"
    sleep 5
done

echo -e "${RED}❌ Deployment did not become healthy. Inspect PM2 and ~/juno-previous before retrying.${NC}"
pm2 status || true
exit 1
