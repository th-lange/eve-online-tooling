// Reference plugin UI (TypeScript). It runs this plugin's own `evaluate` WASM
// export through the host bridge and renders the result.
//
// The app serves static files as-is (no build step), so the committed `main.js`
// is what actually runs. Regenerate it from this source with any bundler, e.g.:
//
//   esbuild main.ts --format=esm --outfile=main.js
//
import { invoke } from "./plugin-ui-sdk.js";

/** Mirrors the Rust plugin's `Evaluation` return type. */
interface Evaluation {
  name: string;
  volume: number;
  score: number;
  evaluations: number;
}

const form = document.querySelector("#eval") as HTMLFormElement;
const input = document.querySelector("#typeId") as HTMLInputElement;
const out = document.querySelector("#out") as HTMLDivElement;

form.addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const typeId = Number(input.value);
  if (!Number.isFinite(typeId)) return;
  out.textContent = "Evaluating…";
  try {
    // The type id goes as a *number*: the host serialises it to the bare bytes
    // the WASM `evaluate(type_id: String)` reads. `invoke` reaches only this
    // plugin's own logic, gated by its granted `sde:read` capability.
    const r = await invoke<Evaluation>("evaluate", typeId);
    out.innerHTML =
      `<strong>${r.name}</strong> — ${r.volume} m³ · ` +
      `score ${r.score} · evaluated ${r.evaluations}×`;
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});
