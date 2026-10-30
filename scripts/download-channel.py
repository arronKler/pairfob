#!/usr/bin/env python3
"""Preserve the other release channel when replacing a Worker's static assets."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

DAEMON_BINARIES = {"pairfob-darwin-amd64", "pairfob-darwin-arm64",
                   "pairfob-linux-amd64", "pairfob-linux-arm64"}
# pairfob-chat ships beside the daemon so the desktop chat view has a local
# process to attach to. It is published only after the release that added it,
# so a prior manifest may carry just the daemon four.
CHAT_BINARIES = {"pairfob-chat-darwin-amd64", "pairfob-chat-darwin-arm64",
                 "pairfob-chat-linux-amd64", "pairfob-chat-linux-arm64"}
DAEMON_FILES = {"VERSION", "SHA256SUMS"} | DAEMON_BINARIES | CHAT_BINARIES
LEGACY_FILES = {"VERSION", "SHA256SUMS"} | DAEMON_BINARIES
DAEMON_PATHS = {"daemon/" + name for name in DAEMON_FILES} | {"install.sh"}
LEGACY_PATHS = {"daemon/" + name for name in LEGACY_FILES} | {"install.sh"}

# The desktop channel keeps one manifest for every published platform. A
# release built on one OS may add its own target to the same version, but a
# new version must include every platform the live channel already carries.
DESKTOP_TARGETS = ("darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64")
DESKTOP_BINARIES = {"pairfob-desktop-" + target for target in DESKTOP_TARGETS}
DESKTOP_FILES = DESKTOP_BINARIES | {"VERSION", "SHA256SUMS"}
CHANNEL_DIRS = {"daemon": "daemon", "android": "android/beta", "desktop": "desktop"}


def binary_target(name):
    """The GOOS and GOARCH a release binary was built for."""
    stem = name.removeprefix("pairfob-").removeprefix("chat-")
    os_name, arch = stem.split("-")
    return os_name, arch
# The release moved here from the relay; validate a first bootstrap against it.
LEGACY_DAEMON_ORIGIN = "https://pairfob.com/dl"
APK_PATH = re.compile(r"/android/beta/[A-Za-z0-9._-]+\.apk\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version(value):
    match = VERSION.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError("release must use three-part SemVer")
    return tuple(int(part) for part in match.groups())


def origin(value):
    parsed = urlsplit(value)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ("", "/") or not parsed.hostname
            or (parsed.scheme != "https" and not
                (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")))):
        raise ValueError("download origin must be HTTPS (HTTP only on loopback)")
    return value.rstrip("/")


def fetch(base, path, limit=65536, optional=False):
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "response"
        result = subprocess.run([
            "curl", "--silent", "--show-error", "--max-time", "120", "--retry", "2",
            "--max-filesize", str(limit), "-o", str(output), "-w", "%{http_code}", base + path,
        ], capture_output=True, text=True)
        if result.returncode:
            raise ValueError(f"download failed for {path}: {result.stderr.strip()}")
        if optional and result.stdout == "404":
            return None
        if result.stdout != "200":
            raise ValueError(f"download failed for {path}: HTTP {result.stdout}")
        data = output.read_bytes()
        if len(data) > limit:
            raise ValueError(f"download too large: {path}")
        return data


def legacy_inventory(data):
    entries = {}
    for line in data.decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line.strip())
        if not match:
            raise ValueError("invalid legacy daemon checksum inventory")
        entries[match.group(2)] = match.group(1)
    if not LEGACY_FILES <= set(entries):
        raise ValueError("invalid legacy daemon checksum inventory")
    return entries


def daemon_manifest(data, allow_legacy=False):
    value = json.loads(data)
    version(value.get("version"))
    if value.get("schema") != 1 or not re.fullmatch(r"[0-9a-f]{40}", value.get("commit", "")):
        raise ValueError("invalid daemon release provenance")
    files = value.get("files")
    valid_sets = (DAEMON_PATHS, LEGACY_PATHS) if allow_legacy else (DAEMON_PATHS,)
    if not isinstance(files, dict) or set(files) not in valid_sets:
        raise ValueError("invalid daemon release inventory")
    for info in files.values():
        if (not isinstance(info, dict) or not isinstance(info.get("sha256"), str)
                or not SHA.fullmatch(info["sha256"]) or type(info.get("size")) is not int
                or not 0 < info["size"] <= 64 * 1024 * 1024):
            raise ValueError("invalid daemon artifact hash or size")
    return value


def android_manifest(data, previous=False):
    value = json.loads(data)
    code, path, sha = value.get("versionCode"), value.get("url"), value.get("sha256")
    if (type(code) is not int or not 0 < code <= 2147483647 or not isinstance(path, str)
            or not APK_PATH.fullmatch(path) or path.endswith("/latest.apk")
            or not isinstance(sha, str) or not SHA.fullmatch(sha)):
        raise ValueError("invalid Android release inventory")
    # Old previous.json records may refer to the former relay path.
    if previous and value.get("origin") not in (None, "https://dl.pairfob.com"):
        raise ValueError("previous Android release must be on the download host")
    return value


def desktop_manifest(data):
    value = json.loads(data)
    version(value.get("version"))
    if value.get("schema") != 1 or not re.fullmatch(r"[0-9a-f]{40}", value.get("commit", "")):
        raise ValueError("invalid desktop release provenance")
    files = value.get("files")
    if (not isinstance(files, dict) or not files
            or not set(files) <= set(DESKTOP_TARGETS)):
        raise ValueError("invalid desktop release inventory")
    for info in files.values():
        if (not isinstance(info, dict) or not isinstance(info.get("sha256"), str)
                or not SHA.fullmatch(info["sha256"]) or type(info.get("size")) is not int
                or not 0 < info["size"] <= 64 * 1024 * 1024):
            raise ValueError("invalid desktop artifact hash or size")
    return value


def checksum_inventory(data):
    entries = {}
    for line in data.decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  \*?(.+)", line.strip())
        if not match or match.group(2) in entries:
            raise ValueError("invalid checksum inventory")
        entries[match.group(2)] = match.group(1)
    return entries


def check_receipt(receipt):
    for path, expected in receipt["metadata"].items():
        data = fetch(receipt["origin"], path, optional=True)
        if (digest(data) if data is not None else None) != expected:
            raise ValueError(f"download channel changed during publication: {path}")


def preserve(base, public, channel, receipt_path, required=False):
    metadata = {}
    def read(path):
        data = fetch(base, path, optional=True)
        metadata[path] = digest(data) if data is not None else None
        return data
    public.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=public.parent) as directory:
        staged = Path(directory)
        def save(path, data):
            target = staged / path.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if channel == "daemon":
            data = read("/daemon/release.json")
            if data is None:
                if required:
                    raise ValueError("publish the daemon download channel before publishing Android")
                # An absent channel is allowed only before the initial migration.
                if read("/daemon/VERSION") is not None:
                    raise ValueError("daemon channel has no verified inventory")
            else:
                manifest = daemon_manifest(data)
                for path, info in manifest["files"].items():
                    payload = fetch(base, "/" + path, info["size"])
                    if len(payload) != info["size"] or digest(payload) != info["sha256"]:
                        raise ValueError(f"daemon artifact mismatch: {path}")
                    save(path, payload)
                save("daemon/release.json", data)
        elif channel == "android":
            data = read("/android/beta/latest.json")
            if data is not None:
                latest = android_manifest(data)
                entries = [latest]
                save("android/beta/latest.json", data)
                previous = read("/android/beta/previous.json")
                if previous is not None:
                    prior = android_manifest(previous, previous=True)
                    if prior["versionCode"] >= latest["versionCode"]:
                        raise ValueError("Android predecessor is not older")
                    entries.append(prior)
                    save("android/beta/previous.json", previous)
                for entry in entries:
                    payload = fetch(base, entry["url"], 64 * 1024 * 1024)
                    if digest(payload) != entry["sha256"]:
                        raise ValueError("Android APK hash mismatch")
                    save(entry["url"], payload)
                    provenance = read(entry["url"] + ".provenance.json")
                    if provenance is not None:
                        saved = json.loads(provenance)
                        if saved.get("sha256") != entry["sha256"]:
                            raise ValueError("Android provenance hash mismatch")
                        save(entry["url"] + ".provenance.json", provenance)
        else:
            data = read("/desktop/release.json")
            if data is None:
                if required:
                    raise ValueError("publish the desktop channel before preserving it")
                if read("/desktop/VERSION") is not None:
                    raise ValueError("desktop channel has no verified inventory")
            else:
                manifest = desktop_manifest(data)
                payloads = {}
                for target, info in manifest["files"].items():
                    name = "pairfob-desktop-" + target
                    payload = fetch(base, "/desktop/" + name, info["size"])
                    if len(payload) != info["size"] or digest(payload) != info["sha256"]:
                        raise ValueError(f"desktop artifact mismatch: {name}")
                    payloads[name] = payload
                checksums = read("/desktop/SHA256SUMS")
                if checksums is None:
                    raise ValueError("desktop checksum inventory is missing")
                entries = checksum_inventory(checksums)
                if set(entries) != set(payloads) | {"VERSION"}:
                    raise ValueError("desktop checksum inventory does not match the manifest")
                release = read("/desktop/VERSION")
                if (release is None
                        or release.decode("utf-8", "replace").strip() != manifest["version"]):
                    raise ValueError("desktop VERSION differs from the manifest")
                payloads["VERSION"] = release
                for name, expected in entries.items():
                    if digest(payloads[name]) != expected:
                        raise ValueError(f"desktop artifact mismatch: {name}")
                    save("desktop/" + name, payloads[name])
                save("desktop/SHA256SUMS", checksums)
                save("desktop/release.json", data)
        receipt = {"origin": base, "metadata": metadata}
        check_receipt(receipt)
        # Replace only the untouched channel, never the channel being published.
        directory = CHANNEL_DIRS[channel]
        target = public / directory
        if target.exists():
            shutil.rmtree(target)
        source = staged / directory
        if source.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target)
        if channel == "daemon":
            if (staged / "install.sh").exists():
                shutil.copyfile(staged / "install.sh", public / "install.sh")
            elif (public / "install.sh").exists():
                (public / "install.sh").unlink()
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")


def stage_daemon(base, public, source, installer, receipt_path):
    source = source.resolve()
    release = (source / "VERSION").read_text().strip()
    version(release)
    commit = None
    for name in sorted(DAEMON_FILES - {"VERSION", "SHA256SUMS"}):
        output = subprocess.check_output(["go", "version", "-m", str(source / name)], text=True)
        settings = {}
        for line in output.splitlines():
            parts = line.strip().split("\t", 1)
            if len(parts) == 2 and parts[0] == "build" and "=" in parts[1]:
                key, val = parts[1].split("=", 1)
                settings[key] = val
        os_name, arch = binary_target(name)
        revision = settings.get("vcs.revision", "")
        if (settings.get("vcs.modified") != "false" or settings.get("GOOS") != os_name
                or settings.get("GOARCH") != arch or not re.fullmatch(r"[0-9a-f]{40}", revision)):
            raise ValueError(f"binary has wrong or dirty build provenance: {name}")
        if commit is not None and revision != commit:
            raise ValueError("daemon binaries have different source commits")
        commit = revision
    native_os = platform.system().lower()
    native_arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    native = f"pairfob-{native_os}-{native_arch}"
    if native not in DAEMON_FILES:
        raise ValueError("publish on macOS or Linux with a supported architecture")
    output = subprocess.check_output([str(source / native), "version"], text=True, timeout=5)
    if not output.startswith(f"pairfob {release} "):
        raise ValueError("native executable version differs from VERSION")
    paths = {"daemon/" + name: source / name for name in DAEMON_FILES}
    paths["install.sh"] = installer
    manifest = {"schema": 1, "version": release, "commit": commit,
                "files": {name: {"sha256": digest(path.read_bytes()), "size": path.stat().st_size}
                          for name, path in sorted(paths.items())}}
    daemon_manifest(json.dumps(manifest))
    old = fetch(base, "/daemon/release.json", optional=True)
    if old is None:
        # The first publish moves the live release from the relay. Validate that
        # move against the legacy channel instead of trusting a local artifact.
        legacy_version = fetch(LEGACY_DAEMON_ORIGIN, "/VERSION", optional=True)
        if legacy_version is not None:
            legacy_sums = fetch(LEGACY_DAEMON_ORIGIN, "/SHA256SUMS", optional=True)
            if legacy_sums is None:
                raise ValueError("legacy daemon inventory is missing")
            legacy_release = legacy_version.decode().strip()
            version(legacy_release)
            if version(release) < version(legacy_release):
                raise ValueError("refusing daemon version rollback")
            if version(release) == version(legacy_release):
                entries = legacy_inventory(legacy_sums)
                for name in DAEMON_BINARIES:
                    if entries[name] != manifest["files"]["daemon/" + name]["sha256"]:
                        raise ValueError("legacy daemon version already has different binary bytes")
    else:
        prior = daemon_manifest(old, allow_legacy=True)
        if version(release) < version(prior["version"]):
            raise ValueError("refusing daemon version rollback")
        if version(release) == version(prior["version"]):
            for path in (DAEMON_PATHS - {"install.sh"}) & set(prior["files"]):
                if prior["files"][path] != manifest["files"][path]:
                    raise ValueError("published daemon version already has different bytes")
    receipt_path.write_text(json.dumps({"origin": base, "metadata": {
        "/daemon/release.json": digest(old) if old is not None else None}}, indent=2) + "\n")
    public.mkdir(parents=True, exist_ok=True)
    for name, path in paths.items():
        dest = public / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
    (public / "daemon/release.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_daemon(base, public):
    expected = (public / "daemon/release.json").read_bytes()
    actual = fetch(base, "/daemon/release.json")
    if actual != expected:
        raise ValueError("live daemon manifest differs from candidate")
    for path, info in daemon_manifest(actual)["files"].items():
        data = fetch(base, "/" + path, info["size"])
        if len(data) != info["size"] or digest(data) != info["sha256"]:
            raise ValueError(f"live daemon artifact mismatch: {path}")


def stage_desktop(base, public, source, commit, receipt_path):
    source = source.resolve()
    release = (source / "VERSION").read_text().strip()
    version(release)
    if not re.fullmatch(r"[0-9a-f]{40}", commit or ""):
        raise ValueError("desktop release needs the source commit")

    present = {path.name for path in source.iterdir()}
    binaries = present & DESKTOP_BINARIES
    targets = {name.removeprefix("pairfob-desktop-") for name in binaries}
    if not targets:
        raise ValueError("desktop release has no platform binary")
    if present != {"VERSION", "SHA256SUMS"} | binaries:
        raise ValueError("unexpected or missing desktop release file")
    for name in sorted(binaries):
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"desktop release requires a regular file: {name}")
        if not (path.stat().st_mode & 0o111):
            raise ValueError(f"desktop release binary is not executable: {name}")

    inventory = checksum_inventory((source / "SHA256SUMS").read_bytes())
    if set(inventory) != {"VERSION"} | binaries:
        raise ValueError("desktop checksum inventory does not match its files")
    payloads = {}
    for name in sorted(binaries):
        payload = (source / name).read_bytes()
        if digest(payload) != inventory[name]:
            raise ValueError(f"desktop checksum mismatch: {name}")
        payloads[name] = payload
    version_bytes = (source / "VERSION").read_bytes()
    if digest(version_bytes) != inventory["VERSION"]:
        raise ValueError("desktop checksum mismatch: VERSION")

    files = {name.removeprefix("pairfob-desktop-"): {
        "sha256": digest(payload), "size": len(payload)} for name, payload in payloads.items()}
    old = fetch(base, "/desktop/release.json", optional=True)
    if old is not None:
        prior = desktop_manifest(old)
        if version(release) < version(prior["version"]):
            raise ValueError("refusing desktop version rollback")
        if version(release) == version(prior["version"]):
            for target, info in prior["files"].items():
                if target in files and files[target] != info:
                    raise ValueError("published desktop version already has different bytes")
        missing = set(prior["files"]) - targets
        if missing:
            if version(release) != version(prior["version"]):
                raise ValueError("desktop release must include every published platform")
            for target in sorted(missing):
                name = "pairfob-desktop-" + target
                info = prior["files"][target]
                payload = fetch(base, "/desktop/" + name, info["size"])
                if len(payload) != info["size"] or digest(payload) != info["sha256"]:
                    raise ValueError(f"desktop artifact mismatch: {name}")
                payloads[name] = payload
                files[target] = info

    receipt_path.write_text(json.dumps({"origin": base, "metadata": {
        "/desktop/release.json": digest(old) if old is not None else None}}, indent=2) + "\n")

    # Rewrite the staged channel from the merged set, so a platform carried
    # over from the live manifest keeps its bytes. SHA256SUMS is regenerated
    # because a partial build's file covers only its own platform.
    staged = public / "desktop"
    if staged.exists():
        shutil.rmtree(staged)
    staged.mkdir(parents=True)
    checksums = []
    for name, payload in sorted(payloads.items()):
        (staged / name).write_bytes(payload)
        checksums.append(f"{digest(payload)}  {name}\n")
    checksums.append(f"{digest(version_bytes)}  VERSION\n")
    (staged / "VERSION").write_bytes(version_bytes)
    (staged / "SHA256SUMS").write_text("".join(sorted(checksums)))
    manifest = {"schema": 1, "version": release, "commit": commit, "files": files}
    desktop_manifest(json.dumps(manifest))
    (staged / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify_desktop(base, public):
    expected = (public / "desktop/release.json").read_bytes()
    actual = fetch(base, "/desktop/release.json")
    if actual != expected:
        raise ValueError("live desktop manifest differs from candidate")
    manifest = desktop_manifest(actual)
    checksums = fetch(base, "/desktop/SHA256SUMS")
    if checksums != (public / "desktop/SHA256SUMS").read_bytes():
        raise ValueError("live desktop checksum inventory differs from candidate")
    entries = checksum_inventory(checksums)
    expected_names = {"VERSION"} | {
        "pairfob-desktop-" + target for target in manifest["files"]}
    if set(entries) != expected_names:
        raise ValueError("live desktop checksum inventory does not match the manifest")
    for target, info in manifest["files"].items():
        if entries["pairfob-desktop-" + target] != info["sha256"]:
            raise ValueError("live desktop checksum differs from the manifest")
    for name, expected_sha in entries.items():
        live = fetch(base, "/desktop/" + name, 64 * 1024 * 1024)
        candidate = (public / "desktop" / name).read_bytes()
        if live != candidate or digest(live) != expected_sha:
            raise ValueError(f"live desktop artifact mismatch: {name}")
    release = fetch(base, "/desktop/VERSION")
    if release != (public / "desktop/VERSION").read_bytes():
        raise ValueError("live desktop VERSION differs from candidate")
    if release.decode("utf-8", "replace").strip() != manifest["version"]:
        raise ValueError("live desktop VERSION differs from the manifest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=[
        "preserve", "check", "stage-daemon", "verify-daemon",
        "stage-desktop", "verify-desktop"])
    parser.add_argument("--origin", default="https://dl.pairfob.com")
    parser.add_argument("--public", type=Path)
    parser.add_argument("--channel", choices=["android", "daemon", "desktop"])
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--require-present", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--installer", type=Path)
    parser.add_argument("--commit", default="")
    args = parser.parse_args()
    base = origin(args.origin)
    if args.mode == "preserve":
        preserve(base, args.public, args.channel, args.receipt, args.require_present)
    elif args.mode == "check":
        check_receipt(json.loads(args.receipt.read_text()))
    elif args.mode == "stage-daemon":
        stage_daemon(base, args.public, args.source, args.installer, args.receipt)
    elif args.mode == "stage-desktop":
        stage_desktop(base, args.public, args.source, args.commit, args.receipt)
    elif args.mode == "verify-daemon":
        verify_daemon(base, args.public)
    else:
        verify_desktop(base, args.public)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
