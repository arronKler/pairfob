"""Opt-in Docker test: exercise the shipped console in a loopback-only network."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def open_console(path, form=None, headers=None):
    body = urlencode(form).encode() if form is not None else None
    return urlopen(Request("http://127.0.0.1:18482" + path, data=body, headers=headers or {}), timeout=25)


def receive_wake_and_negotiate(ready):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(20)
        udp.bind(("", 9))
        ready.set()
        packet = udp.recv(2048)
        if packet != bytes.fromhex("ff" * 6 + "020000000045" * 16):
            raise RuntimeError("unexpected wake target or packet")
    # The test display only starts listening after receiving the wake packet.
    with socket.socket() as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.45", 5900))
        server.settimeout(20)
        server.listen()
        connection, _ = server.accept()
        with connection, connection.makefile("rb") as wire:
            connection.settimeout(10)
            connection.sendall(b"RFB 003.008\n")
            if not wire.readline(12).startswith(b"RFB "):
                raise RuntimeError("no RFB greeting")
            connection.sendall(bytes([1, 30]))  # Only advertise Apple account authentication.
            if wire.read(1) != bytes([30]):
                raise RuntimeError("client did not select Apple account authentication")


def probe():
    deadline = time.monotonic() + 60
    while True:
        try:
            with open_console("/") as response:
                if response.status == 200:
                    break
        except (URLError, OSError):
            if time.monotonic() >= deadline:
                raise RuntimeError("console did not start")
        time.sleep(0.5)
    try:
        open_console("/api/tokens", {"username": "pairfob", "password": "incorrect-test-password"}).close()
    except HTTPError as error:
        if error.code != 403:
            raise
    else:
        raise RuntimeError("console admitted invalid credentials")
    with open_console("/api/tokens", {"username": "pairfob", "password": Path("/run/console-secret").read_text().strip()}) as response:
        login = json.load(response)
    token, source = login["authToken"], login["dataSource"]
    with open_console("/api/session/data/" + source + "/connections", headers={"Guacamole-Token": token}) as response:
        profiles = list(json.load(response).values())
    if len(profiles) != 1 or profiles[0]["protocol"] != "vnc":
        raise RuntimeError("unexpected recovery profiles without a pinned SSH key")
    ready = threading.Event()
    with ThreadPoolExecutor(max_workers=1) as pool:
        received = pool.submit(receive_wake_and_negotiate, ready)
        if not ready.wait(5):
            raise RuntimeError("fixture did not bind its UDP socket")
        with open_console("/tunnel?connect", {
            "token": token, "GUAC_DATA_SOURCE": source, "GUAC_ID": profiles[0]["identifier"],
            "GUAC_TYPE": "c", "GUAC_WIDTH": "640", "GUAC_HEIGHT": "480", "GUAC_DPI": "96",
            "GUAC_IMAGE": "image/png", "GUAC_TIMEZONE": "UTC",
        }) as response:
            if not response.getheader("Guacamole-Tunnel-Token"):
                raise RuntimeError("console did not establish a tunnel")
            response.read()
        received.result(timeout=25)
    print("Verified console login, fixed target, wake packet and Apple authentication negotiation.")


def run():
    from configure import prepare
    root = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        config = folder / "config"
        prepare(config, "127.0.0.45/8", "02:00:00:00:00:45", None)
        override = folder / "compose-test.yaml"
        override.write_text('services:\n  guacd:\n    network_mode: none\n    restart: "no"\n'
                            '  console:\n    network_mode: service:guacd\n    restart: "no"\n')
        env = dict(os.environ, PAIRFOB_RECOVERY_DIR=str(config))
        cmd = ["docker", "compose", "-p", "pf-recovery-" + secrets.token_hex(5),
               "-f", str(root / "compose.yaml"), "-f", str(override)]
        try:
            subprocess.run(cmd + ["up", "-d"], env=env, check=True)
            cid = subprocess.check_output(cmd + ["ps", "-q", "guacd"], env=env, text=True).strip()
            subprocess.run(["docker", "run", "--rm", "--network", "container:" + cid,
                            "-v", f"{config}/console-password:/run/console-secret:ro",
                            "-v", f"{Path(__file__).resolve()}:/test.py:ro",
                            "python:3.13-alpine", "python", "/test.py", "probe"], check=True)
        finally:
            subprocess.run(cmd + ["down"], env=env, check=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["probe"]:
        probe()
    else:
        run()
