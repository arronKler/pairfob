#!/usr/bin/env python3
"""Serve the local-dev CA over HTTP so a phone can install it before HTTPS."""

from __future__ import annotations

import argparse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def pem_to_der(pem: bytes) -> bytes:
    body = []
    take = False
    for line in pem.decode("ascii").splitlines():
        if "BEGIN CERTIFICATE" in line:
            take = True
            continue
        if "END CERTIFICATE" in line:
            break
        if take:
            body.append(line.strip())
    import base64

    return base64.b64decode("".join(body))


def mobileconfig(der: bytes, pair: str) -> bytes:
    import base64

    b64 = base64.encodebytes(der).decode("ascii")
    root_uuid = str(uuid.uuid4()).upper()
    payload_uuid = str(uuid.uuid4()).upper()
    pair_note = f"Then open {pair}/pair." if pair else "Then open the HTTPS pairing page."
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>pairfob-local-ca.cer</string>
      <key>PayloadContent</key>
      <data>
{b64}      </data>
      <key>PayloadDescription</key>
      <string>Trust the Pairfob local development HTTPS certificate. {pair_note}</string>
      <key>PayloadDisplayName</key>
      <string>Pairfob local CA</string>
      <key>PayloadIdentifier</key>
      <string>com.pairfob.local.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>{payload_uuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Adds a development root CA so Safari can use the camera on the local Pairfob origin.</string>
  <key>PayloadDisplayName</key>
  <string>Pairfob local CA</string>
  <key>PayloadIdentifier</key>
  <string>com.pairfob.local</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{root_uuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"""
    return xml.encode("utf-8")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--listen", default="127.0.0.1")
    p.add_argument("--port", type=int, default=18787)
    p.add_argument("--ca", required=True)
    p.add_argument("--https-pair", default="")
    args = p.parse_args()
    pem = Path(args.ca).resolve().read_bytes()
    der = pem_to_der(pem)
    pair = args.https_pair.rstrip("/")
    profile = mobileconfig(der, pair)
    pair_href = f"{pair}/pair" if pair else ""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *a: object) -> None:
            return

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path in ("/ca.crt", "/ca.cer", "/pairfob-local-ca.cer"):
                self.send_response(200)
                self.send_header("Content-Type", "application/pkix-cert")
                self.send_header("Content-Length", str(len(der)))
                self.send_header("Content-Disposition", 'inline; filename="pairfob-local-ca.cer"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(der)
                return
            if path in ("/ca.mobileconfig", "/pairfob-local.mobileconfig"):
                self.send_response(200)
                self.send_header("Content-Type", "application/x-apple-aspen-config")
                self.send_header("Content-Length", str(len(profile)))
                self.send_header("Content-Disposition", 'inline; filename="pairfob-local.mobileconfig"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(profile)
                return
            if path in ("/", "/index.html"):
                extra = (
                    f'<li>Then open <a href="{pair_href}">{pair_href}</a>.</li>'
                    if pair_href
                    else "<li>Then open the HTTPS pairing page.</li>"
                )
                html = f"""<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Pairfob local CA</title>
<body style="font:16px/1.4 system-ui;padding:1.5rem;max-width:40rem">
<h1>Install this CA first</h1>
<p>iPhone needs a <strong>root CA profile</strong>, not a personal certificate. If iOS asked for a private key, use the profile link below — do not install the .crt as an identity.</p>
<ol>
<li><a href="/ca.mobileconfig">Install Pairfob local CA (iPhone profile)</a></li>
<li>Settings → Profile Downloaded → Install</li>
<li>Settings → General → About → Certificate Trust Settings → enable <em>Pairfob local CA</em></li>
{extra}
</ol>
<p>Fallback: <a href="/ca.cer">pairfob-local-ca.cer</a> (must install as a certificate authority, never as a personal cert).</p>
</body>"""
                body = html.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)

    httpd = ThreadingHTTPServer((args.listen, args.port), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
