#!/usr/bin/env python3
"""Protocol conformance tests for lhm-linux.

These validate the JSON tree against the LibreHardwareMonitor schema documented
in the README. They run without special hardware or privileges: sensor sources
that are unavailable simply yield nothing, and a synthetic fixture guarantees
the tree-building code is always exercised.

Run with:  python3 tests/test_protocol.py
"""

import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lhmlinux"))

import server


def build_fixture():
    """A synthetic hardware set covering every code path in the tree builder."""
    gpu = server.Hardware("NVIDIA Test GPU", "/gpu-nvidia/0", "nvidia.png")
    gpu.add("GPU Core", "Temperature", 63.0, 0)
    gpu.add("GPU Core", "Load", 0.0, 0)
    gpu.add("GPU Package", "Power", 21.37, 0)
    gpu.add("GPU Core", "Clock", 1770.0, 0)
    gpu.add("GPU Fan", "Control", 42.5, 0)
    # Data and SmallData must collapse into a single "Data" node.
    gpu.add("GPU Memory Used", "SmallData", 14900.0, 0)
    gpu.add("GPU Memory", "Data", 14.55, 0)

    board = server.Hardware("Mainboard (BMC)", "/lpc/bmc", "mainboard.png")
    board.add("CPU1", "Temperature", 44.0, 0)
    board.add("FAN2", "Fan", 4800.0, 0)
    board.add("12V", "Voltage", 11.81, 0)
    board.add("System Total", "Power", 320.0, 0)
    board.add("Missing Sensor", "Temperature", None, 1)   # no reading

    return [gpu, board]


def install_fixture():
    """Publish the fixture the way the pollers do, one entry per source."""
    gpu, board = build_fixture()
    with server._lock:
        server._results.clear()
        server._results["gpus"] = [gpu]
        server._results["ipmi"] = [board]
        server._minmax.clear()
        for hw in (gpu, board):
            for sensor in hw.sensors:
                if sensor.value is not None:
                    server._minmax[sensor.sid] = [sensor.value - 1.0,
                                                  sensor.value + 1.0]
    return [gpu, board]


def iter_sensors(node, out=None):
    out = [] if out is None else out
    if "SensorId" in node:
        out.append(node)
    for child in node.get("Children", []):
        iter_sensors(child, out)
    return out


def iter_all(node, out=None):
    out = [] if out is None else out
    out.append(node)
    for child in node.get("Children", []):
        iter_all(child, out)
    return out


