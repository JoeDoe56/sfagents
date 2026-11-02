#!/usr/bin/env bash
# Smoke test for the sfagents-agent image. Every language compiles and runs a
# small program, Wine runs Windows programs built in the image, and the media
# and browser tools produce real output. Nothing here downloads packages, so it
# also proves the toolchains work offline.
#
#   docker run --rm -v "$PWD/container/image/smoke-test.sh:/smoke-test.sh:ro" \
#     ghcr.io/joedoe56/sfagents-agent bash -l /smoke-test.sh
#
# Exits non-zero if any check fails, after running all of them.

set -u
work="$(mktemp -d)"
cd "$work" || exit 1
passed=0
failed=()

check() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    passed=$((passed + 1))
    printf 'ok    %-22s %s\n' "$name" "$(printf '%s' "$out" | tail -n 1 | cut -c1-90)"
  else
    failed+=("$name")
    printf 'FAIL  %s\n' "$name"
    printf '%s\n' "$out" | tail -n 25 | sed 's/^/      /'
  fi
}

# Bodies of the checks. Each prints something that shows it really ran.

t_python() {
  python3 -c 'import sys, sqlite3, ssl, venv; print(sys.version.split()[0])' &&
  uv --version && pipx --version >/dev/null &&
  uv venv -q venv && venv/bin/python -c 'print("venv ok")'
}
t_node() {
  node -e 'console.log(process.version)' && npm --version >/dev/null &&
  pnpm --version >/dev/null && yarn --version >/dev/null &&
  printf 'const n: number = 6 * 7;\nconsole.log(`ts ${n}`);\n' > hello.ts &&
  tsc --strict --outDir tsout hello.ts && node tsout/hello.js && tsx hello.ts &&
  prettier hello.ts >/dev/null
}
t_bun() { bun -e 'console.log("bun " + Bun.version)' && bun run hello.ts; }
t_deno() { deno eval 'console.log("deno " + Deno.version.deno)' && deno run hello.ts; }
t_playwright() {
  cat > pw.cjs <<'EOF'
const { chromium } = require(process.env.PW_MODULE);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<h1 style="font-family:sans-serif">sfagents</h1>');
  await page.screenshot({ path: 'pw.png' });
  console.log('chromium ' + browser.version() + ', heading: ' + await page.textContent('h1'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
EOF
  PW_MODULE="$(npm root -g --prefix /usr/local)/playwright" node pw.cjs && test -s pw.png
}
t_c() {
  printf '#include <stdio.h>\nint main(void){puts("c ok");return 0;}\n' > hello.c &&
  gcc -O2 -o hello-gcc hello.c && ./hello-gcc &&
  clang -fuse-ld=lld -o hello-clang hello.c && ./hello-clang &&
  printf '#include <iostream>\nint main(){std::cout<<"c++ ok\\n";}\n' > hello.cpp &&
  g++ -std=c++20 -o hello-cpp hello.cpp && ./hello-cpp &&
  mkdir -p cm && printf 'cmake_minimum_required(VERSION 3.20)\nproject(h C)\nadd_executable(h ../hello.c)\n' > cm/CMakeLists.txt &&
  cmake -S cm -B cm/build -G Ninja >/dev/null && cmake --build cm/build >/dev/null && cm/build/h &&
  gdb --version | head -1
}
t_mingw() { x86_64-w64-mingw32-gcc -O2 -o hello.exe hello.c && file hello.exe; }
t_rust() {
  cargo new -q --vcs none rs && cd rs &&
  cargo build -q --offline && ./target/debug/rs &&
  cargo clippy -q --offline && cargo fmt --check &&
  cargo build -q --offline --target x86_64-pc-windows-gnu &&
  file target/x86_64-pc-windows-gnu/debug/rs.exe
}
t_go() {
  mkdir -p gomod && cd gomod && go mod init example.com/h >/dev/null 2>&1 &&
  printf 'package main\nimport "fmt"\nfunc main(){fmt.Println("go ok")}\n' > main.go &&
  go build -o h . && ./h && GOOS=windows go build -o h.exe . && file h.exe
}
t_dotnet() {
  dotnet new console -o cs --no-restore >/dev/null && cd cs &&
  dotnet run 2>&1 | tail -n 1
}
t_java() {
  printf 'public class Hello { public static void main(String[] a){ System.out.println("java " + Runtime.version()); } }\n' > Hello.java &&
  javac Hello.java && java Hello && mvn -v | head -1 && gradle --version --quiet | grep -m1 Gradle
}
t_pwsh() { pwsh -NoProfile -Command '"pwsh " + $PSVersionTable.PSVersion.ToString()'; }
t_ruby() { ruby -e 'puts "ruby #{RUBY_VERSION}"' && gem --version >/dev/null && bundle --version; }
t_php() { php -r 'echo "php ", PHP_VERSION, "\n";' && composer --version 2>/dev/null | head -1; }
t_lua() { lua5.4 -e 'print("lua " .. _VERSION)' && luarocks --version | head -1; }
t_pandoc() {
  printf '# Hello\n\nSome *text* and $x^2$.\n' > doc.md &&
  pandoc doc.md -o doc.pdf --pdf-engine=xelatex && test -s doc.pdf &&
  pandoc doc.md -o doc.pdf --pdf-engine=lualatex && test -s doc.pdf &&
  pdftoppm -png -r 50 -f 1 -l 1 doc.pdf page && ls page*.png
}
t_media() {
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=10 \
    -f lavfi -i sine=duration=2 -shortest -pix_fmt yuv420p clip.mp4 &&
  ffprobe -v error -show_entries format=duration -of csv=p=0 clip.mp4 &&
  ffmpeg -hide_banner -loglevel error -i clip.mp4 -vf fps=2,tile=2x2 -frames:v 1 sheet.png || return 1
  if command -v magick >/dev/null; then magick sheet.png -resize 50% small.png
  else convert sheet.png -resize 50% small.png; fi || return 1
  identify small.png
}
t_wine() {
  # One virtual display for the whole check. wineboot creates the prefix
  # first, which takes a while; then each program has a minute.
  xvfb-run -a bash -c '
    timeout 300 wineboot -i >/dev/null 2>&1 || { echo "wineboot failed or timed out"; exit 1; }
    for exe in hello.exe rs/target/x86_64-pc-windows-gnu/debug/rs.exe gomod/h.exe; do
      timeout 60 wine "$exe" 2>/dev/null || { echo "$exe failed or timed out"; exit 1; }
    done
    wineserver -k' > wine.out 2>&1
  local rc=$?
  tr -d '\r' < wine.out > wine.txt
  cat wine.txt
  [ "$rc" -eq 0 ] && grep -q '^c ok$' wine.txt && grep -q '^Hello, world!$' wine.txt &&
    grep -q '^go ok$' wine.txt && echo "3 Windows programs ran"
}
t_tools() {
  git --version && git lfs version >/dev/null && rg --version >/dev/null && fd --version >/dev/null &&
  jq --version >/dev/null && sqlite3 --version >/dev/null && shellcheck --version >/dev/null &&
  zip -v >/dev/null && unzip -v >/dev/null && xz --version >/dev/null && openssl version
}
t_user() {
  test "$(id -un)" = agent && test "$(id -u)" = 1000 && sudo -n true &&
  touch /workspaces/.w /cache/npm/.w && rm /workspaces/.w /cache/npm/.w &&
  git config --system --get-all url.https://github.com/.insteadof | grep -q 'git@github.com:' &&
  grep -q sfa-proxy /etc/apt/apt.conf.d/90sfagents-proxy &&
  grep -q sfa-proxy "$JAVA_HOME/conf/net.properties" &&
  echo "agent with sudo, caches writable, proxy settings in place"
}

echo "sfagents-agent smoke test"
echo "--- image versions"
cat /etc/sfagents/image-versions
echo "---"

check user/config   t_user
check python        t_python
check node/ts       t_node
check bun           t_bun
check deno          t_deno
check c/c++/cmake   t_c
check mingw         t_mingw
check rust          t_rust
check go            t_go
check dotnet        t_dotnet
check java          t_java
check powershell    t_pwsh
check ruby          t_ruby
check php           t_php
check lua           t_lua
check pandoc/tex    t_pandoc
check ffmpeg/magick t_media
check playwright    t_playwright
check wine          t_wine
check tools         t_tools

echo "---"
echo "$passed passed, ${#failed[@]} failed${failed[*]:+: ${failed[*]}}"
[ "${#failed[@]}" -eq 0 ]
