// Compiled from main.ts (types stripped). This is the module the app serves.
import { invoke } from "./plugin-ui-sdk.js";

const form = document.querySelector("#eval");
const input = document.querySelector("#typeId");
const out = document.querySelector("#out");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const typeId = Number(input.value);
  if (!Number.isFinite(typeId)) return;
  out.textContent = "Evaluating…";
  try {
    // The type id goes as a number: the host serialises it to the bare bytes
    // the WASM `evaluate(type_id: String)` reads. `invoke` reaches only this
    // plugin's own logic, gated by its granted `sde:read` capability.
    const r = await invoke("evaluate", typeId);
    out.innerHTML =
      `<strong>${r.name}</strong> — ${r.volume} m³ · ` +
      `score ${r.score} · evaluated ${r.evaluations}×`;
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
});
