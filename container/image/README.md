# sfagents-agent image

Every SF Agents agent runs its commands in a container made from this image:
Debian 13 (trixie), amd64, published as `ghcr.io/joedoe56/sfagents-agent` by
`.github/workflows/agent-image.yml`.

It has Python (uv, pipx), Node.js 24 (npm, pnpm, Yarn, TypeScript, tsx,
Prettier), Bun, Deno, Playwright with Chromium, Rust (with the Windows GNU
target), GCC/Clang/CMake/Ninja/MinGW-w64, Go, .NET 10, Java 21 with Maven and
Gradle, PowerShell 7, Ruby, PHP with Composer, Lua with LuaRocks, Pandoc with
TeX Live, Wine with winetricks, and ffmpeg, ImageMagick and poppler for
`sfa-view`. `/etc/sfagents/image-versions` lists the exact versions.

Layout inside the container:

| Path | What |
| --- | --- |
| `/workspaces` | Shared volume with every agent's worktrees |
| `/cache` | Shared volume with the package caches (npm, pnpm, Yarn, Bun, Deno, uv, pip, Go, NuGet, Composer, Maven, Gradle, Cargo) |
| `/home/agent` | Per-agent volume: home folder and Wine prefix |
| `/roots/<name>` | The person's project folders, read-only |

The agent runs as `agent` (uid 1000) with passwordless sudo inside its
container. All network traffic goes through SF Agents' proxy at
`sfa-proxy:3128`; the image also sets it for the tools that ignore
`HTTP(S)_PROXY` (apt under sudo, Java, Maven, Gradle, Yarn), and rewrites SSH
git remotes to HTTPS.

Build and test locally:

```sh
docker build -t sfagents-agent container/image
docker run --rm -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= \
  -e YARN_HTTP_PROXY= -e YARN_HTTPS_PROXY= \
  -v "$PWD/container/image/smoke-test.sh:/smoke-test.sh:ro" \
  sfagents-agent bash -l /smoke-test.sh
```
