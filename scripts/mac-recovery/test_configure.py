import base64
import hashlib
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from configure import make_mapping, prepare


class RecoveryConfiguration(unittest.TestCase):
    ip = "192.0.2.45/26"
    mac = "02:00:00:00:00:45"

    def test_wake_and_account_authentication(self):
        root = ET.fromstring(make_mapping(self.ip, self.mac, None, "test"))
        connections = root.findall(".//connection")
        self.assertEqual(len(connections), 1)
        params = {p.get("name"): p.text for p in connections[0].findall("param")}
        self.assertEqual(params["hostname"], "192.0.2.45")
        self.assertEqual(params["wol-broadcast-addr"], "192.0.2.63")
        self.assertEqual(params["wol-mac-addr"], self.mac)
        self.assertNotIn("password", params)
        self.assertNotIn("username", params)

    def test_refuses_mismatched_ssh_key_and_invalid_wake_target(self):
        for args in [(self.ip, self.mac, "other-host ssh-ed25519 AAAA"), (self.ip, self.mac, "192.0.2.45 ssh-ed25519 AAAA"),
                     (self.ip, "ff:ff:ff:ff:ff:ff", None), ("192.0.2.63/26", self.mac, None)]:
            with self.assertRaises(ValueError):
                make_mapping(*args, "test")

    def test_private_config_and_no_overwrite(self):
        kind = b"ssh-ed25519"
        blob = len(kind).to_bytes(4, "big") + kind + (32).to_bytes(4, "big") + bytes(32)
        key = "192.0.2.45 ssh-ed25519 " + base64.b64encode(blob).decode()
        with tempfile.TemporaryDirectory() as parent:
            folder = Path(parent) / "console"
            prepare(folder, self.ip, self.mac, key)
            secret = folder / "console-password"
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
            root = ET.parse(folder / "user-mapping.xml")
            self.assertEqual(root.find(".//param[@name='host-key']").text, key)
            self.assertEqual(root.find("authorize").get("password"), hashlib.md5(secret.read_bytes().strip()).hexdigest())
            with self.assertRaises(ValueError):
                prepare(folder, self.ip, self.mac, None)
