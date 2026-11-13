#!/usr/bin/env bash
# Install or update the Dhamma Player on an Ubuntu/Debian VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/hlaingminkyaw/offline-video/main/deploy/setup-vps.sh -o setup-vps.sh
#   sudo bash setup-vps.sh
#
# Run it again at any time to update to the latest code from GitHub.
#
# Everything lives in /opt/offline-video and runs as the user "dhamma".
# Its own Node.js copy is used, so Node apps already on the server are not touched.
# HTTPS: Caddy is installed when ports 80/443 are free. If nginx, Apache or Caddy
# already owns them, a site for this app is added to it instead.
#
# Optional settings (put them before the command, e.g. DOMAIN=dhamma.example.com sudo -E bash setup-vps.sh):
#   DOMAIN     Hostname to serve on. Default: <ip-with-dashes>.sslip.io (works without buying a domain)
#   ADMIN_PIN  PIN for #admin. Asked for on first install if not given.
#   APP_PORT   Internal port (default 7860, only reachable from the server itself)
#   EMAIL      Email for Let's Encrypt expiry notices (optional)
#   SKIP_FFMPEG=1  Don't install ffmpeg (only needed for rare video formats)
set -euo pipefail

REPO="${REPO:-https://github.com/hlaingminkyaw/offline-video.git}"
BRANCH="${BRANCH:-main}"
BASE=/opt/offline-video
APP="$BASE/app"
SVC_USER=dhamma
ENV_FILE=/etc/offline-video.env
APP_PORT="${APP_PORT:-7860}"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root: sudo bash $0"
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian only."

case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64;   YTDLP_BIN=yt-dlp_linux ;;
  aarch64) NODE_ARCH=arm64; YTDLP_BIN=yt-dlp_linux_aarch64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac

# ---------- disk space ----------
FREE_MB=$(df -Pm / | awk 'NR==2{print $4}')
say "Free disk space: ${FREE_MB} MB"
if [ "$FREE_MB" -lt 1200 ]; then
  die "Less than 1.2 GB free. Free some space first, e.g.:
   apt-get clean; journalctl --vacuum-size=200M; docker system prune (if you use Docker)
   du -xh / --max-depth=2 2>/dev/null | sort -h | tail -20     # find what is big"
fi
apt-get clean || true

# ---------- packages ----------
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git curl ca-certificates xz-utils >/dev/null
if [ "${SKIP_FFMPEG:-0}" != 1 ] && ! command -v ffmpeg >/dev/null; then
  if [ "$FREE_MB" -gt 2500 ]; then
    apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
  else
    warn "Skipping ffmpeg (disk is tight). Audio and normal 360p video work without it."
  fi
fi

# ---------- user + folders ----------
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$BASE"/{bin,data,tmp}

# ---------- private Node.js 22 ----------
if [ ! -x "$BASE/node/bin/node" ]; then
  say "Installing Node.js 22 into $BASE/node (system Node is not touched)"
  NODE_TAR=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$" {print $2; exit}')
  [ -n "$NODE_TAR" ] || die "Could not find the Node.js download."
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NODE_TAR" -o /tmp/node.tar.xz
  rm -rf "$BASE/node" && mkdir -p "$BASE/node"
  tar -xJf /tmp/node.tar.xz -C "$BASE/node" --strip-components=1
  rm -f /tmp/node.tar.xz
fi
"$BASE/node/bin/node" -v

# ---------- yt-dlp ----------
if [ ! -x "$BASE/bin/yt-dlp" ]; then
  say "Installing yt-dlp"
  curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_BIN" -o "$BASE/bin/yt-dlp"
  chmod 755 "$BASE/bin/yt-dlp"
fi

# ---------- app code ----------
if [ -d "$APP/.git" ]; then
  say "Updating app code"
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  say "Downloading app code"
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$APP"
fi
chown -R "$SVC_USER:$SVC_USER" "$BASE"
say "Installing server packages"
( cd "$APP/server" && runuser -u "$SVC_USER" -- env PATH="$BASE/node/bin:$PATH" HOME="$BASE" \
    npm ci --omit=dev --no-audit --no-fund --loglevel=error )
runuser -u "$SVC_USER" -- env PATH="$BASE/node/bin:$PATH" "$BASE/bin/yt-dlp" -U >/dev/null 2>&1 || true

# ---------- settings ----------
if [ ! -f "$ENV_FILE" ]; then
  PIN="${ADMIN_PIN:-}"
  if [ -z "$PIN" ] && [ -t 0 ]; then
    read -rsp "Choose an Admin PIN for #admin (input hidden): " PIN; echo
  fi
  if [ -z "$PIN" ]; then
    PIN=$(printf '%06d' $(( (RANDOM << 15 | RANDOM) % 1000000 )))
    warn "No PIN given. Generated Admin PIN: $PIN  (change it in $ENV_FILE)"
  fi
  cat >"$ENV_FILE" <<EOF
