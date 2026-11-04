# syntax=docker/dockerfile:1.7
#
# sfagents-agent: the one image every SF Agents agent container runs.
# Debian 13 (trixie), amd64. Built and published to
# ghcr.io/joedoe56/sfagents-agent by .github/workflows/agent-image.yml.
#
# Each language gets its own layer so no layer comes near GHCR's 10 GB limit
# and a change to one toolchain rebuilds only what follows it. Versions marked
# "latest" are resolved at build time and recorded in
# /etc/sfagents/image-versions; the smoke test prints that file.
#
# Network: agents reach the internet only through SF Agents' proxy container,
# which every agent container sees as sfa-proxy:3128. The proxy settings for
# tools that ignore HTTP(S)_PROXY are written in the last layers, so the build
# itself downloads directly.

FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
ARG DOTNET_CHANNEL=10.0
ARG JAVA_MAJOR=21

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DISPLAY=:99 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/sfa-desktop-bus \
    NO_AT_BRIDGE=0 \
    ACCESSIBILITY_ENABLED=1 \
    QT_ACCESSIBILITY=1 \
    GTK_MODULES=gail:atk-bridge \
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC

# --- Base system, C/C++, Python, Ruby, PHP, Lua, media and everyday tools ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg dirmngr apt-transport-https \
      sudo locales tzdata procps psmisc less nano vim-tiny file tree time \
      bash-completion openssh-client iputils-ping dnsutils netcat-openbsd \
      git git-lfs jq ripgrep fd-find zip unzip xz-utils zstd bzip2 p7zip-full \
      sqlite3 openssl shellcheck patch rsync tini \
      build-essential gcc g++ clang lld llvm cmake ninja-build make gdb \
      pkg-config autoconf automake libtool \
      mingw-w64 \
      libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev \
      liblzma-dev libreadline-dev libncurses-dev libxml2-dev libyaml-dev \
      python3 python3-dev python3-venv python3-pip pipx \
      ruby-full ruby-bundler \
      php-cli php-curl php-mbstring php-xml php-zip php-sqlite3 php-intl composer \
      lua5.4 liblua5.4-dev luarocks \
      ffmpeg imagemagick poppler-utils ghostscript \
      xvfb xauth dbus-x11 at-spi2-core python3-pyatspi python3-gi gir1.2-gtk-3.0 openbox x11-utils xdotool xterm mousepad libatk-bridge2.0-0 gsettings-desktop-schemas fonts-dejavu fonts-liberation fonts-noto-color-emoji \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# --- Documents: Pandoc and TeX Live ---------------------------------------
# Debian has no "medium" scheme package; these collections cover what TeX
# Live's medium scheme does (LaTeX, common packages and fonts, XeLaTeX and
# LuaLaTeX for Pandoc's PDF output).
RUN apt-get update && apt-get install -y --no-install-recommends \
      pandoc \
      texlive-base texlive-latex-base texlive-latex-recommended \
      texlive-latex-extra texlive-fonts-recommended \
      texlive-xetex texlive-luatex texlive-pictures texlive-science \
      texlive-bibtex-extra biber latexmk lmodern \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/texlive* /usr/share/texlive/texmf-dist/doc

