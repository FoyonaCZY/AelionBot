#!/usr/bin/env bash
# Installs the AelionBot relay, or only the phone app, on Ubuntu 22.04+ / Debian 12+, behind Caddy (automatic HTTPS).
#
#   sudo ./install.sh relay relay.example.com            # relay (also serves the phone app) + STUN for direct links
#   sudo ./install.sh app app.example.com wss://relay.example.com   # the phone app alone, on another host
#
# Run it from the unpacked bundle made by `pnpm run relay:build` (relay.cjs and public/ next to this script's
# folder). The domain's DNS must already point at this server: Caddy asks Let's Encrypt for the certificate.
set -euo pipefail

role=${1:-}
domain=${2:-}
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
[[ $role == relay || $role == app ]] || { echo "usage: install.sh relay <domain> | install.sh app <domain> <relay wss url>" >&2; exit 2; }
[[ $domain =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid domain: $domain" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
[[ -f $here/public/index.html ]] || { echo "public/index.html not found next to deploy/ (build with pnpm run relay:build)" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
# A fresh server often runs unattended upgrades at first boot: wait for the package lock instead of failing.
apt_get() { apt-get -o DPkg::Lock::Timeout=300 "$@"; }
apt_get update -q
apt_get install -y -q curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

csp() {
  echo "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' $1; frame-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"
}

# The web server in front: Caddy on a server of its own; an nginx already serving other sites is used as it is.
port_owner() { ss -ltnpH "( sport = :443 )" 2>/dev/null | grep -oE '"[a-z0-9_-]+"' | head -1 | tr -d '"'; }
owner=$(port_owner)
if [[ -n $owner && $owner != caddy && $owner != nginx ]]; then
  echo "port 443 is used by $owner. Stop it, or put the relay behind it yourself (see relay/README.md)." >&2
  exit 1
fi
if [[ $owner != nginx ]] && ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt_get update -q
  apt_get install -y -q caddy
fi

# nginx: an HTTP site answers Let's Encrypt, certbot gets the certificate, then the HTTPS site replaces it.
# Every change is checked with nginx -t before nginx reloads, so the other sites keep running.
nginx_site() {
  local name=$1 body=$2
  command -v certbot >/dev/null || apt_get install -y -q certbot
  install -d -m 0755 /var/www/aelion-acme
  cat > /etc/nginx/sites-available/$name <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $name;
    location /.well-known/acme-challenge/ { root /var/www/aelion-acme; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX
  ln -sf /etc/nginx/sites-available/$name /etc/nginx/sites-enabled/$name
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/aelion-acme -d "$name" --non-interactive --agree-tos --keep-until-expiring \
    --register-unsafely-without-email --deploy-hook "systemctl reload nginx"
  local options=""
  [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] && options="include /etc/letsencrypt/options-ssl-nginx.conf;"
  [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] && options="$options ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
  cat >> /etc/nginx/sites-available/$name <<NGINX
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $name;
    ssl_certificate /etc/letsencrypt/live/$name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$name/privkey.pem;
    $options
$body
}
NGINX
  if ! nginx -t; then
    rm -f /etc/nginx/sites-enabled/$name
    echo "nginx rejected the site; it was not enabled" >&2
    exit 1
  fi
  systemctl reload nginx
}

if [[ $role == app ]]; then
  relay=${3:-}
  [[ $relay =~ ^wss://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "the relay must be a wss:// address, e.g. wss://relay.example.com" >&2; exit 2; }
  install -d -m 0755 /var/www/aelion-app
  rm -rf /var/www/aelion-app.new
  cp -r "$here/public" /var/www/aelion-app.new
  rm -rf /var/www/aelion-app.old
  mv /var/www/aelion-app /var/www/aelion-app.old
  mv /var/www/aelion-app.new /var/www/aelion-app
  rm -rf /var/www/aelion-app.old
  if [[ $owner == nginx ]]; then
    # add_header in a location replaces the server's, so each location states all of its headers.
    nginx_site "$domain" "    root /var/www/aelion-app;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml application/manifest+json;
    location /assets/ {
        add_header Cache-Control \"public, max-age=31536000, immutable\" always;
        add_header X-Content-Type-Options nosniff always;
        try_files \$uri =404;
    }
    location = /manifest.webmanifest {
        default_type application/manifest+json;
        add_header Cache-Control no-cache always;
    }
    # The widget frame carries its own policy; the page's would block its inline script.
    location = /widget-frame.html {
        add_header Cache-Control no-cache always;
        add_header X-Content-Type-Options nosniff always;
    }
    location / {
        add_header Content-Security-Policy \"$(csp "$relay")\" always;
        add_header X-Frame-Options SAMEORIGIN always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
        add_header Cache-Control no-cache always;
        try_files \$uri /index.html;
    }"
    echo "phone app installed at https://$domain (relay $relay, nginx)"
    exit 0
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
$domain {
	root * /var/www/aelion-app
	encode zstd gzip
	header X-Content-Type-Options nosniff
	header Referrer-Policy no-referrer
	# The widget frame carries its own policy; the page's would block its inline script.
	@page not path /widget-frame.html
	header @page Content-Security-Policy "$(csp "$relay")"
	header @page X-Frame-Options SAMEORIGIN
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	@fresh not path /assets/*
	header @fresh Cache-Control "no-cache"
	try_files {path} /index.html
	file_server
}
CADDY
  systemctl enable caddy >/dev/null
  systemctl reload caddy || systemctl restart caddy
  echo "phone app installed at https://$domain (relay $relay)"
  exit 0
fi

# The relay needs Node.js 20 or newer.
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt_get install -y -q nodejs
fi

id aelion-relay >/dev/null 2>&1 || useradd --system --home-dir /opt/aelion-relay --shell /usr/sbin/nologin aelion-relay
install -d -m 0755 /opt/aelion-relay
install -m 0644 "$here/relay.cjs" /opt/aelion-relay/relay.cjs
rm -rf /opt/aelion-relay/public
cp -r "$here/public" /opt/aelion-relay/public
chown -R root:root /opt/aelion-relay

cat > /etc/systemd/system/aelion-relay.service <<UNIT
[Unit]
Description=AelionBot relay
After=network-online.target
Wants=network-online.target

[Service]
User=aelion-relay
Environment=RELAY_PORT=8790
Environment=RELAY_HOST=127.0.0.1
Environment=RELAY_TRUST_PROXY=1
Environment=RELAY_DAILY_GB=4
ExecStart=/usr/bin/node /opt/aelion-relay/relay.cjs
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable aelion-relay >/dev/null
systemctl restart aelion-relay

if [[ $owner == nginx ]]; then
  nginx_site "$domain" "    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }"
else
  cat > /etc/caddy/Caddyfile <<CADDY
$domain {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8790
}
CADDY
  systemctl enable caddy >/dev/null
  systemctl reload caddy || systemctl restart caddy
fi

# STUN only (no TURN relaying): lets phones and computers find a direct path. Data never passes through it.
if ! command -v turnserver >/dev/null; then apt_get install -y -q coturn; fi
cat > /etc/turnserver.conf <<TURN
listening-port=3478
stun-only
no-cli
no-tls
no-dtls
fingerprint
TURN
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable coturn >/dev/null
systemctl restart coturn

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
fi
sleep 1
curl -fsS http://127.0.0.1:8790/healthz && echo
echo "relay installed at https://$domain (STUN on udp/3478)"
