#!/usr/bin/env bash
# One-step deploy of the Dhamma Player to a VPS with Docker.
#   ./deploy.sh
# The admin PIN is read from ./deploy.env (git-ignored), so it never lands in the public repo.
# Overrides: DEPLOY_HOST=root@1.2.3.4 DOMAIN=my.domain ./deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-root@150.95.27.200}"
DOMAIN="${DOMAIN:-150.95.27.200.sslip.io}"
APP_DIR=/opt/dhamma-app
DATA_DIR=/opt/dhamma-data

cd "$(dirname "$0")"
[ -f deploy.env ] && . ./deploy.env
: "${ADMIN_PIN:?Put ADMIN_PIN=xxxx in deploy.env}"

# One shared SSH connection, so the password is asked only once.
SOCK="/tmp/dhamma-ssh-$$"
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=300 -o StrictHostKeyChecking=accept-new)
echo "==> Connecting to $HOST"
ssh "${SSH_OPTS[@]}" -fN "$HOST"
trap 'ssh -o ControlPath="$SOCK" -O exit "$HOST" 2>/dev/null || true' EXIT

ssh "${SSH_OPTS[@]}" "$HOST" "command -v rsync >/dev/null || (apt-get update -qq && apt-get install -y -qq rsync >/dev/null); mkdir -p $APP_DIR"

echo "==> Uploading project to $HOST:$APP_DIR"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .git --exclude .DS_Store --exclude server/data \
  --exclude 'cookies.txt' --exclude '*cookies*.txt' --exclude deploy.env --exclude '*.tmp' \
  ./ "$HOST:$APP_DIR/"

echo "==> Building and starting on the server"
RC=0
ssh "${SSH_OPTS[@]}" "$HOST" bash -s -- "$ADMIN_PIN" "$DOMAIN" "$APP_DIR" "$DATA_DIR" <<'REMOTE' || RC=$?
set -euo pipefail
PIN="$1"; DOMAIN="$2"; APP_DIR="$3"; DATA_DIR="$4"
say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
owner() { ss -ltnpH "sport = :$1" | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2 || true; }

# Persistent data (container runs as uid 1000 "node", so it must own the folder)
mkdir -p "$DATA_DIR"
chown 1000:1000 "$DATA_DIR"
# Secrets in a root-only env file instead of the command line
umask 077
printf 'ADMIN_PIN=%s\nDATA_DIR=/data\n' "$PIN" > /etc/dhamma-app.env
umask 022

say "docker build"
cd "$APP_DIR"
docker build --label app=dhamma-app -t dhamma-app .

docker rm -f dhamma-app >/dev/null 2>&1 || true
P=$(owner 7860)
[ -z "$P" ] || { warn "Port 7860 is already used by '$P' – stop it first."; exit 1; }

# If Nginx Proxy Manager owns 80/443, join its Docker network so it can reach us as http://dhamma-app:7860
NPM=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /nginx-proxy-manager/ {print $1; exit}')
NET_ARGS=()
if [ -n "$NPM" ]; then
  NET=""
  # Own small network shared only by NPM and this app (never join another project's network)
  if ! docker inspect "$NPM" --format '{{.HostConfig.NetworkMode}}' | grep -qx host; then
    NET=dhamma-proxy
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    docker inspect "$NPM" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep -qx "$NET" \
      || docker network connect "$NET" "$NPM"
  fi
  [ -n "$NET" ] && NET_ARGS=(--network "$NET") && echo "Joining Docker network '$NET' (shared with $NPM)"
fi

say "docker run"
docker run -d --name dhamma-app --restart unless-stopped \
  "${NET_ARGS[@]}" \
  -p 127.0.0.1:7860:7860 \
  -v "$DATA_DIR":/data \
  --env-file /etc/dhamma-app.env \
  --memory 1g \
  dhamma-app >/dev/null
docker image prune -f --filter label=app=dhamma-app >/dev/null

