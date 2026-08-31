---
title: 这是什么
description: Pairfob 把电脑上 Herdr 里已经在跑的 agent，接到手机或其他设备上接着操作。
pageClass: pf-intro
---

# 这是什么

<p class="pf-lede">你在电脑上用 <a href="https://herdr.dev">Herdr</a> 跑 Codex、Claude、Grok。配对一次之后，手机、平板或另一台电脑打开 Pairfob，接上的是<strong>同一批真实会话</strong>。</p>

<IntroPath></IntroPath>

<div class="pf-claims">
  <article>
    <p class="pf-claim-t">同一块屏幕</p>
    <p>手机上点的确认、打的字、开的分屏，电脑上立刻就是；反过来也一样。</p>
  </article>
  <article>
    <p class="pf-claim-t">出门不用同步</p>
    <p>Agent 一直在电脑上跑。打开手机就是那个会话。坐回工位不需要「同步回桌面」，也不用关掉远程窗口。</p>
  </article>
  <article>
    <p class="pf-claim-t">电脑做得到的才画</p>
    <p>新建、分屏、worktree、控制 / 终端 / 对话，都以电脑当时为准。做不到的，手机上不会出现，也不会假装成功。</p>
  </article>
  <article>
    <p class="pf-claim-t">家里不开端口</p>
    <p>电脑自己连出去。不绑 Tailscale，不把 Herdr 暴露到公网。配对完成后，内容是加密的。</p>
  </article>
</div>

## 和这些不是一回事

<div class="pf-vs">
  <div class="pf-vs-head">
    <span>它不是</span>
    <span aria-hidden="true"></span>
    <span>实际是</span>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">浏览器里再开一个终端</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">打开电脑上已经在跑的会话</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">远程桌面 / VNC / 投屏</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">只接会话，不搬整个桌面</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">把 agent 搬到云上</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">agent 仍在你电脑上跑</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">精简版手机专用 agent</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">电脑当时能做的，手机上也能做</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">账号登录</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">配对是授权，凭证只在这台浏览器里</p>
  </div>
  <div class="pf-vs-row">
    <p class="pf-vs-not" data-not="不是">VPN / Tailscale</p>
    <span class="pf-vs-arrow" aria-hidden="true">→</span>
    <p class="pf-vs-is">电脑主动连出去，家里不用开端口</p>
  </div>
</div>

更展开一点见 [同一块屏幕](/zh/model)。

## 适合谁

电脑上已经在用 Herdr 0.7 或更高版本跑 coding agent，又希望：

- 离开工位时用手机接着写、确认对话框、开 worktree
- 坐回来什么都不用同步
- 家里路由器不用做端口转发，也不想为这个去绑远程网络

目前支持 **macOS 和 Linux**。Windows 还不能装 `pairfob`。

## 最短路径

<ol class="pf-track">
<li><p>电脑上装好 Herdr；pairfob 启动时会拉起它</p></li>
<li><p><a href="./install">安装</a> <code>pairfob</code>：<code>curl -fsSL https://pairfob.com/install.sh | sh</code></p></li>
<li><p>电脑执行 <code>pairfob pair</code>，另一台设备打开 <a href="/pair">pairfob.com/pair</a></p></li>
<li><p>手机扫码后，在电脑终端按一次 Enter 确认</p></li>
</ol>

然后看 [开始使用](/zh/start)、[配对](/zh/pair)、[出门和回来](/zh/continue)。卡住了先看 [常见问题](/zh/faq) 和 [排查](/zh/troubleshoot)。