class TestTreeShape(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.CONFIG["hostname"] = "testhost"
        server.CONFIG["decimal_comma"] = True
        install_fixture()
        cls.tree = server.build_data_json()

    def test_root_node(self):
        root = self.tree
        self.assertEqual(root["Text"], "Sensor")
        self.assertEqual(root["Min"], "Min")
        self.assertEqual(root["Value"], "Value")
        self.assertEqual(root["Max"], "Max")
        self.assertEqual(root["ImageURL"], "")
        self.assertEqual(root["id"], 0)
        self.assertIn("Version", root)
        self.assertEqual(len(root["Children"]), 1)

    def test_computer_node(self):
        computer = self.tree["Children"][0]
        self.assertEqual(computer["Text"], "testhost")
        self.assertEqual(computer["ImageURL"], "images_icon/computer.png")
        for field in ("Min", "Value", "Max"):
            self.assertEqual(computer[field], "")

    def test_hardware_nodes_have_hardware_id(self):
        for hw in self.tree["Children"][0]["Children"]:
            self.assertIn("HardwareId", hw)
            self.assertTrue(hw["HardwareId"].startswith("/"))
            self.assertTrue(hw["ImageURL"].startswith("images_icon/"))

    def test_ids_are_unique_preorder(self):
        ids = [n["id"] for n in iter_all(self.tree)]
        self.assertEqual(ids, sorted(ids), "ids must ascend in pre-order")
        self.assertEqual(len(ids), len(set(ids)), "ids must be unique")
        self.assertEqual(ids[0], 0)

    def test_every_node_serialises(self):
        json.dumps(self.tree)   # must not raise

    def test_leaf_nodes_carry_empty_children(self):
        for sensor in iter_sensors(self.tree):
            self.assertEqual(sensor["Children"], [])


class TestSensorFields(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.CONFIG["hostname"] = "testhost"
        server.CONFIG["decimal_comma"] = True
        install_fixture()
        cls.sensors = iter_sensors(server.build_data_json())

    def test_required_fields_present(self):
        required = {"id", "Text", "Min", "Value", "Max", "SensorId", "Type",
                    "RawMin", "RawValue", "RawMax", "ImageURL", "Children"}
        for sensor in self.sensors:
            self.assertTrue(required.issubset(sensor.keys()),
                            f"missing {required - sensor.keys()}")

    def test_raw_fields_are_strings(self):
        """Upstream emits formatted strings despite the "Raw" prefix."""
        for sensor in self.sensors:
            for field in ("RawMin", "RawValue", "RawMax"):
                self.assertIsInstance(sensor[field], str,
                                      f"{sensor['SensorId']}.{field}")

    def test_raw_matches_formatted(self):
        for sensor in self.sensors:
            self.assertEqual(sensor["RawValue"], sensor["Value"])
            self.assertEqual(sensor["RawMin"], sensor["Min"])
            self.assertEqual(sensor["RawMax"], sensor["Max"])

    def test_sensor_id_convention(self):
        pattern = re.compile(r"^(/[a-z0-9-]+)+/[a-z]+/\d+$")
        for sensor in self.sensors:
            self.assertRegex(sensor["SensorId"], pattern)

    def test_type_is_known(self):
        for sensor in self.sensors:
            self.assertIn(sensor["Type"], server.FORMATS)

    def test_image_url(self):
        for sensor in self.sensors:
            self.assertEqual(sensor["ImageURL"], "images/transparent.png")


class TestGroupNodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.CONFIG["hostname"] = "testhost"
        install_fixture()
        cls.tree = server.build_data_json()

    def _labels(self, hardware_id):
        for hw in self.tree["Children"][0]["Children"]:
            if hw["HardwareId"] == hardware_id:
                return [c["Text"] for c in hw["Children"]]
        raise AssertionError(f"{hardware_id} not found")

    def test_load_label_is_singular(self):
        self.assertIn("Load", self._labels("/gpu-nvidia/0"))
        self.assertNotIn("Loads", self._labels("/gpu-nvidia/0"))

    def test_other_labels_are_plural(self):
        labels = self._labels("/lpc/bmc")
        for expected in ("Temperatures", "Fans", "Voltages", "Powers"):
            self.assertIn(expected, labels)

    def test_data_and_smalldata_share_one_node(self):
        labels = self._labels("/gpu-nvidia/0")
        self.assertEqual(labels.count("Data"), 1,
                         "Data and SmallData must collapse into one node")
        for hw in self.tree["Children"][0]["Children"]:
            if hw["HardwareId"] == "/gpu-nvidia/0":
                data = next(c for c in hw["Children"] if c["Text"] == "Data")
                types = {s["Type"] for s in data["Children"]}
                self.assertEqual(types, {"Data", "SmallData"})

    def test_group_nodes_have_no_sensor_id(self):
        for hw in self.tree["Children"][0]["Children"]:
            for group in hw["Children"]:
                self.assertNotIn("SensorId", group)
                self.assertEqual(group["Value"], "")


class TestFormatting(unittest.TestCase):
    def tearDown(self):
        server.CONFIG["decimal_comma"] = True

    def test_comma_separator(self):
        server.CONFIG["decimal_comma"] = True
        self.assertEqual(server.fmt("Temperature", 63.0), "63,0 °C")
        self.assertEqual(server.fmt("Voltage", 11.81), "11,810 V")
        self.assertEqual(server.fmt("Fan", 4800.0), "4800 RPM")
        self.assertEqual(server.fmt("Load", 0.0), "0,0 %")

    def test_dot_separator(self):
        server.CONFIG["decimal_comma"] = False
        self.assertEqual(server.fmt("Temperature", 63.0), "63.0 °C")
        self.assertEqual(server.fmt("Power", 21.37), "21.4 W")

    def test_missing_reading_renders_dash(self):
        self.assertEqual(server.fmt("Temperature", None), "-")

    def test_every_type_has_a_format(self):
        for sensor_type in server.TYPE_ORDER:
            self.assertIn(sensor_type, server.FORMATS)
            self.assertIn(sensor_type, server.TYPE_LABEL)
            self.assertIn(sensor_type, server.TYPE_ICON)

    def test_values_match_client_parseable_pattern(self):
        """Clients parse "<number><optional unit>" or a bare dash."""
        server.CONFIG["decimal_comma"] = True
        install_fixture()
        pattern = re.compile(r"^(-|-?\d+(,\d+)?( \S+)?)$")
        for sensor in iter_sensors(server.build_data_json()):
            self.assertRegex(sensor["Value"], pattern)


class TestMetrics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.CONFIG["hostname"] = "testhost"
        install_fixture()
        cls.text = server.build_metrics()

    def test_has_type_declarations(self):
        self.assertIn("# TYPE lhm_gpu_nvidia_temperature_celsius gauge", self.text)

    def test_samples_are_numeric(self):
        seen = 0
        for line in self.text.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            value = line.rsplit(" ", 1)[1]
            float(value)          # must parse — raises otherwise
            seen += 1
        self.assertGreater(seen, 0)

    def test_labels_present(self):
        sample = next(line for line in self.text.splitlines()
                      if not line.startswith("#"))
        for label in ("sensorName=", "hardwareName=", "sensorId=",
                      "hardwareId=", "host="):
            self.assertIn(label, sample)

    def test_metric_names_are_valid(self):
        pattern = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
        for line in self.text.splitlines():
            if line.startswith("# TYPE "):
                self.assertRegex(line.split()[2], pattern)


class TestRobustness(unittest.TestCase):
    def test_sources_never_raise(self):
        """Every source must return a list even with no hardware present."""
        for source, key, _interval in server.SOURCES:
            result = source()
            self.assertIsInstance(result, list, key)

    def test_poll_all_survives_a_broken_source(self):
        def broken():
            raise RuntimeError("simulated failure")

        original = server.SOURCES
        try:
            server.SOURCES = ((broken, "broken", None),
                              (server.poll_memory, "memory", None))
            self.assertIsInstance(server.poll_all(), list)
        finally:
            server.SOURCES = original

    def test_slow_sources_have_their_own_interval(self):
        """IPMI and SMART must never run at the fast interval.

        A BMC can take over ten seconds to answer. Polling it in the fast
        loop stalls CPU and GPU updates behind it, which shows up as a
        frozen display on a hardware panel.
        """
        intervals = {key: interval for _s, key, interval in server.SOURCES}
        self.assertIsNotNone(intervals["ipmi"], "IPMI must be polled slowly")
        self.assertIsNotNone(intervals["disks"], "SMART must be polled slowly")
        self.assertGreaterEqual(intervals["ipmi"], 15.0)
        for fast in ("cpu", "gpus", "memory"):
            self.assertIsNone(intervals[fast], f"{fast} must stay on the fast loop")

    def test_to_float_accepts_both_separators(self):
        self.assertEqual(server.to_float("11,81"), 11.81)
        self.assertEqual(server.to_float("11.81"), 11.81)
        self.assertIsNone(server.to_float("n/a"))
        self.assertIsNone(server.to_float(None))

    def test_smart_parser_reads_raw_column(self):
        """The normalised VALUE column is not a temperature — RAW_VALUE is."""
        row = ("194 Temperature_Celsius     0x0002   139   139   000    "
               "Old_age   Always       -       43 (Min/Max 19/46)")
        match = server.SMART_ATTR.search(row)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), 43)

    def test_ipmi_row_parser(self):
        row = "CPU1 Temp        | 01h | ok  |  3.1 | 44 degrees C"
        match = server.IPMI_ROW.match(row)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "CPU1 Temp")
        self.assertEqual(match.group(2), "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
