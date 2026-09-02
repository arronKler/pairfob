export type SyntaxTokenKind = "comment" | "keyword" | "literal" | "number" | "property" | "string" | "tag";

export type SyntaxToken = { text: string; kind?: SyntaxTokenKind };

type Language =
  | "css"
  | "go"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "toml"
  | "yaml";

type Profile = {
  language: Language;
  keywords: Set<string>;
  literals: Set<string>;
  lineComments: string[];
  blockComments: Array<[string, string]>;
  quotes: string[];
};

const MAX_HIGHLIGHT_TOKENS = 6_000;
const COMMON_LITERALS = new Set(["false", "nil", "null", "true", "undefined"]);
const KEYWORDS: Record<Language, string> = {
  css: "@charset @container @font-face @import @keyframes @layer @media @page @property @scope @supports from to",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  html: "",
  javascript: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch throw try type typeof var void while with yield",
  json: "",
  markdown: "",
  python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  shell: "case do done elif else esac export fi for function if in local readonly return set shift then until while",
  sql: "add alter and as asc begin between by case commit create database default delete desc distinct drop else end exists from full group having in index inner insert into is join left like limit not null on or order outer primary references right rollback select set table then union unique update values view when where with",
  toml: "",
  yaml: "",
};

const EXTENSIONS: Record<string, Language> = {
  cjs: "javascript", css: "css", go: "go", htm: "html", html: "html", js: "javascript", json: "json", jsonc: "json",
  jsx: "javascript", md: "markdown", mdx: "markdown", mjs: "javascript", py: "python", rs: "rust", scss: "css", sh: "shell",
  sql: "sql", toml: "toml", ts: "javascript", tsx: "javascript", xhtml: "html", xml: "html", yaml: "yaml", yml: "yaml",
};

function languageForPath(path: string): Language | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (["dockerfile", "makefile"].includes(name) || name.startsWith("dockerfile.")) return "shell";
  if (["go.mod", "go.sum"].includes(name)) return "go";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXTENSIONS[extension] ?? null;
}

function profileFor(language: Language): Profile {
  const hashComment = ["python", "shell", "toml", "yaml"].includes(language);
  const sqlComment = language === "sql";
  return {
    language,
    keywords: new Set(KEYWORDS[language].split(" ").filter(Boolean).map((word) => language === "sql" ? word.toLowerCase() : word)),
    literals: COMMON_LITERALS,
    lineComments: hashComment ? ["#"] : sqlComment ? ["--"] : ["javascript", "go", "rust"].includes(language) ? ["//"] : [],
    blockComments: ["javascript", "go", "rust", "css", "sql"].includes(language) ? [["/*", "*/"]] : language === "html" ? [["<!--", "-->"]] : [],
    quotes: language === "json" ? ["\""] : ["'", "\"", ...(language === "javascript" ? ["`"] : [])],
  };
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[\w$-]/u.test(character);
}

function nextNonWhitespace(source: string, start: number): string {
  for (let index = start; index < source.length; index++) {
    if (!/\s/u.test(source[index])) return source[index];
  }
  return "";
}

function stringEnd(source: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index + 1;
  }
  return source.length;
}

function tokenKindForWord(profile: Profile, word: string, source: string, end: number): SyntaxTokenKind | undefined {
  const normalized = profile.language === "sql" ? word.toLowerCase() : word;
  if (profile.keywords.has(normalized)) return "keyword";
  if (profile.literals.has(normalized)) return "literal";
  if (["css", "json", "toml", "yaml"].includes(profile.language) && nextNonWhitespace(source, end) === ":") return "property";
  return undefined;
}

function markdownToken(source: string, index: number): { end: number; kind: SyntaxTokenKind } | null {
  const lineStart = index === 0 || source[index - 1] === "\n";
  if (lineStart) {
    const marker = source.slice(index).match(/^(?:#{1,6}(?=\s)|```+|~~~+)/u)?.[0];
    if (marker) return { end: index + marker.length, kind: "keyword" };
  }
  if (source[index] === "`") {
    const end = source.indexOf("`", index + 1);
    return { end: end < 0 ? source.length : end + 1, kind: "string" };
  }
  return null;
}

function markupToken(source: string, index: number): { end: number; kind: SyntaxTokenKind } | null {
  if (source[index] !== "<") return null;
  let quote = "";
  for (let end = index + 1; end < source.length; end++) {
    const character = source[end];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "'" || character === "\"") quote = character;
    else if (character === ">") return { end: end + 1, kind: "tag" };
  }
  return { end: source.length, kind: "tag" };
}

/** A bounded, dependency-free lexer. Consumers must render token text via textContent. */
export function highlightSource(path: string, source: string): SyntaxToken[] {
  const language = languageForPath(path);
  if (!language || !source) return source ? [{ text: source }] : [];
  const profile = profileFor(language);
  const tokens: SyntaxToken[] = [];
  const push = (text: string, kind?: SyntaxTokenKind): void => {
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous && previous.kind === kind) previous.text += text;
    else tokens.push(kind ? { text, kind } : { text });
  };
  let index = 0;
  while (index < source.length) {
    if (tokens.length >= MAX_HIGHLIGHT_TOKENS) {
      push(source.slice(index));
      break;
    }
    const block = profile.blockComments.find(([start]) => source.startsWith(start, index));
    if (block) {
      const found = source.indexOf(block[1], index + block[0].length);
      const end = found < 0 ? source.length : found + block[1].length;
      push(source.slice(index, end), "comment");
      index = end;
      continue;
    }
    const line = profile.lineComments.find((marker) => source.startsWith(marker, index));
    if (line) {
      const found = source.indexOf("\n", index + line.length);
      const end = found < 0 ? source.length : found;
      push(source.slice(index, end), "comment");
      index = end;
      continue;
    }
    const special = language === "markdown" ? markdownToken(source, index) : language === "html" ? markupToken(source, index) : null;
    if (special) {
      push(source.slice(index, special.end), special.kind);
      index = special.end;
      continue;
    }
    const character = source[index];
    if (profile.quotes.includes(character)) {
      const end = stringEnd(source, index, character);
      const kind = language === "json" && nextNonWhitespace(source, end) === ":" ? "property" : "string";
      push(source.slice(index, end), kind);
      index = end;
      continue;
    }
    if (/\d/u.test(character) && (index === 0 || !isIdentifierPart(source[index - 1]))) {
      const number = source.slice(index).match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/iu)?.[0];
      if (number) {
        push(number, "number");
        index += number.length;
        continue;
      }
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end])) end++;
      const word = source.slice(index, end);
      push(word, tokenKindForWord(profile, word, source, end));
      index = end;
      continue;
    }
    push(character);
    index++;
  }
  return tokens;
}
