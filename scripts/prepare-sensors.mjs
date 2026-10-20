#!/usr/bin/env node
// Keep platform builds independent: Linux changes must not invalidate a live
// Windows adapter's build cache (Windows locks DLLs while they are loaded).
//
// The bundled sensors are optional at run time (the monitor falls back to
// the operating system's readings), so a failed download or SDK setup must
// not stop the TypeScript build, npm install or the tests. Packaging sets
// SFAGENTS_REQUIRE_SENSORS=1 to make it fatal.
try {
  if (process.platform === 'win32') await import('./build-sensors.mjs');
  else if (process.platform === 'linux') {
    const { buildLinuxSensors } = await import('./build-linux-sensors.mjs');
    const { fileURLToPath } = await import('node:url');
    await buildLinuxSensors(fileURLToPath(new URL('../', import.meta.url)));
  }
} catch (error) {
  if (process.env.SFAGENTS_REQUIRE_SENSORS === '1') throw error;
  console.warn(`warning: the bundled hardware sensors were not prepared (${error instanceof Error ? error.message : error}). The resource monitor will use the operating system's readings; run "npm run build:sensors" to try again.`);
}
