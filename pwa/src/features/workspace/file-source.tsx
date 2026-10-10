import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';
import { highlightSource } from '../../lib/syntax-highlight';

export function FileSource({ path, content, wrap, line, reveal = false }: { path: string; content: string; wrap: boolean; line: number | null; reveal?: boolean }) {
  const root = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => {
    const out: ReturnType<typeof highlightSource>[] = [[]];
    for (const token of highlightSource(path, content)) {
      const parts = token.text.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) out.push([]);
        const text = index < parts.length - 1 ? `${part}\n` : part;
        if (text) out[out.length - 1].push({ ...token, text });
      });
    }
    if (out.length > 1 && !out.at(-1)?.length) out.pop();
    return out;
  }, [path, content]);
  useLayoutEffect(() => {
    if (line) root.current?.querySelector(`[data-source-line="${line}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [line, content]);
  return <pre ref={root} className={`workspace-code${wrap ? ' is-wrap' : ''}${reveal ? ' workspace-reveal' : ''}`}>
    <code className="workspace-highlight">{lines.map((tokens, index) => <span key={index}
      data-source-line={index + 1} className={`workspace-code-line${line === index + 1 ? ' is-target' : ''}`}>
      {tokens.map((token, part) => <Fragment key={part}>{token.kind
        ? <span className={`syntax-${token.kind}`}>{token.text}</span> : token.text}</Fragment>)}
    </span>)}</code>
  </pre>;
}
