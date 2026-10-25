/** Bundled LibreHardwareMonitor-Linux collectors, with no listening socket. */
import { fileURLToPath } from 'node:url';
import { SensorProcessClient, type SensorProcessOptions } from './sensor-process.js';

export const LINUX_SENSORS_PYTHON = fileURLToPath(new URL(`../native/bin/linux-${process.arch}/python/bin/python3.12`, import.meta.url));

export interface LinuxSensorOptions extends Partial<Omit<SensorProcessOptions, 'name' | 'elevated'>> {
  /** Run as root through sudo, whose credentials were cached by the approval at startup (privileges.ts). */
  sudo?: boolean;
}

export class LinuxSensorClient extends SensorProcessClient {
  constructor(options: LinuxSensorOptions = {}) {
    const command = options.command ?? LINUX_SENSORS_PYTHON;
    // Isolated mode ignores Python environment injection and user site packages.
    const args = options.args ?? ['-I', '-B', '-u', fileURLToPath(new URL('../native/linux/adapter.py', import.meta.url))];
    super({
      ...options,
      name: 'Linux',
      command,
      args,
      // smartctl and ipmitool read drive temperatures and the BMC only as root.
      elevated: options.sudo ? { command: 'sudo', args: ['-n', '--', command, ...args] } : undefined,
    });
  }
}
