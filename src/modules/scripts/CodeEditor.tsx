import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { SCRIPT_API } from "./apiCatalog";

const OPTIONS = SCRIPT_API.map((e) => ({
  label: e.label,
  type: "function",
  detail: e.signature,
  info: e.doc,
}));

/** Complete the script host/stdlib API by identifier prefix. */
function scriptApiCompletions(
  context: CompletionContext,
): CompletionResult | null {
  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: OPTIONS };
}

/**
 * The snippet code editor: CodeMirror with JS-style syntax highlighting (also
 * fine for Rhai) and autocompletion for the script API, so the editor hints the
 * available functions and their signatures as you type.
 */
export function CodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      height="320px"
      extensions={[
        javascript(),
        autocompletion({ override: [scriptApiCompletions] }),
      ]}
      className="overflow-hidden rounded border border-zinc-700 text-sm"
    />
  );
}
