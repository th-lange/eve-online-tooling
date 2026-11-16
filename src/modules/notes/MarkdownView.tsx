import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseBlocks, type Block, type Inline } from "./markdown";

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.text}</Fragment>;
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-zinc-800 px-1 py-0.5 text-[0.85em]"
          >
            {n.text}
          </code>
        );
      case "b":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "i":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "s":
        return <s key={i}>{renderInline(n.children)}</s>;
      case "a":
        return (
          <a
            key={i}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              // Never navigate the app webview; hand the link to the OS.
              e.preventDefault();
              void openUrl(n.href).catch((err) =>
                console.error("Opening link failed", err),
              );
            }}
            className="text-indigo-400 underline hover:text-indigo-300"
          >
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

const HEADING_CLASS = [
  "",
  "text-2xl font-semibold",
  "text-xl font-semibold",
  "text-lg font-semibold",
  "text-base font-semibold",
  "text-sm font-semibold",
  "text-sm font-medium text-zinc-400",
];

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "h": {
      const Tag = `h${b.level}` as "h1";
      return (
        <Tag
          key={key}
          className={`mt-4 mb-2 text-zinc-100 ${HEADING_CLASS[b.level]}`}
        >
          {renderInline(b.children)}
        </Tag>
      );
    }
    case "p":
      return (
        <p key={key} className="my-2">
          {b.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      );
    case "code":
      return (
        <pre
          key={key}
          className="my-2 overflow-auto rounded bg-zinc-900 p-2 text-xs"
        >
          <code>{b.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400"
        >
          {b.blocks.map(renderBlock)}
        </blockquote>
      );
    case "ul":
    case "ol": {
      const Tag = b.t;
      return (
        <Tag
          key={key}
          className={`my-2 ml-5 ${b.t === "ul" ? "list-disc" : "list-decimal"}`}
        >
          {b.items.map((item, i) => (
            <li
              key={i}
              className={item.checked !== undefined ? "-ml-5 list-none" : ""}
            >
              {item.checked !== undefined && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  disabled
                  className="mr-2 align-middle"
                />
              )}
              {renderInline(item.children)}
            </li>
          ))}
        </Tag>
      );
    }
    case "hr":
      return <hr key={key} className="my-4 border-zinc-700" />;
  }
}

/** Read-only rendering of a Markdown note. Builds React elements from a parsed
 *  AST — never injects HTML — so note content can't run script. */
export function MarkdownView({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    return <p className="text-sm text-zinc-500">Nothing to preview yet.</p>;
  }
  return (
    <div className="text-sm leading-relaxed text-zinc-300">
      {blocks.map(renderBlock)}
    </div>
  );
}
