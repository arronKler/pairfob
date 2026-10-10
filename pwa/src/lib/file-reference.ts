/** A reference is only a candidate. The daemon's workspace root remains authoritative. */
export type FileReference = { path: string; line?: number; column?: number };

export function parseFileReference(value: string): FileReference | null {
  let path = value.trim();
  if (!path || path.length > 4096 || /[\u0000-\u001f\\]/.test(path)) return null;
  const suffix = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/.exec(path);
  const line = suffix ? Number(suffix[1] || suffix[3]) : undefined;
  const column = suffix && (suffix[2] || suffix[4]) ? Number(suffix[2] || suffix[4]) : undefined;
  if (suffix) path = path.slice(0, suffix.index);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) return null;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/[\u0000-\u001f\\?#:]/.test(path) || path.startsWith('//')) return null;
  path = path.replace(/^\.\//, '');
  const parts = path.split('/');
  if (parts.some((part, i) => part === '..' || part === '.' || part === '.git' || (!part && i > 0))) return null;
  const name = parts.at(-1)!;
  if (!/[^/]*\.[a-z][\w.-]*$/i.test(name) && !/^(Dockerfile|Makefile|LICENSE|README)$/i.test(name)) return null;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function workspaceReferencePath(reference: FileReference, root: string): string | null {
  if (!root.startsWith('/')) return null;
  const prefix = root.replace(/\/+$/, '') + '/';
  const path = reference.path.startsWith('/')
    ? reference.path.startsWith(prefix) ? reference.path.slice(prefix.length) : null
    : reference.path;
  return path && parseFileReference(path)?.path === path ? path : null;
}

/** Run after sanitizing. Never turn code blocks, URLs or existing links into nested links. */
export function linkFileText(root: ParentNode): void {
  const walk = (node: Node): void => {
    if (node.nodeType === 1 && ['A', 'PRE'].includes((node as Element).tagName)) return;
    if (node.nodeType !== 3) { for (const child of [...node.childNodes]) walk(child); return; }
    const text = node.textContent || '';
    const inline = node.parentElement?.tagName === 'CODE';
    const candidates = inline ? [text] : text.match(/(?:\.?\.?\/|\/)?[\p{L}\p{N}_@.-]+(?:\/[\p{L}\p{N}_@.-]+)*\.[a-z\d][\w.-]*(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/giu) || [];
    let offset = 0;
    const out = document.createDocumentFragment();
    for (const candidate of candidates) {
      const start = text.indexOf(candidate, offset);
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