for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:7860/health >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { docker logs --tail 40 dhamma-app; warn "App did not start"; exit 1; }
  sleep 1
done
docker logs --tail 5 dhamma-app

# ---------- HTTPS via Nginx Proxy Manager ----------
if [ -n "$NPM" ]; then
  if [ -n "${NET_ARGS[*]}" ]; then FWD=dhamma-app; else FWD=127.0.0.1; fi
  if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
    say "HTTPS OK via Nginx Proxy Manager"; exit 0
  fi
  warn "Ports 80/443 belong to Nginx Proxy Manager ($NPM). Add this once in its admin UI (http://<server-ip>:81):"
  echo "   Hosts → Proxy Hosts → Add Proxy Host"
  echo "     Domain Names:          $DOMAIN"
  echo "     Scheme:                http"
  echo "     Forward Hostname / IP: $FWD"
  echo "     Forward Port:          7860"
  echo "     ☑ Block Common Exploits   (leave 'Cache Assets' OFF)"
  echo "   SSL tab: Request a new SSL Certificate, ☑ Force SSL, ☑ HTTP/2 Support → Save"
  exit 3
fi

# ---------- HTTPS with Caddy ----------
O80=$(owner 80); O443=$(owner 443)
for o in "$O80" "$O443"; do
  if [ -n "$o" ] && [ "$o" != caddy ]; then
    warn "Ports 80/443 are used by '$o' (port 80: ${O80:-free}, 443: ${O443:-free})."
    warn "Caddy was NOT installed, so your existing sites are untouched."
    warn "The app is running at 127.0.0.1:7860 – it needs a proxy entry in that web server."
    docker ps --format '  {{.Names}}  {{.Image}}  {{.Ports}}' | grep -E ':(80|443)->' || true
    exit 3
  fi
done

if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg curl >/dev/null
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  # drop the stock "welcome page" site
  grep -q '/usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null && : > /etc/caddy/Caddyfile
fi

if ! grep -q "^$DOMAIN {" /etc/caddy/Caddyfile 2>/dev/null; then
  printf '\n%s {\n\tencode gzip\n\treverse_proxy localhost:7860\n}\n' "$DOMAIN" >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Waiting for the HTTPS certificate"
for i in $(seq 1 30); do
  curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1 && { echo "HTTPS OK"; exit 0; }
  sleep 3
done
warn "HTTPS not answering yet. Check: journalctl -u caddy -n 30 --no-pager"
warn "and make sure TCP 80 and 443 are open in your VPS provider's firewall."
exit 4
REMOTE

if [ "$RC" = 3 ]; then
  # Nginx Proxy Manager owns 80/443 and has no site for us yet: add it through its API (on the server)
  echo
  echo "==> Adding $DOMAIN to Nginx Proxy Manager automatically"
  echo "    Enter the login you use at http://<server>:81 (sent over SSH only, not saved)."
  [ -n "${NPM_USER:-}" ] || read -rp "    NPM email: " NPM_USER
  [ -n "${NPM_PASS:-}" ] || { read -rsp "    NPM password: " NPM_PASS; echo; }
  printf '%s\n%s\n' "$NPM_USER" "$NPM_PASS" \
    | ssh "${SSH_OPTS[@]}" "$HOST" python3 "$APP_DIR/deploy/npm_proxy.py" "$DOMAIN" dhamma-app 7860 \
    || { echo "⚠ Automatic setup failed – use the manual steps printed above."; exit 1; }
  sleep 3
elif [ "$RC" != 0 ]; then
  exit "$RC"
fi

echo "==> Checking from this Mac"
if curl -fsS --max-time 15 "https://$DOMAIN/health"; then
  echo
  echo "✅ Deployed"
  echo "   Grandma's phone : https://$DOMAIN"
  echo "   Admin           : https://$DOMAIN/#admin   (PIN from deploy.env)"
else
  echo "⚠ https://$DOMAIN is not reachable from here yet."
fi
