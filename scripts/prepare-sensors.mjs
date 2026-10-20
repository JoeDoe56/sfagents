#!/usr/bin/env node
// Keep platform builds independent: Linux changes must not invalidate a live
// Windows adapter's build cache (Windows locks DLLs while they are loaded).
if (process.platform === 'win32') await import('./build-sensors.mjs');
else if (process.platform === 'linux') {
  const { buildLinuxSensors } = await import('./build-linux-sensors.mjs');
  const { fileURLToPath } = await import('node:url');
  await buildLinuxSensors(fileURLToPath(new URL('../', import.meta.url)));
}
