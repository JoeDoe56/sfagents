/** Bundled Windows LibreHardwareMonitor library adapter. */
import { fileURLToPath } from 'node:url';
import { SensorProcessClient, type SensorProcessOptions } from './sensor-process.js';
export { sensorEnvironment } from './sensor-process.js';

export interface WindowsSensorOptions extends Partial<Omit<SensorProcessOptions, 'name'>> {
  elevate?: boolean;
}

export class WindowsSensorClient extends SensorProcessClient {
  constructor(options: WindowsSensorOptions = {}) {
    super({
      ...options,
      name: 'Windows',
      command: options.command ?? fileURLToPath(new URL(`../native/bin/win-${process.arch}/SfAgents.Sensors.exe`, import.meta.url)),
      args: options.args ?? (options.elevate ? ['--elevate'] : []),
      timeoutMs: options.timeoutMs ?? (options.elevate ? 100_000 : 20_000),
    });
  }
}
