#!/usr/bin/env python3
"""Release publication preserves the other channel, with verified inventories."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("download_channel", Path(__file__).with_name("download-channel.py"))
channel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(channel)


class Publication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.public = self.root / "public"
        self.public.mkdir()
        self.receipt = self.root / "receipt.json"
        self.live = {}
        self.legacy_assets = {}
        self.origin = "https://dl.pairfob.com"
        def fetch(base, path, limit=65536, optional=False):
            if base == channel.LEGACY_DAEMON_ORIGIN:
                data = self.legacy_assets.get(path)
                if data is None:
                    if optional:
                        return None
                    raise ValueError("missing legacy " + path)
                return data
            self.assertEqual(base, self.origin)
            if path not in self.live:
                if optional:
                    return None
                raise ValueError("missing " + path)
            self.assertLessEqual(len(self.live[path]), limit)
            return self.live[path]
        self.mock = patch.object(channel, "fetch", side_effect=fetch)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def daemon(self):
        files = {}
        for path in channel.DAEMON_PATHS:
            data = ("bytes:" + path).encode()
            files[path] = {"sha256": channel.digest(data), "size": len(data)}
            self.live["/" + path] = data
        value = {"schema": 1, "version": "v1.4.5", "commit": "a" * 40, "files": files}
        self.live["/daemon/release.json"] = json.dumps(value).encode()
        return value

    def android(self):
        for code in [13, 14]:
            path = f"/android/beta/pairfob-1.0.0-beta.{code}-{code}.apk"
            data = f"signed APK {code}".encode()
            self.live[path] = data
            manifest = {"versionCode": code, "url": path, "sha256": channel.digest(data)}
            name = "latest.json" if code == 14 else "previous.json"
            self.live["/android/beta/" + name] = json.dumps(manifest).encode()
            self.live[path + ".provenance.json"] = json.dumps({"sha256": channel.digest(data)}).encode()

    def preserve(self, name):
        channel.preserve(self.origin, self.public, name, self.receipt)

    def test_android_publication_hydrates_daemon_and_installer_from_clean_checkout(self):
        self.daemon()
        own = self.public / "android/beta/candidate.apk"
        own.parent.mkdir(parents=True)
        own.write_bytes(b"candidate")
        self.preserve("daemon")
        for path in channel.DAEMON_PATHS | {"daemon/release.json"}:
            self.assertEqual((self.public / path).read_bytes(), self.live["/" + path])
        self.assertEqual(own.read_bytes(), b"candidate")

    def test_daemon_publication_keeps_current_and_previous_apks_and_receipts(self):
        self.android()
        own = self.public / "daemon/VERSION"
        own.parent.mkdir()
        own.write_text("candidate")
        self.preserve("android")
        for path, data in self.live.items():
            self.assertEqual((self.public / path.lstrip("/")).read_bytes(), data)
        self.assertEqual(own.read_text(), "candidate")

    def test_corrupt_payload_does_not_replace_existing_assets(self):
        self.daemon()
        existing = self.public / "daemon/VERSION"
        existing.parent.mkdir()
        existing.write_text("existing")
        self.live["/daemon/VERSION"] = b"bad"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.preserve("daemon")
        self.assertEqual(existing.read_text(), "existing")

    def test_remote_change_before_deployment_is_rejected(self):
        self.android()
        self.preserve("android")
        self.live["/android/beta/latest.json"] += b" "
        with self.assertRaisesRegex(ValueError, "changed during publication"):
            channel.check_receipt(json.loads(self.receipt.read_text()))

    def test_partial_daemon_channel_is_not_treated_as_absent(self):
        self.live["/daemon/VERSION"] = b"v1.4.5"
        with self.assertRaisesRegex(ValueError, "no verified inventory"):
            self.preserve("daemon")

    def test_malicious_inventory_cannot_write_outside_channel(self):
        manifest = self.daemon()
        manifest["files"]["../outside"] = {"sha256": "a" * 64, "size": 1}
        self.live["/daemon/release.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.preserve("daemon")
        self.assertFalse((self.root / "outside").exists())

    def test_android_publisher_cannot_activate_legacy_routes_before_daemon_bootstrap(self):
        with self.assertRaisesRegex(ValueError, "before publishing Android"):
            channel.preserve(self.origin, self.public, "daemon", self.receipt, required=True)

    def test_missing_channel_drops_stale_local_copy(self):
        stale = self.public / "daemon/VERSION"
        stale.parent.mkdir()
        stale.write_text("stale")
        self.preserve("daemon")
        self.assertFalse(stale.exists())
        channel.check_receipt(json.loads(self.receipt.read_text()))

    def test_android_apk_checksum_is_required(self):
        self.android()
        self.live["/android/beta/pairfob-1.0.0-beta.14-14.apk"] = b"corrupt"
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.preserve("android")

    def source(self, release="v1.4.6"):
        source = self.root / "source"
        source.mkdir(exist_ok=True)
        for name in channel.DAEMON_FILES:
            (source / name).write_text(release if name == "VERSION" else "new:" + name)
        installer = self.root / "install.sh"
        installer.write_text("#!/bin/sh\n")
        def metadata(args, text=True, timeout=None):
            if args[-1] == "version":
                return f"pairfob {release} ({'b' * 7})\n"
            os_name, arch = channel.binary_target(Path(args[-1]).name)
            return (f"build\tGOOS={os_name}\nbuild\tGOARCH={arch}\n"
                    f"build\tvcs.modified=false\nbuild\tvcs.revision={'b' * 40}\n"
                    f"build\t-ldflags=-s -w -X main.version={release}\n")
        return source, installer, metadata

    def legacy(self, release="v1.4.5", mutate=None):
        sums = []
        for name in channel.LEGACY_FILES:
            data = (release if name == "VERSION" else "new:" + name).encode()
            sha = channel.digest(data)
            if name == mutate:
                sha = "0" * 64
            sums.append(f"{sha}  {name}")
        self.legacy_assets["/VERSION"] = release.encode()
        self.legacy_assets["/SHA256SUMS"] = ("\n".join(sums) + "\n").encode()

    def test_bootstrap_rejects_a_newer_legacy_release(self):
        source, installer, metadata = self.source("v1.4.5")
        self.legacy("v1.4.6")
        with patch.object(channel.subprocess, "check_output", side_effect=metadata):
            with self.assertRaisesRegex(ValueError, "rollback"):
                channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)

    def test_bootstrap_rejects_changed_legacy_binary_bytes(self):
        source, installer, metadata = self.source("v1.4.5")
        self.legacy("v1.4.5", mutate="pairfob-darwin-arm64")
        with patch.object(channel.subprocess, "check_output", side_effect=metadata):
            with self.assertRaisesRegex(ValueError, "different binary bytes"):
                channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)

    def test_bootstrap_accepts_a_matching_legacy_release(self):
        source, installer, metadata = self.source("v1.4.5")
        self.legacy("v1.4.5")
        with patch.object(channel.subprocess, "check_output", side_effect=metadata):
            channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)
        candidate = channel.daemon_manifest((self.public / "daemon/release.json").read_bytes())
        self.assertEqual(candidate["version"], "v1.4.5")

    def test_stage_checks_clean_builds_and_saves_deployment_precondition(self):
        self.daemon()
        source, installer, metadata = self.source()
        with patch.object(channel.subprocess, "check_output", side_effect=metadata):
            channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)
        candidate = channel.daemon_manifest((self.public / "daemon/release.json").read_bytes())
        self.assertEqual(candidate["version"], "v1.4.6")
        self.assertEqual(candidate["commit"], "b" * 40)
        channel.check_receipt(json.loads(self.receipt.read_text()))
        self.live["/daemon/release.json"] += b" "
        with self.assertRaisesRegex(ValueError, "changed during publication"):
            channel.check_receipt(json.loads(self.receipt.read_text()))

    def test_stage_rejects_rollback_and_overwriting_published_binary_bytes(self):
        self.daemon()
        for release, message in [("v1.4.4", "rollback"), ("v1.4.5", "different bytes")]:
            source, installer, metadata = self.source(release)
            with patch.object(channel.subprocess, "check_output", side_effect=metadata):
                with self.assertRaisesRegex(ValueError, message):
                    channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)

    def test_dirty_or_wrong_architecture_builds_are_rejected(self):
        source, installer, metadata = self.source()
        for old, new in [("modified=false", "modified=true"), ("GOOS=darwin", "GOOS=windows")]:
            with patch.object(channel.subprocess, "check_output", side_effect=lambda *a, **k: metadata(*a, **k).replace(old, new)):
                with self.assertRaisesRegex(ValueError, "provenance"):
                    channel.stage_daemon(self.origin, self.public, source, installer, self.receipt)

    def test_release_inventory_and_origins_fail_closed(self):
        for value in ["1.4", "1.4.5.6", "dev", "v01.4.5"]:
            with self.assertRaises(ValueError):
                channel.version(value)
        for value in ["http://evil.example", "https://user:password@host", "https://host/path", "https://host?x=1"]:
            with self.assertRaises(ValueError):
                channel.origin(value)

    def desktop(self, release="v1.4.5", targets=("darwin-arm64", "linux-amd64")):
        files = {}
        sums = []
        for target in targets:
            name = "pairfob-desktop-" + target
            data = f"desktop {target} {release}".encode()
            self.live["/desktop/" + name] = data
            files[target] = {"sha256": channel.digest(data), "size": len(data)}
            sums.append(f"{channel.digest(data)}  {name}")
        version_data = (release + "\n").encode()
        self.live["/desktop/VERSION"] = version_data
        sums.append(f"{channel.digest(version_data)}  VERSION")
        self.live["/desktop/SHA256SUMS"] = ("\n".join(sums) + "\n").encode()
        manifest = {"schema": 1, "version": release, "commit": "a" * 40, "files": files}
        self.live["/desktop/release.json"] = json.dumps(manifest).encode()
        return manifest

    def desktop_source(self, release="v1.4.6", targets=("darwin-arm64",), contents=None):
        source = self.root / "desktop-source"
        source.mkdir(exist_ok=True)
        version_data = (release + "\n").encode()
        (source / "VERSION").write_bytes(version_data)
        sums = [f"{channel.digest(version_data)}  VERSION"]
        for target in targets:
            name = "pairfob-desktop-" + target
            data = (contents or {}).get(target, f"built {target} {release}".encode())
            path = source / name
            path.write_bytes(data)
            path.chmod(0o755)
            sums.append(f"{channel.digest(data)}  {name}")
        (source / "SHA256SUMS").write_text("\n".join(sums) + "\n")
        return source

    def test_desktop_publication_hydrates_from_live_and_keeps_other_channels(self):
        self.daemon()
        self.android()
        self.desktop()
        own = self.public / "android/beta/candidate.apk"
        own.parent.mkdir(parents=True)
        own.write_bytes(b"candidate")
        self.preserve("desktop")
        for path in ["desktop/release.json", "desktop/VERSION", "desktop/SHA256SUMS",
                     "desktop/pairfob-desktop-darwin-arm64",
                     "desktop/pairfob-desktop-linux-amd64"]:
            self.assertEqual((self.public / path).read_bytes(), self.live["/" + path])
        self.assertEqual(own.read_bytes(), b"candidate")

    def test_desktop_preservation_rejects_corrupt_bytes(self):
        self.desktop()
        self.live["/desktop/pairfob-desktop-linux-amd64"] = b"corrupt"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.preserve("desktop")

    def test_desktop_manifest_cannot_write_outside_channel(self):
        manifest = self.desktop()
        manifest["files"]["../outside"] = {"sha256": "a" * 64, "size": 1}
        self.live["/desktop/release.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.preserve("desktop")
        self.assertFalse((self.root / "outside").exists())

    def test_desktop_stage_writes_manifest_and_regenerated_checksums(self):
        source = self.desktop_source()
        channel.stage_desktop(self.origin, self.public, source, "c" * 40, self.receipt)
        manifest = channel.desktop_manifest((self.public / "desktop/release.json").read_bytes())
        self.assertEqual(manifest["version"], "v1.4.6")
        self.assertEqual(set(manifest["files"]), {"darwin-arm64"})
        sums = channel.checksum_inventory((self.public / "desktop/SHA256SUMS").read_bytes())
        self.assertEqual(set(sums), {"VERSION", "pairfob-desktop-darwin-arm64"})
        self.assertEqual((self.public / "desktop/VERSION").read_text(), "v1.4.6\n")
        self.assertEqual(json.loads(self.receipt.read_text())["metadata"],
                         {"/desktop/release.json": None})

    def test_desktop_stage_keeps_other_platforms_at_the_same_version(self):
        self.desktop("v1.4.5", ("darwin-arm64", "linux-amd64"))
        source = self.desktop_source(
            "v1.4.5", ("darwin-arm64",),
            contents={"darwin-arm64": b"desktop darwin-arm64 v1.4.5"})
        channel.stage_desktop(self.origin, self.public, source, "c" * 40, self.receipt)
        manifest = channel.desktop_manifest((self.public / "desktop/release.json").read_bytes())
        self.assertEqual(set(manifest["files"]), {"darwin-arm64", "linux-amd64"})
        self.assertTrue((self.public / "desktop/pairfob-desktop-linux-amd64").exists())

    def test_desktop_stage_requires_every_published_platform_on_a_new_version(self):
        self.desktop("v1.4.5", ("darwin-arm64", "linux-amd64"))
        source = self.desktop_source("v1.4.6", ("darwin-arm64",))
        with self.assertRaisesRegex(ValueError, "every published platform"):
            channel.stage_desktop(self.origin, self.public, source, "c" * 40, self.receipt)

    def test_desktop_stage_rejects_changed_bytes_at_the_same_version(self):
        self.desktop("v1.4.5", ("darwin-arm64",))
        source = self.desktop_source("v1.4.5", ("darwin-arm64",))
        with self.assertRaisesRegex(ValueError, "different bytes"):
            channel.stage_desktop(self.origin, self.public, source, "c" * 40, self.receipt)

    def test_desktop_verify_compares_live_bytes(self):
        source = self.desktop_source()
        channel.stage_desktop(self.origin, self.public, source, "c" * 40, self.receipt)
        for path in (self.public / "desktop").iterdir():
            self.live["/desktop/" + path.name] = path.read_bytes()
        channel.verify_desktop(self.origin, self.public)
        self.live["/desktop/pairfob-desktop-darwin-arm64"] = b"tampered"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            channel.verify_desktop(self.origin, self.public)


if __name__ == "__main__":
    unittest.main()
