# The root filesystem of SF Agents' WSL2 distro "sfagents" (Windows only):
# Debian 13 with Docker Engine, set up so it can't reach Windows beyond the
# folders SF Agents mounts for agents. CI exports it as a tar for
# `wsl --import` (see .github/workflows/agent-image.yml and
# core/src/container/wsl.ts).

FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg systemd systemd-sysv dbus iproute2 procps util-linux \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io \
 && rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN chmod 755 /usr/local/sbin/sfagents-isolate

# SF Agents' own CLI path, so Docker Desktop's WSL integration (which can
# replace /usr/bin/docker) never changes which engine SF Agents talks to.
# The packaged docker.service listens on the usual socket; SF Agents' engine
# (sfagents-docker.service) uses its own socket, data folder and no bridge
# network or iptables rules at all: agent containers have no network.
RUN install -d /opt/sfagents/bin \
 && cp /usr/bin/docker /opt/sfagents/bin/docker \
 && systemctl mask docker.service docker.socket \
 && systemctl enable sfagents-isolate.service sfagents-docker.service containerd.service \
 && { systemctl mask systemd-resolved.service systemd-networkd.service getty@tty1.service 2>/dev/null || true; } \
 && install -d -o 1000 -g 1000 /srv/sfagents/workspaces \
 && install -d /mnt/sfa-roots \
 && echo "sfagents" > /etc/hostname
