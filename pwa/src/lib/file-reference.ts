/** A reference is only a candidate. The daemon's workspace root remains authoritative. */
export type FileReference = { path: string; line?: number; column?: number };

export function parseFileReference(value: string, encoding: 'path' | 'url' = 'path'): FileReference | null {
  let path = value.trim();
  if (!path || path.length > 4096 || /[\u0000-\u001f\\]/.test(path)) return null;
  // A local file URI names a file on the paired computer, never on the phone.
  // Inspect the raw path rather than URL.pathname, which normalizes traversal.
  if (/^file:/i.test(path)) {
    const local = /^file:(?:\/\/(?:localhost)?(?=\/))?(\/.*)$/i.exec(path);
    if (!local) return null;
    path = local[1];
    encoding = 'url';
  }
  const suffix = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/.exec(path);
  const line = suffix ? Number(suffix[1] || suffix[3]) : undefined;
  const column = suffix && (suffix[2] || suffix[4]) ? Number(suffix[2] || suffix[4]) : undefined;
  if (suffix) path = path.slice(0, suffix.index);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) return null;
  if (encoding === 'url') {
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  if (/[\u0000-\u001f\\?#:]/.test(path) || path.startsWith('//')) return null;
  const explicit = /^(?:\/|~\/|\.\/)/.test(path);
  path = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path === '~') return null;
  const parts = path.split('/');
  if (parts.some((part, i) => part === '..' || part === '.' || part === '.git' || (!part && i > 0))) return null;
  const name = parts.at(-1)!;
  if (!explicit && !/[^/]*\.[a-z][\w.-]*$/i.test(name) && !/^(Dockerfile|Makefile|LICENSE|README)$/i.test(name)) return null;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function workspaceReferencePath(reference: FileReference, root: string): string | null {
  if (!root.startsWith('/') || reference.path.startsWith('~/')) return null;
  if (reference.path === root.replace(/\/+$/, '')) return '';
  const prefix = root.replace(/\/+$/, '') + '/';
  const path = reference.path.startsWith('/')
    ? reference.path.startsWith(prefix) ? reference.path.slice(prefix.length) : null
    : reference.path;
  return path && parseFileReference(`./${path}`)?.path === path ? path : null;
}

// Rooted paths may name directories or extensionless files. Relative prose
// remains conservative: it needs a filename extension and a directory separator.
const segment = String.raw`[\p{L}\p{N}_@.%~-]+`;
const location = String.raw`(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?`;
const rooted = String.raw`(?:file:\/\/(?:localhost)?\/|~\/|\/)${segment}(?:\/${segment})*\/?`;
const relative = String.raw`(?:\.?\.?\/)?${segment}(?:\/${segment})*\.[a-z\d][\w.-]*`;
const spacedPathPrefix = new RegExp(String.raw`(?:^|[ \t])(?:~\/|\.?\.?\/|\/)?${segment}(?:\/${segment})+[ \t]+(?:${segment}[ \t]+)*$`, 'u');
const prosePaths = new RegExp(String.raw`(?:${rooted}|${relative})${location}`, 'giu');

/** Run after sanitizing. Never turn code blocks, URLs or existing links into nested links. */
export function linkFileText(root: ParentNode): void {
  const walk = (node: Node): void => {
    if (node.nodeType === 1 && ['A', 'PRE'].includes((node as Element).tagName)) return;
    if (node.nodeType !== 3) { for (const child of [...node.childNodes]) walk(child); return; }
    const text = node.textContent || '';
    const inline = node.parentElement?.tagName === 'CODE';
    const candidates = inline ? [{ value: text, start: 0 }] : [...text.matchAll(prosePaths)].map(match => ({
      value: match[0].replace(/\.+$/, ''), start: match.index!,
    }));
    // A spaced filename cannot be delimited reliably in prose. If a rooted
    // directory fragment runs into an unrooted filename, leave the whole span
    // alone; inline code and explicit links provide unambiguous boundaries.
    const ambiguous = new Set<number>();
    if (!inline) for (let i = 0; i + 1 < candidates.length; i++) {
      const a = candidates[i], b = candidates[i + 1];
      const gap = text.slice(a.start + a.value.length, b.start);
      if (/^(?:~?\/|\.\/)/.test(a.value)
        && !/^(?:~?\/|\.\/|file:)/i.test(b.value) && /^[ \t]+[\p{L}\p{N}_ .%-]*$/u.test(gap)) {
        ambiguous.add(i); ambiguous.add(i + 1);
      }
    }
    let offset = 0;
    const out = document.createDocumentFragment();
    for (const [index, { value: candidate, start }] of candidates.entries()) {
      if (ambiguous.has(index)) continue;
      if (!inline && !/^(?:~?\/|\.\/|file:)/i.test(candidate) && spacedPathPrefix.test(text.slice(Math.max(0, start - 4096), start))) continue;
      const ref = parseFileReference(candidate);
      // Bare prose requires a directory separator; inline code can name a basename.
      if (inline && !candidate.includes('/') && !/^(?:\.[\w.-]+|Dockerfile|Makefile|LICENSE|README|.+\.(?:html?|md|txt|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|css|scss|sass|go|py|rs|java|c|h|cpp|sh|sql|xml|svg|png|jpe?g|webp|gif|pdf|log|lock))(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/i.test(candidate)) continue;
      if (start < 0 || !ref || (!inline && (!candidate.includes('/') || /[\w:/@.-]/.test(text[start - 1] || '')))) continue;
      out.append(text.slice(offset, start));
      const link = document.createElement('a');
      link.setAttribute('href', '#file');
      link.setAttribute('data-file-ref', candidate);
      link.textContent = candidate;
      out.append(link);
      offset = start + candidate.length;
    }
    if (offset) { out.append(text.slice(offset)); node.parentNode?.replaceChild(out, node); }
  };
  walk(root as Node);
}
