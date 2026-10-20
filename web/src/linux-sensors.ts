/** Bundled LibreHardwareMonitor-Linux collectors, with no listening socket. */
import { fileURLToPath } from 'node:url';
import { SensorProcessClient, type SensorProcessOptions } from './sensor-process.js';

export class LinuxSensorClient extends SensorProcessClient {
  constructor(options: Partial<Omit<SensorProcessOptions, 'name'>> = {}) {
    super({
      ...options,
      name: 'Linux',
      command: options.command ?? fileURLToPath(new URL(`../native/bin/linux-${process.arch}/python/bin/python3.12`, import.meta.url)),
      // Isolated mode ignores Python environment injection and user site packages.
      args: options.args ?? ['-I', '-B', '-u', fileURLToPath(new URL('../native/linux/adapter.py', import.meta.url))],
    });
  }
}
