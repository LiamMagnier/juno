# Setup Guide: Google Cloud (Always Free e2-micro) Backend for Juno

Host Juno's always-on backend on a **Google Cloud `e2-micro` Always Free VM**, so long
reasoning generations are no longer killed by Vercel's 300s serverless timeout.

This guide only covers what's **different from the Oracle guide** (`VM_SETUP_GUIDE.md`);
from Step 4 onward (Node, PM2, nginx, Certbot, PM2 start) the two are identical.

> **Three GCP gotchas, read these first:**
> 1. **The free `e2-micro` only exists in 3 US regions:** `us-west1` (Oregon),
>    `us-central1` (Iowa), `us-east1` (S. Carolina). Any other region = you get billed.
> 2. **Only 1 GB RAM** → `next build` will run out of memory and be killed. You **must**
>    add swap (Step A3) or the build silently fails with "Killed".
> 3. **Disk must be Standard (HDD), ≤ 30 GB.** SSD is **not** free. Pick "Standard
>    persistent disk", not "Balanced" or "SSD".

---

## Step A1: Create the account & project

1. Go to [console.cloud.google.com](https://console.cloud.google.com), sign in with a Google account.
2. Add billing (a card is required, but the `e2-micro` free tier does **not** charge you as
   long as you stay in the 3 free regions with a ≤30 GB standard disk).
3. **Set a budget alert** so you're never surprised: **Billing → Budgets & alerts → Create
   budget → €1**, alert at 50/90/100%. Cheap insurance.
4. Top bar → create a new project, e.g. `juno`.

## Step A2: Create the free VM

**Compute Engine → VM instances → Create instance** (enable the Compute Engine API if asked):

- **Name:** `juno-backend`
- **Region:** `us-central1` (Iowa) · **Zone:** `us-central1-a`  ← must be a free region
- **Machine configuration:** series **E2**, machine type **`e2-micro`** (2 vCPU, 1 GB)
- **Boot disk → Change:**
  - OS: **Ubuntu**, version **Ubuntu 24.04 LTS (x86/64)**
  - Boot disk type: **Standard persistent disk**  ← NOT SSD
  - Size: **30 GB**
- **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**
- Click **Create**. Wait for the green check.

### Reserve a static IP (so it survives reboots)

The default external IP is *ephemeral* — it changes if the VM stops. Pin it:

**VPC network → IP addresses → Reserve external static address**
- Name `juno-ip`, Region `us-central1`, **Attached to** → your `juno-backend` instance.

Note this IP — it's your server's public address.

## Step A3: Connect + add swap (the critical bit)

Click the **SSH** button next to the instance (opens a browser terminal — no key setup needed).

```bash
# Update the system
sudo apt update && sudo apt upgrade -y

# --- ADD 3 GB SWAP so `next build` doesn't get OOM-killed on 1 GB RAM ---
sudo fallocate -l 3G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # should now show ~3.0Gi of Swap
```

## Step A4: Firewall

The **Allow HTTP/HTTPS** checkboxes you ticked already open ports 80/443 at the VPC level.
Ubuntu on GCP does **not** ship the blocking iptables rules that Oracle's image does — so you
can **skip the Oracle guide's iptables step entirely**. Nothing to do here.

---

## Step A5 onward — identical to the Oracle guide

From here, follow **`VM_SETUP_GUIDE.md`** exactly:

- **Step 4** — Install Node.js 20, Git, PM2
- **Step 6** — `git clone` your repo, create `.env` (copy every var from your Vercel project:
  `DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`, `NEXTAUTH_URL`/`AUTH_URL`, all provider keys,
  S3 keys), then `npm ci` → `npx prisma migrate deploy` → `npx prisma generate` →
  `npm run build`. (The build is slow on e2-micro — a few minutes — but the swap keeps it alive.)
- **Step 7** — nginx + Certbot for HTTPS. Copy `deploy/nginx.conf.template`, set your domain,
  run `certbot --nginx`. **You need a domain** pointing an **A record** at your static IP.
  No domain? Get a free one at [duckdns.org](https://www.duckdns.org) (works with Certbot).
- **Step 8** — `pm2 start deploy/ecosystem.config.js`, `pm2 startup`, `pm2 save`.
- **Step 9** — Integration: keep the UI on Vercel and set the `/api/*` rewrite target (in
  `next.config.mjs`, driven by `RENDER_BACKEND_URL`) to `https://<your-vm-domain>`, **or**
  point your whole domain at the VM and drop Vercel. Cloudflare path-routing (Option A) is
  the zero-CORS choice.

## Redeploying later

SSH in and run `./deploy/deploy.sh` — it pulls, rebuilds, and reloads PM2.

---

## e2-micro reality check

- **RAM is tight (1 GB + 3 GB swap).** `next start` idles fine (~200 MB). Builds lean on swap.
  If a build ever hangs, build on your Mac (`npm run build`) and `scp` the `.next/` folder up.
- **US region ↔ your EU Neon database** adds ~100 ms per query. For a chatbot where the model
  thinks for *seconds to minutes*, this is unnoticeable. If it ever bothers you, create the
  Neon project in a US region to co-locate.
- **Free egress is ~1 GB/month (North America).** SSE token streams are tiny text, so you
  won't get near it for personal use.
