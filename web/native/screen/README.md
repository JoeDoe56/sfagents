# sfagents-screen

SF Agents' screen mirroring helper: the Remote Desktop sheet's stream of this
computer's screen, picture, sound and input, over WebRTC.

It is built from [MoonlightWeb](https://github.com/linckosz/moonlight-web)
(GPL-3.0-or-later, Copyright (C) 2026 Bruno Martin) at the commit in
`UPSTREAM.json`: its capture and encoding engine (`moonlight-web/backend/native-host`,
unchanged) and the parts of its stream worker that carry one stream of this
computer (`moonlight-web/backend/src`, the files in `sources.cmake`). What
MoonlightWeb does beyond that is not here: finding, pairing with and streaming
from other hosts (GameStream, Sunshine, Wolf, MultiSeat), the host list, the
sharing board, internet access, the updater, the tray, its HTTP server and its
installer. SF Agents' own server takes their place for one stream at a time
(`web/src/screen.ts`).

`src/ScreenMain.cpp` is derived from MoonlightWeb's
`backend/src/streaming/worker/StreamWorkerMain.cpp`; the files under
`moonlight-web/` that SF Agents changed are listed in `UPSTREAM.json`.

Build: `node scripts/build-screen.mjs` (CMake, a C++17 compiler, Qt 6 Core,
Gui, Network and WebSockets, OpenSSL). Releases are built by
`.github/workflows/screen.yml`, and SF Agents downloads them.
