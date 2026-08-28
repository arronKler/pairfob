---
title: How it is wired
description: The phone talks only to pairfob.com. pairfobd on the computer dials out to the relay, then speaks to Herdr on loopback.
---

# How it is wired

You only see three things: a web app, a background process on the computer, and the Herdr you already use. The relay in the middle does not run agents.

```
Pairfob PWA on a phone / tablet / other computer
        │
        │  HTTPS static assets (/, /pair, /doc)
        │  WSS session (ciphertext)
        ▼
   pairfob.com
   marketing · docs · web app · frame relay
        ▲
        │  long-lived connection, computer dials out
        │
   pairfobd (on your computer only)
        │
        │  loopback / Unix socket
        ▼
      Herdr  →  the real PTYs for Codex / Claude / Grok
```

## What each hop does

| Hop | Does | Does not |
| --- | --- | --- |
| Web app `/pair` | Pair, list, paint the pane, system keyboard, turn taps into RPC | Run agents, store your source |
| `pairfob.com` | Serve the web UI; forward ciphertext frames to the right computer; enroll computers | Parse session content, talk to Herdr |
| `pairfobd` | Hold identity and keys; dial out; turn RPC into Herdr calls | Listen on the public internet |
| Herdr | Real sessions, PTYs, agents | Know that a phone exists |

The public path is default-deny. A client-claimed device name is a label, not an admit ticket.

## Protocol

Envelope bytes stay `pairfob.v1`. Mux is `pairfob.v2`: locator, pair ticket, one room per daemon. **Do not** set `PAIRFOB_JOIN_TOKEN`. One `pairfobd` talks to `pairfob.com`.

## Same origin for the web

`https://pairfob.com/` is the marketing site, `/doc` is this documentation, `/pair` is the app. QR codes and typed entry point at this origin, so pairing does not jump to a third host.

The computer always dials out. Home firewalls only need outbound HTTPS to `pairfob.com`.

## When you want the source of truth

The frozen surface in the repo is `proto/envelope.md`, `proto/rpc.schema.json`, and the vector files. These docs do not repeat field names, so they cannot drift into a second protocol. If the protocol or a cross-language primitive changes, vectors and schema win over the diagram on this page.
