#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu 22/24 VM (e.g. Oracle Cloud Always Free).
# Does NOT start the app — fill in .env first, then run it yourself (see final printed instructions).
#
# Usage:
#   chmod +x scripts/setup.sh
#   ./scripts/setup.sh
#
# Safe to re-run: skips steps that are already done (existing clone, existing nvm, existing .env).

set -euo pipefail

NODE_VERSION="20"
APP_DIR="$HOME/arya-agent"

echo "=== Arya Agent (The Oracle) — VM setup ==="
echo

# ---------- 0. repo URL ----------
if [ -z "${REPO_URL:-}" ]; then
  read -rp "GitHub repo URL to clone (e.g. https://github.com/you/arya-agent.git): " REPO_URL
fi
if [ -z "$REPO_URL" ]; then
  echo "No repo URL given, aborting." >&2
  exit 1
fi

# ---------- 1. base packages ----------
echo "--- Updating apt and installing base packages ---"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential

# ---------- 2. nvm + Node 20 LTS ----------
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "--- Installing nvm ---"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"

echo "--- Installing Node ${NODE_VERSION} LTS via nvm ---"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "Node version: $(node -v)"
echo "npm version:  $(npm -v)"

# ---------- 3. clone repo ----------
if [ -d "$APP_DIR/.git" ]; then
  echo "--- $APP_DIR already exists, skipping clone (pull manually if you want latest) ---"
else
  echo "--- Cloning $REPO_URL into $APP_DIR ---"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ---------- 4. npm install ----------
echo "--- Running npm install ---"
npm install

# ---------- 5. .env ----------
if [ -f ".env" ]; then
  echo "--- .env already exists, leaving it as-is ---"
else
  echo "--- Creating .env from .env.example ---"
  cp .env.example .env
fi

# ---------- 6. pm2 + startup ----------
echo "--- Installing pm2 globally ---"
npm install -g pm2

echo "--- Setting TZ=Asia/Kolkata for this shell profile (persists across pm2/reboots) ---"
if ! grep -q "TZ=Asia/Kolkata" "$HOME/.bashrc" 2>/dev/null; then
  echo 'export TZ=Asia/Kolkata' >> "$HOME/.bashrc"
fi
export TZ=Asia/Kolkata

echo "--- Configuring pm2 startup (systemd) ---"
PM2_STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1)
if [[ "$PM2_STARTUP_CMD" == sudo* ]]; then
  echo "Running: $PM2_STARTUP_CMD"
  eval "$PM2_STARTUP_CMD"
else
  echo "pm2 startup did not return a sudo command to run — check output above manually."
fi

# ---------- 7. open .env in nano for editing ----------
echo
echo "=== Now opening .env in nano — fill in every value, then save (Ctrl+O, Enter) and exit (Ctrl+X) ==="
echo "Reference (confirmed read by the code):"
echo "  PORT, ADMIN_PASSWORD"
echo "  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"
echo "  GOOGLE_SENDER_EMAIL"
echo "  DRIVE_INBOX_FOLDER_ID"
echo "  GOOGLE_DRIVE_ROOT_FOLDER_ID   (optional — falls back to DRIVE_INBOX_FOLDER_ID, then 'root'; not in .env.example)"
echo "  DRIVE_POSTED_FOLDER_ID        (optional — posted-video move is skipped if blank)"
echo "  GEMINI_API_KEY"
echo "  GEMINI_CLASSIFY_MODEL, GEMINI_REPLY_MODEL"
echo "  GEMINI_TIER1_MODEL, GEMINI_TIER2_MODEL, GEMINI_TIER3_MODEL"
echo "  OPERATOR_ALERT_NUMBER, BACKLOG_MAX_AGE_DAYS"
echo "  FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID"
echo
echo "In .env.example but NOT currently read by any code (leave blank or ignore for now):"
echo "  DRIVE_POST_QUEUE_FOLDER_ID  — social-post source folder; G.listPostQueue isn't implemented yet"
echo "  WHATSAPP_DEFAULT_GROUP_JID  — group JIDs are actually stored per-batch in data/db.json instead"
echo
read -rp "Press Enter to open nano now..." _
nano .env

# ---------- done ----------
PORT_VALUE=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')
PORT_VALUE=${PORT_VALUE:-3000}

cat <<EOF

=== Setup complete. App NOT started yet. ===

Directory: $APP_DIR
Node:      $(node -v) (via nvm, default alias set to $NODE_VERSION)
pm2:       $(pm2 -v)

Next steps:

1. Double-check .env is fully filled in:
     nano $APP_DIR/.env

2. Start the app under pm2:
     cd $APP_DIR
     pm2 start server.js --name oracle
     pm2 save

3. Scan the WhatsApp QR code (first run only). From YOUR OWN machine (not the VM), open an SSH
   tunnel to the app port, then browse to the QR page — do not expose this port publicly:

     ssh -L ${PORT_VALUE}:localhost:${PORT_VALUE} <your-ssh-user>@<vm-public-ip>

   Then, in a browser on your own machine, open:

     http://localhost:${PORT_VALUE}/qr

   Scan it with the operator's WhatsApp (Linked Devices). Once connected, data/wa-auth/ will be
   populated on the VM and will persist across pm2/VM restarts as long as you don't delete it or
   re-clone over the directory.

4. Verify pm2 will survive a reboot:
     pm2 status
     pm2 logs oracle --lines 50

EOF
