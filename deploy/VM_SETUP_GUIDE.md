# Setup Guide: Oracle Cloud VM Backend for Juno

This guide walks you through setting up your persistent backend on an **Oracle Cloud Always Free VM (Ubuntu 22.04)**. It assumes you want to keep your frontend on **Vercel** and route your API requests (`/api/...`) to this VM to prevent the 300-second serverless timeout.

---

## 📋 Table of Contents
1. [Step 1: Create Compute Instance on Oracle Cloud](#step-1-create-compute-instance-on-oracle-cloud)
2. [Step 2: Configure Oracle Cloud Network Firewall](#step-2-configure-oracle-cloud-network-firewall)
3. [Step 3: Connect to your VM & Update System](#step-3-connect-to-your-vm--update-system)
4. [Step 4: Install Node.js, PM2, and Git](#step-4-install-nodejs-pm2-and-git)
5. [Step 5: Configure the Ubuntu Host Firewall](#step-5-configure-the-ubuntu-host-firewall)
6. [Step 6: Clone Code & Configure Environments](#step-6-clone-code--configure-environments)
7. [Step 7: Configure Nginx & SSL (Let's Encrypt)](#step-7-configure-nginx--ssl-lets-encrypt)
8. [Step 8: Start the App with PM2](#step-8-start-the-app-with-pm2)
9. [Step 9: Choose your Integration & Domain Strategy](#step-9-choose-your-integration--domain-strategy)

---

## Step 1: Create Compute Instance on Oracle Cloud

1. Sign up/log in at [oracle.com/cloud/free](https://www.oracle.com/cloud/free).
2. Go to the navigation menu -> **Compute** -> **Instances** -> **Create Instance**.
3. Configure the VM:
   - **Name**: `juno-backend`
   - **Image**: Click *Edit* -> select **Ubuntu 22.04 LTS** (Recommended).
   - **Shape**: Select an **Always Free** eligible shape:
     - *ARM Ampere (VM.Standard.A1.Flex)*: Select up to 4 OCPUs and 24 GB of RAM (Highly Recommended if capacity is available in your home region).
     - *AMD (VM.Standard.E2.1.Micro)*: 1 OCPU, 1 GB RAM (A good alternative if ARM capacity is full).
   - **Networking**:
     - Keep the default "Create virtual cloud network (VCN)" and "Create public subnet".
     - Select **Assign a public IPv4 address** (Yes).
   - **SSH Keys**:
     - Click **Save Private Key** (saves a `.key` or `.pem` file). **Crucial: Do not lose this file!**
4. Click **Create** at the bottom. Wait until the status changes from *Provisioning* to *Running*. Note down your **Public IP Address**.

---

## Step 2: Configure Oracle Cloud Network Firewall

By default, Oracle Cloud blocks all incoming traffic except SSH. You must allow traffic on ports `80` (HTTP) and `443` (HTTPS) to make your backend accessible.

1. On the Instance details page, look under **Instance Information** and click on your **Virtual Cloud Network** link.
2. Under **Resources** on the left, click **Security Lists**, then click on your **Default Security List** (e.g. `Default Security List for vcn-...`).
3. Click **Add Ingress Rules** and configure:
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: `TCP`
   - **Destination Port Range**: `80,443`
   - **Description**: `Allow HTTP and HTTPS traffic`
4. Click **Add Ingress Rules** to save.

---

## Step 3: Connect to your VM & Update System

Open a terminal on your local computer (macOS/Linux) and execute:

```bash
# 1. Restrict permissions on your downloaded SSH key (required by SSH clients)
chmod 400 /path/to/your-ssh-key.key

# 2. SSH into your VM (replace with your VM's public IP)
ssh -i /path/to/your-ssh-key.key ubuntu@<YOUR_VM_PUBLIC_IP>
```
*Note: If prompted "Are you sure you want to continue connecting?", type `yes` and press Enter.*

Once connected, update the VM system:
```bash
sudo apt update && sudo apt upgrade -y
```

---

## Step 4: Install Node.js, PM2, and Git

Run the following commands inside your VM SSH session to set up runtime requirements:

```bash
# 1. Install Node.js v20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install Git
sudo apt-get install -y git

# 3. Install PM2 globally
sudo npm install pm2 -g

# 4. Verify everything works
node -v   # Should be v20.x.x
npm -v    # Should be v10.x.x
pm2 -v    # Should show version number
```

---

## Step 5: Configure the Ubuntu Host Firewall

Oracle Cloud's Ubuntu image has pre-configured local firewall rules (`iptables`) that block incoming traffic even after you open the Oracle dashboard firewall. You need to allow traffic locally:

```bash
# 1. Insert rules to accept HTTP, HTTPS and Next.js (port 3000)
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT

# 2. Make these rules persist when the server reboots
sudo apt-get install iptables-persistent -y
# When prompted to save IPv4 and IPv6 rules, select "Yes" for both.

# 3. Save rules manually (in case they didn't auto-save)
sudo netfilter-persistent save
```

---

## Step 6: Clone Code & Configure Environments

Now clone your repository and configure your credentials.

```bash
# 1. Clone your project (replace with your actual git URL)
git clone <YOUR_GIT_REPO_URL> juno
cd juno

# 2. Create the production env file
nano .env
```

Paste your environment variables. Make sure they match your Vercel configurations:
```env
DATABASE_URL="postgresql://..." # Your Neon/Supabase pooled Postgres connection string
DIRECT_URL="postgresql://..." # Your direct database connection string (used for migrations)
AUTH_SECRET="your-auth-secret" # Must match Vercel AUTH_SECRET
ANTHROPIC_API_KEY="sk-ant-..."
NEXT_PUBLIC_APP_URL="https://yourdomain.com" # Replace with your custom domain

# Dynamic cookie subdomain config (Needed ONLY if you choose Option 2: Subdomains)
# For example, if app is app.domain.com and backend is api.domain.com, use:
# COOKIE_DOMAIN=".domain.com"
```
*To save inside Nano: Press `Ctrl + O`, then `Enter`, then exit with `Ctrl + X`.*

Next, build the project:
```bash
# 3. Install dependencies from lockfile
npm ci

# 4. Synchronize Database schema (Prisma)
npx prisma db push --skip-generate

# 5. Generate client & Build Next.js
npx prisma generate
npm run build
```

---

## Step 7: Configure Nginx & SSL (Let's Encrypt)

We use Nginx as a reverse proxy to route traffic from public SSL port `443` to local port `3000` (Next.js).

```bash
# 1. Install Nginx
sudo apt install nginx -y

# 2. Create the site configuration (we've provided a template in your repository)
sudo cp deploy/nginx.conf.template /etc/nginx/sites-available/juno

# 3. Edit the copied config file to set your custom domain
sudo nano /etc/nginx/sites-available/juno
```
*Change `YOUR_DOMAIN` (in both server blocks) to your API domain (e.g., `api.yourdomain.com`). Save and exit.*

Enable the configuration:
```bash
# 4. Create symlink to enable the config
sudo ln -s /etc/nginx/sites-available/juno /etc/nginx/sites-enabled/

# 5. Disable default Nginx index site
sudo rm /etc/nginx/sites-enabled/default

# 6. Test configuration & reload Nginx
sudo nginx -t # Must say "syntax is ok"
sudo systemctl restart nginx
```

### Enable HTTPS with SSL (Let's Encrypt)
Make sure your custom domain is pointing (DNS A Record) to the VM's public IP before running this:
```bash
# 7. Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# 8. Obtain SSL certificate (Certbot will automatically edit your Nginx files to enable HTTPS)
sudo certbot --nginx -d api.yourdomain.com
```
*Follow the prompts, enter your email, accept the Terms, and select option to redirect all HTTP traffic to HTTPS.*

---

## Step 8: Start the App with PM2

We start Next.js through PM2. We have provided `deploy/ecosystem.config.js` in the repository to manage this.

```bash
# 1. Start backend process
pm2 start deploy/ecosystem.config.js

# 2. Make PM2 launch on VM startup / reboot
pm2 startup
# This command will output a specific command you need to copy and execute.
# It starts with: sudo env PATH=$PATH:/usr/bin pm2 startup ...
# Copy that line, paste it, and run it.

# 3. Save running process configuration
pm2 save
```

### Updating the Backend (Future Deployments)
We've created a `deploy/deploy.sh` script to pull updates and restart PM2. To update your backend, just SSH in and run:
```bash
./deploy/deploy.sh
```

---

## Step 9: Choose your Integration & Domain Strategy

Once your VM is running, you must choose how Vercel and the Oracle VM talk to each other:

### Option A: Cloudflare Path Routing (Recommended - Zero Code Changes)
1. Point your domain (e.g., `yourdomain.com`) to Cloudflare.
2. Point Vercel to your Cloudflare domain.
3. In the Cloudflare Dashboard, go to **Rules** -> **Origin Rules** -> **Create Rule**.
4. Configure:
   - **When incoming requests match**: Custom filter expression.
   - **Field**: `URI Path`
   - **Operator**: `starts with`
   - **Value**: `/api/`
   - **Then... Destination**: Override destination IP/Port -> select **IP Address** -> Enter your **Oracle VM Public IP** (and port `443` or override port to `443`).
5. Under SSL/TLS settings in Cloudflare, set encryption mode to **Full (strict)**.
6. Under this setup, Vercel is completely bypassed for any `/api/...` calls. The browser talks directly to the VM through Cloudflare, avoiding all Vercel timeouts with zero CORS or cookie issues!

### Option B: Subdomain Cookie Sharing
If you prefer standard subdomains (e.g., frontend on `app.yourdomain.com` and backend on `api.yourdomain.com`):
1. In your DNS provider, create:
   - `CNAME` or `A` record for `app.yourdomain.com` pointing to Vercel.
   - `A` record for `api.yourdomain.com` pointing to the VM's public IP.
2. In both Vercel and VM env configs, set:
   - `COOKIE_DOMAIN=".yourdomain.com"` (Note the leading dot! This allows subdomains to read/write the cookie).
3. NextAuth will automatically share the session token. NextAuth requests will go to `api.yourdomain.com/api/auth` or local endpoints and validate the user.
