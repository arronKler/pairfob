"""Prepare a private Guacamole console for one Mac on a trusted management LAN."""
import argparse
import base64
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import secrets
import tempfile
import xml.etree.ElementTree as ET


def ipv4_network(value):
    network = ipaddress.IPv4Interface(value)
    if not 1 <= network.network.prefixlen <= 30 or network.ip in (
        network.network.network_address, network.network.broadcast_address
    ) or network.ip.is_multicast or network.ip.is_unspecified:
        raise ValueError("expected the Mac's unicast IPv4 address and LAN prefix")
    return network


def make_mapping(mac_ip, mac, known_host, password):
    interface = ipv4_network(mac_ip)
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", mac):
        raise ValueError("expected six colon-separated MAC address octets")
    if int(mac[:2], 16) & 1 or mac == "00:00:00:00:00:00":
        raise ValueError("expected a unicast Ethernet MAC address")
    root = ET.Element("user-mapping")
    # File authentication supports MD5 of a password. Generate a random 256-bit
    # console secret, independent of every system credential.
    auth = ET.SubElement(root, "authorize", username="pairfob", encoding="md5",
                         password=hashlib.md5(password.encode()).hexdigest())

    def connection(name, protocol, settings):
        node = ET.SubElement(auth, "connection", name=name)
        ET.SubElement(node, "protocol").text = protocol
        for key, value in {
            "hostname": str(interface.ip), "wol-send-packet": "true", "wol-mac-addr": mac,
            "wol-broadcast-addr": str(interface.network.broadcast_address), "wol-wait-time": "0", "wol-udp-port": "9",
            "disable-copy": "true", "disable-paste": "true", **settings,
        }.items():
            ET.SubElement(node, "param", name=key).text = value

    connection("Wake and sign in", "vnc", {"port": "5900", "autoretry": "8"})
    if known_host:
        fields = known_host.strip().split()
        if len(fields) < 3 or fields[0] != str(interface.ip):
            raise ValueError("expected a verified OpenSSH known_hosts line for the Mac IP")
        blob = base64.b64decode(fields[2], validate=True)
        if len(blob) < 4 or fields[1].encode() != blob[4:4 + int.from_bytes(blob[:4], "big")]:
            raise ValueError("invalid SSH host public key")
        connection("FileVault SSH", "ssh", {"port": "22", "host-key": " ".join(fields[:3])})
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def prepare(directory, mac_ip, mac, known_host):
    password = secrets.token_urlsafe(32)
    mapping = make_mapping(mac_ip, mac, known_host, password)
    directory = Path(directory).absolute()
    # Install a complete private directory once. An existing setup keeps its credentials.
    if directory.exists() or directory.is_symlink():
        raise ValueError("output already exists; choose a new private directory")
    with tempfile.TemporaryDirectory(dir=directory.parent) as stage:
        config = Path(stage) / "config"
        config.mkdir(mode=0o700)
        secret = config / "console-password"
        secret.write_text(password + "\n")
        secret.chmod(0o600)
        xml = config / "user-mapping.xml"
        xml.write_bytes(mapping)
        # Docker bind-mounts this file individually for the non-root web process.
        xml.chmod(0o444)
        # mkdir is exclusive even when two configurations race for this path.
        directory.mkdir(mode=0o700)
        try:
            for item in (secret, xml):
                os.rename(item, directory / item.name)
        except OSError:
            for name in ("console-password", "user-mapping.xml"):
                (directory / name).unlink(missing_ok=True)
            directory.rmdir()
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mac-ip", required=True, help="Mac's reserved IPv4 address/prefix")
    parser.add_argument("--ethernet", required=True, help="Ethernet MAC address")
    parser.add_argument("--known-host", type=Path, help="one independently verified preboot SSH host key line")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        prepare(args.output, args.mac_ip, args.ethernet,
                args.known_host.read_text() if args.known_host else None)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Configuration failed: {error}\n")
    print("Configuration ready. Console user: pairfob. Password is in console-password.")
