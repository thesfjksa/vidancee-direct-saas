#!/usr/bin/env bash
# Runs only as root via authenticated SSH initiated by the Windows GUI.
# Fresh Ubuntu 24.04 VPS only. No secrets are printed or passed in argv.
set -euo pipefail
umask 077

STAGE="$(cd "$(dirname "$0")" && pwd)"
source "$STAGE/setup.conf"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: root privileges required."; exit 1; }
. /etc/os-release
[ "$ID" = "ubuntu" ] && [ "$VERSION_ID" = "24.04" ] || {
  echo "ERROR: Use a fresh Ubuntu 24.04 VPS."; exit 1;
}
[ ! -e /opt/cmmtools-guacamole/.env ] || {
  echo "ERROR: This server already has a gateway. Existing data was not touched."; exit 1;
}
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] && [ -n "$WINDOWS_IP" ] && [ -n "$TAILSCALE_KEY" ] || {
  echo "ERROR: Required gateway values are missing."; exit 1;
}
case "$DOMAIN" in *[!a-zA-Z0-9.-]*|'') echo "ERROR: Invalid domain";exit 1;; esac
case "$WINDOWS_IP" in *[!0-9.]*|'') echo "ERROR: Invalid Windows VPN address";exit 1;; esac
case "$TAILSCALE_KEY" in tskey-auth-*) ;; *) echo "ERROR: Invalid Tailscale auth key";exit 1;; esac

export DEBIAN_FRONTEND=noninteractive
echo "STEP 1/7: Installing gateway prerequisites on Ubuntu."
apt-get -qq update
apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 nginx certbot ca-certificates curl
systemctl enable --now docker nginx >/dev/null

echo "STEP 2/7: Joining your private Tailscale network."
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh -o "$STAGE/tailscale-install.sh"
  bash "$STAGE/tailscale-install.sh" >/dev/null
fi
systemctl enable --now tailscaled >/dev/null
printf '%s\n' "$TAILSCALE_KEY" > "$STAGE/ts-authkey"
chmod 600 "$STAGE/ts-authkey"
tailscale up --auth-key="file:$STAGE/ts-authkey" --hostname=cmmtools-rdp-gateway --accept-dns=false >/dev/null
shred -u "$STAGE/ts-authkey" 2>/dev/null || rm -f "$STAGE/ts-authkey"
unset TAILSCALE_KEY
tailscale ip -4 >/dev/null

echo "STEP 3/7: Preparing the isolated Guacamole containers."
install -d -m 700 /opt/cmmtools-guacamole/drives/customer-1
cp "$STAGE/docker-compose.yml" /opt/cmmtools-guacamole/docker-compose.yml
printf 'GUAC_POSTGRES_PASSWORD=%s\n' "$DB_PASSWORD" > /opt/cmmtools-guacamole/.env
chmod 600 /opt/cmmtools-guacamole/.env
chown -R 1000:1000 /opt/cmmtools-guacamole/drives/customer-1
cd /opt/cmmtools-guacamole
docker compose up -d postgres guacd
for i in $(seq 1 50); do
  if docker compose exec -T postgres pg_isready -U guacamole -d guacamole_db >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose exec -T postgres pg_isready -U guacamole -d guacamole_db >/dev/null

echo "STEP 4/7: Creating the database and changing the default admin password."
docker run --rm guacamole/guacamole:1.6.0 /opt/guacamole/bin/initdb.sh --postgresql > "$STAGE/initdb.sql"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U guacamole -d guacamole_db < "$STAGE/initdb.sql" >/dev/null
rm -f "$STAGE/initdb.sql"
result="$(docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U guacamole -d guacamole_db < "$STAGE/admin.sql")"
[ "$result" = "UPDATE 1" ] || { echo "ERROR: Guacamole initial admin password rotation failed."; exit 1; }
rm -f "$STAGE/admin.sql"
docker compose up -d guacamole

echo "STEP 5/7: Obtaining the HTTPS certificate for $DOMAIN."
install -d -m 755 /var/www/cmm-guac-acme
cat > /etc/nginx/sites-available/cmm-guacamole.conf <<'HTTP_NGINX'
server {
    listen 80;
    server_name REPLACE_DOMAIN;
    location /.well-known/acme-challenge/ {
        root /var/www/cmm-guac-acme;
    }
    location / { return 302 https://$host$request_uri; }
}
HTTP_NGINX
sed -i "s/REPLACE_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/cmm-guacamole.conf
ln -sfn /etc/nginx/sites-available/cmm-guacamole.conf /etc/nginx/sites-enabled/cmm-guacamole.conf
nginx -t
systemctl reload nginx
certbot certonly --webroot -w /var/www/cmm-guac-acme -d "$DOMAIN" \
  -m "$EMAIL" --non-interactive --agree-tos --keep-until-expiring

echo "STEP 6/7: Configuring the encrypted desktop and file-transfer endpoint."
cat > /etc/nginx/sites-available/cmm-guacamole.conf <<'HTTPS_NGINX'
server {
    listen 80;
    server_name REPLACE_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/cmm-guac-acme; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    server_name REPLACE_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/REPLACE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/REPLACE_DOMAIN/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    location = / { return 302 /guacamole/; }
    location /guacamole/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 100m;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_hide_header X-Frame-Options;
        proxy_cookie_flags ~ secure httponly samesite=none;
        add_header Content-Security-Policy "frame-ancestors https://cmmtools.site" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
    }
}
HTTPS_NGINX
sed -i "s/REPLACE_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/cmm-guacamole.conf
nginx -t
systemctl reload nginx

echo "STEP 7/7: Checking the gateway and private Windows connection."
curl -fsSL -o /dev/null --max-time 20 "https://$DOMAIN/guacamole/" || {
  echo "ERROR: HTTPS gateway health check failed."; exit 1;
}
if docker compose exec -T guacd sh -c "nc -z -w 4 $WINDOWS_IP 3389" >/dev/null 2>&1; then
  echo "WINDOWS_RDP=REACHABLE"
else
  echo "WINDOWS_RDP=NOT_REACHABLE_CHECK_WINDOWS_RDP_AND_TAILSCALE_ACL"
fi
touch /opt/cmmtools-guacamole/.installed
echo "GATEWAY=INSTALLED"
echo "The admin password was changed. Configure each customer account and RDP connection inside the Guacamole web UI."