# --- Java: OpenJDK, Maven, Gradle ------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-${JAVA_MAJOR}-jdk-headless \
 && rm -rf /var/lib/apt/lists/* \
 && MAVEN_VERSION="$(curl -fsSL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml \
      | grep -oP '<version>\K3\.[0-9]+\.[0-9]+(?=</version>)' | sort -V | tail -1)" \
 && curl -fsSL "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN_VERSION}/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
      | tar -xz -C /opt \
 && mv "/opt/apache-maven-${MAVEN_VERSION}" /opt/maven \
 && GRADLE_VERSION="$(curl -fsSL https://services.gradle.org/versions/current | jq -r .version)" \
 && curl -fsSLo /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
 && unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip \
 && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
 && ln -s /opt/maven/bin/mvn /usr/local/bin/mvn \
 && ln -s /opt/gradle/bin/gradle /usr/local/bin/gradle \
 && mkdir -p /etc/sfagents \
 && { echo "maven=${MAVEN_VERSION}"; echo "gradle=${GRADLE_VERSION}"; } >> /etc/sfagents/image-versions

# --- Node.js, npm, Corepack (pnpm, Yarn), TypeScript, tsx, Prettier --------
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json \
      | jq -r --arg m "v${NODE_MAJOR}." '[.[] | select(.version | startswith($m))][0].version')" \
 && curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate \
 && npm install -g --no-fund --no-audit typescript tsx prettier serve \
 && npm cache clean --force \
 && echo "node=${NODE_VERSION}" >> /etc/sfagents/image-versions

# --- Bun and Deno ----------------------------------------------------------
RUN BUN_TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/oven-sh/bun/releases/latest | sed 's#.*/tag/##')" \
 && curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/${BUN_TAG}/bun-linux-x64.zip" \
 && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
 && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
 && DENO_TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/denoland/deno/releases/latest | sed 's#.*/tag/##')" \
 && curl -fsSLo /tmp/deno.zip "https://github.com/denoland/deno/releases/download/${DENO_TAG}/deno-x86_64-unknown-linux-gnu.zip" \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip \
 && { echo "bun=${BUN_TAG}"; echo "deno=${DENO_TAG}"; } >> /etc/sfagents/image-versions

# --- Python: uv ------------------------------------------------------------
RUN UV_TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/astral-sh/uv/releases/latest | sed 's#.*/tag/##')" \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_TAG}/uv-x86_64-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 \
 && echo "uv=${UV_TAG}" >> /etc/sfagents/image-versions

# --- Rust: rustup stable, clippy, rustfmt, Windows GNU target --------------
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo
RUN curl -fsSLo /tmp/rustup-init https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable \
      --component clippy,rustfmt --target x86_64-pc-windows-gnu \
 && rm /tmp/rustup-init \
 && echo "rust=$(/opt/cargo/bin/rustc --version | cut -d' ' -f2)" >> /etc/sfagents/image-versions

# --- Go --------------------------------------------------------------------
RUN GO_VERSION="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)" \
 && curl -fsSL "https://dl.google.com/go/${GO_VERSION}.linux-amd64.tar.gz" | tar -xz -C /usr/local \
 && ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/ \
 && echo "go=${GO_VERSION}" >> /etc/sfagents/image-versions

# --- .NET SDK --------------------------------------------------------------
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
RUN apt-get update && apt-get install -y --no-install-recommends libicu76 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSLo /tmp/dotnet-install.sh https://builds.dotnet.microsoft.com/dotnet/scripts/v1/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir /usr/share/dotnet \
 && rm /tmp/dotnet-install.sh \
 && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && echo "dotnet=$(/usr/share/dotnet/dotnet --version)" >> /etc/sfagents/image-versions

# --- PowerShell 7 ----------------------------------------------------------
RUN PWSH_TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/PowerShell/PowerShell/releases/latest | sed 's#.*/tag/##')" \
 && mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/${PWSH_TAG}/powershell-${PWSH_TAG#v}-linux-x64.tar.gz" \
      | tar -xz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
 && echo "pwsh=${PWSH_TAG}" >> /etc/sfagents/image-versions

# --- Playwright with headless Chromium -------------------------------------
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g --no-fund --no-audit playwright \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /opt/ms-playwright \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
 && echo "playwright=$(playwright --version | awk '{print $2}')" >> /etc/sfagents/image-versions

