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

# Fetch latest code
echo -e "${YELLOW}📥 Fetching latest code from Git...${NC}"
git pull origin main

# Install dependencies
echo -e "${YELLOW}📦 Installing npm dependencies...${NC}"
npm ci

# Run database migrations / pushes
echo -e "${YELLOW}🗄️ Preparing database schema...${NC}"
npx prisma db push --skip-generate

# Generate prisma client
echo -e "${YELLOW}💎 Generating Prisma client...${NC}"
npx prisma generate

# Build Next.js
echo -e "${YELLOW}🏗️ Building application...${NC}"
npm run build

# Restart/Reload PM2 process
echo -e "${YELLOW}🔄 Reloading PM2 process...${NC}"
if pm2 describe juno-backend > /dev/null 2>&1; then
    pm2 reload juno-backend
    echo -e "${GREEN}✅ PM2 process 'juno-backend' reloaded successfully!${NC}"
else
    pm2 start npm --name "juno-backend" -- start
    echo -e "${GREEN}✅ PM2 process 'juno-backend' started successfully!${NC}"
fi

echo -e "${GREEN}🎉 Juno Backend successfully deployed and active!${NC}"
