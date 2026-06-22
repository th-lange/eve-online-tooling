// Production module landing page. The ranked profit table (issue #7) and its
// data wiring (issues #4–#6) land here; for now this is the registered
// placeholder that proves the module shell renders.
export function ProductionPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-zinc-100">Production</h1>
      <p className="mt-2 max-w-2xl text-zinc-400">
        Rank manufacturable items by profit — what you'd make building and
        selling them versus selling the inputs. Coming next: log in, read your
        assets &amp; blueprints, fetch market prices, and show a ranked table
        with a per-material cost breakdown.
      </p>
    </div>
  );
}
