/** Bundled Windows LibreHardwareMonitor library adapter. */
import { fileURLToPath } from 'node:url';
import { SensorProcessClient, type SensorProcessOptions } from './sensor-process.js';
export { sensorEnvironment } from './sensor-process.js';

export interface WindowsSensorOptions extends Partial<Omit<SensorProcessOptions, 'name' | 'elevated'>> {
  /**
   * The elevated worker's pipe, from the administrator approval asked for at
   * startup (privileges.ts): this process brokers between SF Agents and the
   * worker the approval started.
   */
  elevated?: { pipe: string; approved: Promise<boolean> };
}

export const WINDOWS_SENSORS_EXE = fileURLToPath(new URL(`../native/bin/win-${process.arch}/SfAgents.Sensors.exe`, import.meta.url));

export class WindowsSensorClient extends SensorProcessClient {
  constructor(options: WindowsSensorOptions = {}) {
    const command = options.command ?? WINDOWS_SENSORS_EXE;
    super({
      ...options,
      name: 'Windows',
      command,
      args: options.args ?? [],
      timeoutMs: options.timeoutMs ?? 20_000,
      // The first reading waits for the approval and the worker to connect.
      elevated: options.elevated && { command, args: ['--broker', options.elevated.pipe], timeoutMs: 120_000, approved: options.elevated.approved },
    });
  }
}