# Dhamma Player settings. After editing: systemctl restart offline-video
ADMIN_PIN=$PIN
HOST=127.0.0.1
PORT=$APP_PORT
NODE_ENV=production
YTDLP_PATH=$BASE/bin/yt-dlp
DOWNLOAD_DIR=$BASE/tmp
CATALOG_FILE=$BASE/data/catalog.json
SOURCES_FILE=$BASE/data/sources.json
# Small server: one yt-dlp job at a time
MAX_CONCURRENT=1
MAX_JOBS=10
# YTDLP_COOKIES_FILE=$BASE/data/cookies.txt
EOF
  chmod 600 "$ENV_FILE"
else
  say "Keeping existing settings in $ENV_FILE"
  APP_PORT=$(awk -F= '$1=="PORT"{print $2}' "$ENV_FILE"); APP_PORT=${APP_PORT:-7860}
fi

if ss -ltnH "sport = :$APP_PORT" | grep -q . && ! systemctl is-active -q offline-video; then
  die "Port $APP_PORT is already used by another program. Re-run with APP_PORT=7861 (after: rm $ENV_FILE)."
fi

# ---------- systemd service ----------
cat >/etc/systemd/system/offline-video.service <<EOF
[Unit]
Description=Dhamma Player (offline-video)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$APP/server
EnvironmentFile=$ENV_FILE
Environment=PATH=$BASE/node/bin:$BASE/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=-$BASE/bin/yt-dlp -U
ExecStart=$BASE/node/bin/node server.js
Restart=always
RestartSec=5
Nice=5
MemoryMax=700M
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
# keep yt-dlp current (YouTube changes often)
echo "17 4 * * * $SVC_USER $BASE/bin/yt-dlp -U >/dev/null 2>&1" >/etc/cron.d/offline-video-ytdlp

systemctl daemon-reload
systemctl enable -q offline-video
systemctl restart offline-video
say "Waiting for the app to start"
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 30 ] && die "App did not start. See: journalctl -u offline-video -n 50"
done
echo "App is running on 127.0.0.1:$APP_PORT"

# ---------- HTTPS ----------
PUBLIC_IP=$(curl -fsS4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
say "Setting up HTTPS for $DOMAIN"

owner() { ss -ltnpH "sport = :$1" | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2 || true; }
P80=$(owner 80); P443=$(owner 443); WEB="${P443:-$P80}"
echo "Port 80: ${P80:-free}   Port 443: ${P443:-free}"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

certbot_for() {   # $1 = nginx | apache
  command -v certbot >/dev/null || apt-get install -y -qq certbot "python3-certbot-$1" >/dev/null
  dpkg -s "python3-certbot-$1" >/dev/null 2>&1 || apt-get install -y -qq "python3-certbot-$1" >/dev/null
  local mail=(--register-unsafely-without-email); [ -n "${EMAIL:-}" ] && mail=(-m "$EMAIL")
  certbot "--$1" -d "$DOMAIN" --non-interactive --agree-tos --redirect "${mail[@]}"
}

case "$WEB" in
  ""|caddy)
    if ! command -v caddy >/dev/null; then
      say "Installing Caddy (automatic HTTPS)"
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
      # replace the stock "welcome page" config
      grep -q '/usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null && : >/etc/caddy/Caddyfile
    fi
    if ! grep -q "^$DOMAIN " /etc/caddy/Caddyfile 2>/dev/null; then
      printf '\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$APP_PORT" >>/etc/caddy/Caddyfile
    fi
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    systemctl enable -q caddy; systemctl reload caddy 2>/dev/null || systemctl restart caddy
    ;;
  nginx)
    if [ -d /etc/nginx/sites-enabled ]; then CONF=/etc/nginx/sites-available/offline-video; else CONF=/etc/nginx/conf.d/offline-video.conf; fi
    if [ ! -f "$CONF" ]; then
      cat >"$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
EOF
      [ -d /etc/nginx/sites-enabled ] && ln -sf "$CONF" /etc/nginx/sites-enabled/offline-video
    fi
    nginx -t && systemctl reload nginx
    certbot_for nginx
    ;;
  apache2|httpd)
    a2enmod -q proxy proxy_http headers >/dev/null
    CONF=/etc/apache2/sites-available/offline-video.conf
    if [ ! -f "$CONF" ]; then
      cat >"$CONF" <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:$APP_PORT/
    ProxyPassReverse / http://127.0.0.1:$APP_PORT/
</VirtualHost>
EOF
      a2ensite -q offline-video >/dev/null
    fi
    apachectl configtest && systemctl reload apache2
    certbot_for apache
    ;;
  *)
    warn "Ports 80/443 are used by '$WEB'. The app runs on 127.0.0.1:$APP_PORT;"
    warn "point that web server (or its proxy) at it for https://$DOMAIN"
    exit 0
    ;;
esac

say "Checking https://$DOMAIN"
for i in $(seq 1 20); do
  curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1 && OK=1 && break
  sleep 3
done
if [ "${OK:-0}" = 1 ]; then
  say "Done!"
  echo "  Grandma's phone : https://$DOMAIN"
  echo "  Admin           : https://$DOMAIN/#admin"
else
  warn "HTTPS is not answering yet. Usually your cloud provider's firewall blocks ports 80/443:"
  warn "open TCP 80 and 443 in its control panel (security group), then run this script again."
fi
echo
echo "  Settings : $ENV_FILE   (then: systemctl restart offline-video)"
echo "  Logs     : journalctl -u offline-video -f"
echo "  Update   : sudo bash $0"