# --- Wine (WineHQ stable, 64- and 32-bit), winetricks ---------------------
RUN dpkg --add-architecture i386 \
 && mkdir -pm755 /etc/apt/keyrings \
 && curl -fsSL https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key \
 && curl -fsSLo /etc/apt/sources.list.d/winehq-trixie.sources https://dl.winehq.org/wine-builds/debian/dists/trixie/winehq-trixie.sources \
 && apt-get update && apt-get install -y --install-recommends winehq-stable \
 && apt-get install -y --no-install-recommends cabextract \
 && curl -fsSLo /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
 && chmod +x /usr/local/bin/winetricks \
 && rm -rf /var/lib/apt/lists/* \
 && echo "wine=$(wine --version)" >> /etc/sfagents/image-versions

# --- The agent user, shared caches, proxy settings -------------------------
# Caches live under /cache, one folder per tool; SF Agents mounts one shared
# volume there for every agent. A tool whose cache sits in the home folder
# (Maven, Gradle) gets a link into /cache instead.
ENV CACHE_ROOT=/cache \
    npm_config_cache=/cache/npm \
    npm_config_update_notifier=false \
    PNPM_HOME=/home/agent/.local/share/pnpm \
    PNPM_STORE_DIR=/cache/pnpm \
    YARN_CACHE_FOLDER=/cache/yarn \
    YARN_GLOBAL_FOLDER=/cache/yarn-berry \
    BUN_INSTALL_CACHE_DIR=/cache/bun \
    DENO_DIR=/cache/deno \
    UV_CACHE_DIR=/cache/uv \
    PIP_CACHE_DIR=/cache/pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    GOPATH=/home/agent/go \
    GOMODCACHE=/cache/go/mod \
    GOCACHE=/cache/go/build \
    GOTOOLCHAIN=local \
    NUGET_PACKAGES=/cache/nuget \
    COMPOSER_CACHE_DIR=/cache/composer \
    GEM_SPEC_CACHE=/cache/gem/specs \
    WINEPREFIX=/home/agent/.wine \
    WINEDEBUG=-all \
    JAVA_HOME=/usr/lib/jvm/java-${JAVA_MAJOR}-openjdk-amd64

# A new Wine prefix otherwise stops at a dialog offering Wine Mono and Gecko,
# which nobody can click in a headless container.
ENV WINEDLLOVERRIDES=mscoree,mshtml=

COPY rootfs/ /

RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && chmod 0440 /etc/sudoers.d/sfagents \
 && visudo -cf /etc/sudoers.d/sfagents \
 && mkdir -p /cache /workspaces /roots \
 && for d in npm pnpm yarn yarn-berry bun deno uv pip go/mod go/build nuget \
             composer gem maven gradle cargo/registry cargo/git; do mkdir -p "/cache/$d"; done \
 && rm -rf /opt/cargo/registry /opt/cargo/git \
 && ln -s /cache/cargo/registry /opt/cargo/registry \
 && ln -s /cache/cargo/git /opt/cargo/git \
 && mkdir -p /home/agent/.m2 /home/agent/.gradle /home/agent/.local/bin /home/agent/go \
 && ln -s /cache/maven /home/agent/.m2/repository \
 && ln -s /cache/gradle /home/agent/.gradle/caches \
 && cp /etc/sfagents/skel/m2-settings.xml /home/agent/.m2/settings.xml \
 && cp /etc/sfagents/skel/gradle.properties /home/agent/.gradle/gradle.properties \
 && cat /etc/sfagents/skel/java-net.properties >> "${JAVA_HOME}/conf/net.properties" \
 && cp /etc/sfagents/skel/m2-settings.xml /opt/maven/conf/settings.xml \
 && chmod -R a+rwX /opt/corepack \
 && chown -R agent:agent /cache /workspaces /home/agent /opt/cargo /opt/rustup \
 && sort -o /etc/sfagents/image-versions /etc/sfagents/image-versions

# Set last, so the build above downloads directly. The names are lower and
# upper case because tools disagree on which they read.
ENV HTTP_PROXY=http://sfa-proxy:3128 \
    HTTPS_PROXY=http://sfa-proxy:3128 \
    http_proxy=http://sfa-proxy:3128 \
    https_proxy=http://sfa-proxy:3128 \
    NO_PROXY=localhost,127.0.0.1,::1 \
    no_proxy=localhost,127.0.0.1,::1 \
    YARN_HTTP_PROXY=http://sfa-proxy:3128 \
    YARN_HTTPS_PROXY=http://sfa-proxy:3128 \
    npm_config_prefix=/home/agent/.local \
    PATH=/run/sfa/bin:/home/agent/.local/bin:/home/agent/.local/share/pnpm:/home/agent/go/bin:/opt/cargo/bin:/home/agent/.dotnet/tools:/usr/local/go/bin:/opt/gradle/bin:/opt/maven/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER agent
WORKDIR /workspaces

LABEL org.opencontainers.image.title="sfagents-agent" \
      org.opencontainers.image.description="The container every SF Agents agent runs its commands in" \
      org.opencontainers.image.source="https://github.com/JoeDoe56/sfagents" \
      org.opencontainers.image.licenses="GPL-3.0"

# The agent container stays up and SF Agents runs commands in it with
# docker exec. tini reaps the zombies that background jobs leave behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
