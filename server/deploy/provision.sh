#!/usr/bin/env bash
# One-time Droplet setup (Ubuntu 24.04, run as root). Idempotent. See docs/ops.md §1.
set -euo pipefail

# 2 GB swap (PLAN §8: worker jobs must fit in 4 GB RAM)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf

# Docker Engine + compose plugin
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Firewall: SSH + HTTP/HTTPS only (Caddy is the only published container)
apt-get install -y ufw git
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Unattended security updates
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "provisioned: $(swapon --show --noheadings) | $(docker --version)"
