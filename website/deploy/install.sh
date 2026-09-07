#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
test "$#" = 2
public_key=$1
receiver=$2
site=/var/www/aelion.chat
deploy_user=aelion-deploy
deploy_home=/var/lib/aelion-deploy

test "$(readlink -f "$site")" = "$site"
test "$(readlink -f "$site/releases")" = "$site/releases"
test -L "$site/current"
test -s "$site/current/index.html"
command -v python3 >/dev/null
command -v curl >/dev/null
ssh-keygen -l -f "$public_key" >/dev/null
IFS=' ' read -r key_type key_value _ < "$public_key"
[[ "$key_type" == ssh-ed25519 && "$key_value" =~ ^[A-Za-z0-9+/=]+$ ]]

if ! id "$deploy_user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$deploy_home" --shell /bin/sh "$deploy_user"
fi
test "$(getent passwd "$deploy_user" | cut -d: -f6)" = "$deploy_home"
test "$(id -Gn "$deploy_user")" = "$deploy_user"
install -d -o root -g root -m 0755 "$deploy_home" "$deploy_home/.ssh" /usr/local/libexec
install -o root -g root -m 0755 "$receiver" /usr/local/libexec/aelion-website-deploy
# Root owns the account home and forced-command key, so deployments cannot replace them.
printf 'restrict,command="/usr/local/libexec/aelion-website-deploy" %s %s aelion-website-actions\n' "$key_type" "$key_value" > "$deploy_home/.ssh/authorized_keys"
chown root:root "$deploy_home/.ssh/authorized_keys"
chmod 0644 "$deploy_home/.ssh/authorized_keys"
install -d -o "$deploy_user" -g "$deploy_user" -m 0755 "$site" "$site/releases"
install -d -o "$deploy_user" -g "$deploy_user" -m 0700 "$site/.incoming"
sudo -u "$deploy_user" test -r "$site/current/index.html"
nginx -t
printf 'Website deployment account installed. Current release: %s\n' "$(readlink -f "$site/current")"
