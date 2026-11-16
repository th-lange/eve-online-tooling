// A small, dependency-free Markdown parser for note previews. It produces a
// plain AST that MarkdownView turns into React elements — never HTML strings —
// so a note's content (which may arrive via a shared folder from elsewhere)
// can't inject markup or scripts. Covers the everyday subset: headings,
// paragraphs, bold/italic/strike/inline code, links, fenced code, quotes,
// bullet/numbered/task lists (flat) and rules. Everything else shows as text.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "b" | "i" | "s"; children: Inline[] }
  | { t: "a"; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  /** Present for `- [ ]` / `- [x]` task items. */
  checked?: boolean;
}

export type Block =
  | { t: "h"; level: number; children: Inline[] }
  | { t: "p"; lines: Inline[][] }
  | { t: "code"; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "ul" | "ol"; items: ListItem[] }
  | { t: "hr" };

/** Only web and mail links are ever made clickable. */
export function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

const CODE = /`([^`\n]+)`/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const BOLD = /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/y;
const STRIKE = /~~(?=\S)([\s\S]+?)(?<=\S)~~/y;
const ITALIC = /(\*|_)(?=\S)([^*_\n]+?)(?<=\S)\1/y;

function matchAt(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ t: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    let m: RegExpExecArray | null;
    if ((m = matchAt(CODE, text, i))) {
      flush();
      out.push({ t: "code", text: m[1] });
    } else if ((m = matchAt(LINK, text, i))) {
      flush();
      const href = safeHref(m[2]);
      const children = parseInline(m[1]);
      if (href) out.push({ t: "a", href, children });
      else out.push(...children);
    } else if ((m = matchAt(BOLD, text, i))) {
      flush();
      out.push({ t: "b", children: parseInline(m[2]) });
    } else if ((m = matchAt(STRIKE, text, i))) {
      flush();
      out.push({ t: "s", children: parseInline(m[1]) });
    } else if (
      (m = matchAt(ITALIC, text, i)) &&
      // `snake_case_names` must not turn italic.
      !(m[1] === "_" && i > 0 && /\w/.test(text[i - 1]))
    ) {
      flush();
      out.push({ t: "i", children: parseInline(m[2]) });
    } else {
      plain += text[i];
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    UL.test(line) ||
    OL.test(line)
  );
}

function listItem(text: string): ListItem {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  return task
    ? { children: parseInline(task[2]), checked: task[1] !== " " }
    : { children: parseInline(text) };
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
    } else if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      blocks.push({ t: "code", text: body.join("\n") });
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      blocks.push({ t: "h", level: m[1].length, children: parseInline(m[2]) });
      i++;
    } else if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i++])![1]);
      }
      blocks.push({ t: "quote", blocks: parseBlocks(inner.join("\n")) });
    } else if (UL.test(line) || OL.test(line)) {
      const re = UL.test(line) ? UL : OL;
      const items: ListItem[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(listItem(re.exec(lines[i++])![1]));
      }
      blocks.push({ t: re === UL ? "ul" : "ol", items });
    } else {
      const para: Inline[][] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !startsBlock(lines[i])
      ) {
        para.push(parseInline(lines[i++].trim()));
      }
      // `line` itself isn't a block start here, so `para` is never empty.
      blocks.push({ t: "p", lines: para });
    }
  }
  return blocks;
}
