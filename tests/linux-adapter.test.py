"""Adapter tests without requiring physical sensors or root."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[1] / "web/native/linux/adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def test_preserves_precision_and_normalizes_memory(self):
        memory = adapter.lhm.Hardware("Memory", "/ram")
        memory.add("Memory Used", "Data", 1.23456789, 0)
        gpu = adapter.lhm.Hardware("GPU", "/gpu-nvidia/0")
        gpu.add("GPU Memory Used", "SmallData", 1234.5, 0)
        gpu.add("GPU Core", "Temperature", float("nan"), 0)
        values = adapter.flatten([memory, gpu])
        self.assertEqual(values[0]["value"], 1.23456789 * 1024 ** 3)
        self.assertEqual(values[1]["value"], 1234.5 * 1024 ** 2)
        self.assertIsNone(values[2]["value"])

    def test_closing_kills_an_inflight_sensor_command(self):
        collector = adapter.Collector()
        worker = threading.Thread(target=collector.run, args=([sys.executable, "-c", "import time; time.sleep(60)"],))
        worker.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with collector.lock:
                if collector.commands:
                    child = next(iter(collector.commands))
                    break
            time.sleep(0.01)
        else:
            self.fail("Sensor subprocess did not start")
        collector.close()
        worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertIsNotNone(child.poll())

    def test_stdio_starts_without_a_server_and_closes_on_eof(self):
        child = subprocess.Popen([sys.executable, "-I", "-B", "-u", str(Path(adapter.__file__))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            stdout, stderr = child.communicate("read\n", timeout=15)
            self.assertEqual(child.returncode, 0, stderr)
            import json
            reading = json.loads(stdout)
            self.assertIn("sensors", reading)
            if sys.platform == "linux":
                self.assertTrue(any(s["hardwareId"] == "/ram" for s in reading["sensors"]))
                self.assertGreater(reading["processes"], 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()


if __name__ == "__main__":
    unittest.main()
