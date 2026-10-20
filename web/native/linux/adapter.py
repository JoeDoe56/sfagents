#!/usr/bin/env python3
"""SF Agents' read-only stdio adapter for the unmodified MIT-licensed collectors.

No HTTP server, installer, privilege escalation, or command execution protocol.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

spec = importlib.util.spec_from_file_location(
    "lhm_linux", Path(__file__).parent / "vendor" / "lhmlinux" / "server.py")
lhm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lhm)


def flatten(hardware):
    """Normalize upstream GiB/MiB units without its rounded display strings."""
    sensors = []
    for hw in hardware:
        for sensor in hw.sensors:
            value = sensor.value
            if value is not None:
                value = float(value)
                if not math.isfinite(value):
                    value = None
                elif sensor.type == "Data":
                    value *= 1024 ** 3
                elif sensor.type == "SmallData":
                    value *= 1024 ** 2
            sensors.append(dict(hardwareId=hw.hwid, hardware=hw.name,
                                id=sensor.sid, name=sensor.name,
                                type=sensor.type, value=value))
    return sensors


class Collector:
    def __init__(self):
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.commands = set()
        self.results = {}
        self.threads = []
        self.hint = None

    def run(self, command, timeout=20):
        # Track each command so closing SF Agents also stops a slow IPMI/SMART
        # poll. Never invoke a shell or accept commands from the stdio client.
        child = None
        try:
            with self.lock:
                if self.stop.is_set():
                    return ""
                child = subprocess.Popen(command, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True)
                self.commands.add(child)
            stdout, _ = child.communicate(timeout=timeout)
            return stdout if child.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError, UnicodeError):
            if child is not None:
                child.kill()
                child.communicate()
            return ""
        finally:
            with self.lock:
                self.commands.discard(child)

    def poll(self, source, key, interval):
        while not self.stop.is_set():
            try:
                readings = source()
            except Exception:
                readings = []
            with self.lock:
                self.results[key] = readings
            self.stop.wait(interval)

    def start(self):
        lhm.run = self.run
        tools = {name: shutil.which(name) for name in
                 ("sensors", "nvidia-smi", "ipmitool", "smartctl")}
        missing = [name for name, found in tools.items() if not found]
        if missing:
            self.hint = "Optional Linux sensor tools unavailable: " + ", ".join(missing) + ". Native readings remain enabled."
        sources = [(lhm.poll_memory, "memory", 2)]
        for source, key, tool, interval in (
                (lhm.poll_cpu, "cpu", "sensors", 2),
                (lhm.poll_gpus, "gpus", "nvidia-smi", 2),
                (lhm.poll_ipmi, "ipmi", "ipmitool", 30),
                (lhm.poll_disks, "disks", "smartctl", 300)):
            if tools[tool]:
                sources.append((source, key, interval))
        # Memory is cheap and available immediately. Slow collectors never
        # block the first response or the fast CPU/GPU loop.
        self.results["memory"] = lhm.poll_memory()
        for source, key, interval in sources:
            thread = threading.Thread(target=self.poll, args=(source, key, interval), daemon=True)
            self.threads.append(thread)
            thread.start()

    def read(self):
        with self.lock:
            hardware = [hw for source in self.results.values() for hw in source]
        try:
            processes = sum(name.isdigit() for name in os.listdir("/proc")) or None
        except OSError:
            processes = None
        return dict(sensors=flatten(hardware), processes=processes, hint=self.hint)

    def close(self):
        self.stop.set()
        with self.lock:
            for child in self.commands:
                try:
                    child.kill()
                except OSError:
                    pass
        for thread in self.threads:
            thread.join(timeout=1)


def main():
    collector = Collector()
    try:
        collector.start()
        for line in sys.stdin:
            if line.strip() != "read":
                return 2
            print(json.dumps(collector.read(), allow_nan=False), flush=True)
    finally:
        collector.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
