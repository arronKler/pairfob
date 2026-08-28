import { marked } from "marked";
import remend from "remend";
import { node } from "./dom";

marked.use({ gfm: true, breaks: false });

const CACHE_LIMIT = 32;
const cache = new Map<string, string>();

const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "LINK", "META", "BASE"]);
const KEEP = new Set([
  "A", "P", "BR", "STRONG", "EM", "B", "I", "U", "S", "DEL", "CODE", "PRE", "KBD",
  "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "HR", "IMG", "SPAN", "DIV",
  "SUP", "SUB", "INPUT",
]);
const ATTRS: Record<string, Set<string>> = {
  A: new Set(["href", "title"]),
  IMG: new Set(["src", "alt", "title"]),
  TH: new Set(["align", "colspan", "rowspan"]),
  TD: new Set(["align", "colspan", "rowspan"]),
  CODE: new Set(["class"]),
  PRE: new Set(["class"]),
  INPUT: new Set(["type", "checked", "disabled"]),
};

function safeHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value.trim());
}

function scrub(root: ParentNode): void {
  for (const raw of [...root.querySelectorAll("*")]) {
    const el = raw as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    if (!KEEP.has(tag)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const allowed = ATTRS[tag] ?? new Set<string>();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || !allowed.has(name)) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      if (!safeHref(href)) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
    if (tag === "IMG") {
      const src = el.getAttribute("src") || "";
      if (!/^https?:/i.test(src.trim())) el.removeAttribute("src");
    }
    if (tag === "INPUT") {
      if (el.getAttribute("type") !== "checkbox") el.remove();
      else el.setAttribute("disabled", "");
    }
  }
}

function remember(source: string, html: string): string {
  cache.set(source, html);
  if (cache.size <= CACHE_LIMIT) return html;
  const first = cache.keys().next().value;
  if (first !== undefined) cache.delete(first);
  return html;
}

export function renderMarkdown(source: string): string {
  const text = source.trimEnd();
  if (!text) return "";
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const template = document.createElement("template");
  template.innerHTML = marked.parse(remend(text), { async: false });
  scrub(template.content);
  return remember(text, template.innerHTML);
}

export function markdownEl(source: string, className = "agent-md"): HTMLElement {
  const el = node("div", className);
  el.innerHTML = renderMarkdown(source);
  return el;
}
