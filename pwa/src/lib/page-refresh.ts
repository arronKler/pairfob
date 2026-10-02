/**
 * Prime a unique navigation URL before leaving the current page. The shipped
 * service worker caches successful reads by URL, so its short navigation grace
 * period can fall back only to this freshly fetched shell, even on a slow link.
 * This also works with older workers; no credential or cache deletion is needed.
 */
export async function preparePageRefresh(currentURL: string, signal: AbortSignal): Promise<string> {
  const url = new URL(currentURL);
  url.hash = "";
  url.searchParams.set("_pairfob_refresh", crypto.randomUUID());
  const response = await fetch(url.href, { cache: "no-store", signal });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Page unavailable");
  }
  const html = new DOMParser().parseFromString(await response.text(), "text/html");
  if (!html.querySelector('script[type="module"][src]')) throw new Error("App entry unavailable");
  const assets = new Set<string>();
  for (const node of html.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]')) {
    const asset = new URL(node.getAttribute("src") || node.getAttribute("href")!, url);
    if (asset.origin === url.origin) assets.add(asset.href);
  }
  await Promise.all([...assets].map(async (asset) => {
    const result = await fetch(asset, { cache: "no-store", signal });
    if (!result.ok) throw new Error("App asset unavailable");
    await result.arrayBuffer();
  }));
  if (signal.aborted) throw new Error("Refresh cancelled");
  return url.href;
}
