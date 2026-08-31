---
title: What it is
description: Pairfob continues the Herdr agents already running on your computer, on your phone or another device.
pageClass: pf-intro
---

# What it is

<p class="pf-lede">You run Codex, Claude, or Grok on the computer with <a href="https://herdr.dev">Herdr</a>. After pairing once, a phone, tablet, or another computer opens Pairfob and attaches to <strong>the same live sessions</strong>.</p>

<IntroPath></IntroPath>

<div class="pf-claims">
  <article>
    <p class="pf-claim-t">The same screen</p>
    <p>Confirms, keystrokes, and splits on the phone land on the computer immediately — and the other way around.</p>
  </article>
  <article>
    <p class="pf-claim-t">Leave without a sync step</p>
    <p>Agents keep running on the computer. Opening the phone is that session. Sitting down again does not need “sync back to the desktop” or tearing down a remote window.</p>
  </article>
  <article>
    <p class="pf-claim-t">Only what the computer can do</p>
    <p>New conversations, splits, worktrees, and 控制 / 终端 / 对话 follow the computer. If it cannot do it, the phone does not draw it and does not pretend it succeeded.</p>
  </article>
  <article>
    <p class="pf-claim-t">No inbound ports at home</p>
    <p>The computer dials out. No Tailscale. Herdr is not exposed to the public internet. After pairing, the session is encrypted.</p>
  </article>
</div>

## What it is not

<div class="pf-vs">
  <div class="pf-vs-head">
    <span>Not this</span>
    <span aria-hidden="true"></span>
    <span>What it is</span>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">Another terminal in the browser</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">Opens the session already running on the computer</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">Remote desktop / VNC / screen share</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">Attaches to sessions, not the whole desktop</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">Agents moved into the cloud</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">Agents still run on your computer</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">A cut-down mobile agent</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">What the computer can do is what the phone can do</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">An account login</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">Pairing is authorization; the credential stays in this browser</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="Not">A VPN / Tailscale</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">The computer dials out; you do not open ports at home</p>
  </div>
</div>

A bit more: [The same screen](/model).

## Who it is for

You already run coding agents in Herdr 0.7 or newer on a computer, and you want to:

- Keep typing, confirm dialogs, and open worktrees from the phone after you leave the desk
- Sit back down with nothing to merge
- Skip port forwarding and extra overlay networks just for this

**macOS and Linux** are supported. Windows cannot host `pairfob` yet.

## Who it is not for

- No Herdr, and you only want a cloud agent on the phone
- You need the entire desktop, browser, or IDE window
- You want Pairfob to keep sessions and keys in the cloud
- The host computer must be Windows (not built yet)

## Shortest path

<ol class="pf-track">
<li><p>Herdr is installed on the computer; pairfob starts it on launch</p></li>
<li><p><a href="./install">Install</a> <code>pairfob</code> with <code>curl -fsSL https://pairfob.com/install.sh | sh</code></p></li>
<li><p>Run <code>pairfob pair</code> on the computer; open <a href="/pair">pairfob.com/pair</a> on the other device</p></li>
<li><p>After the other device scans, press Enter once on the computer</p></li>
</ol>

Then read [Get started](/start), [Pairing](/pair), and [Leave and return](/continue). If something sticks, see [FAQ](/faq) and [Troubleshooting](/troubleshoot).
