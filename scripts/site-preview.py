#!/usr/bin/env python3
"""Serve the marketing site and the VitePress doc build on one origin."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class SiteHandler(SimpleHTTPRequestHandler):
    doc_root: str = ""

    def translate_path(self, path: str) -> str:
        url_path = unquote(urlparse(path).path)
        # Mirrors the worker: one document serves both locales, English at the root.
        if url_path in ("/zh", "/zh/", "/zh/index.html"):
            return str(Path(self.directory) / "index.html")
        if url_path == "/doc" or url_path.startswith("/doc/"):
            rel = url_path[len("/doc") :].lstrip("/")
            doc = Path(self.doc_root)
            candidate = doc / rel
            if candidate.is_file():
                return str(candidate)
            if (not rel or rel.endswith("/")) and (doc / rel / "index.html").is_file():
                return str(doc / rel / "index.html")
            html = candidate.with_suffix(".html") if rel and not candidate.suffix else candidate
            if html.is_file():
                return str(html)
            if (candidate / "index.html").is_file():
                return str(candidate / "index.html")
            return str(candidate)
        mapped = super().translate_path(path)
        target = Path(mapped)
        if target.exists():
            return mapped
        html = target.with_name(target.name + ".html")
        return str(html) if html.is_file() else mapped


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--doc-dir", required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    SiteHandler.doc_root = str(Path(args.doc_dir).resolve())
    root = Path(args.dir).resolve()
    handler = partial(SiteHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"site preview http://127.0.0.1:{args.port}/  ({root})", flush=True)
    print(f"doc          http://127.0.0.1:{args.port}/doc/  ({SiteHandler.doc_root})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
