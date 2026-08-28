function copyLabel() {
  const en =
    (window.PairfobLang && PairfobLang.get() === "en") || document.documentElement.lang.startsWith("en");
  return en
    ? { idle: "Copy", done: "Copied", fail: "Copy failed" }
    : { idle: "复制", done: "已复制", fail: "复制失败" };
}

function idleCopyButtons() {
  document.querySelectorAll(".copy").forEach((button) => {
    if (button.dataset.copied) return;
    if (button.hasAttribute("data-i18n") && button.getAttribute("data-i18n") === "start.copy") {
      return;
    }
    button.textContent = copyLabel().idle;
  });
}

document.querySelectorAll(".copy").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") || "";
    const labels = copyLabel();
    try {
      await navigator.clipboard.writeText(text);
      trackCopy(text);
      button.dataset.copied = "1";
      button.textContent = labels.done;
      window.setTimeout(() => {
        delete button.dataset.copied;
        button.textContent = copyLabel().idle;
      }, 1400);
    } catch {
      button.textContent = labels.fail;
    }
  });
});

window.addEventListener("pairfob-lang", idleCopyButtons);

function trackCopy(text) {
  const extra = text.includes("install.sh")
    ? "install"
    : text.includes("pairfobd pair")
      ? "pair_cli"
      : text.includes("/pair")
        ? "pair_url"
        : "other";
  const body = JSON.stringify({ v: 2, events: [{ name: "site_copy", extra }] });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/v2/events", blob)) return;
    }
  } catch {
    /* ignore */
  }
  fetch("/v2/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
    credentials: "same-origin",
  }).catch(function () {});
}
