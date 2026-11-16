import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotesPage } from "./NotesPage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { NoteEntry, NoteSaveResult, NotesLocation } from "../../lib/api";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function entry(path: string, over: Partial<NoteEntry> = {}): NoteEntry {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name: file.replace(/\.[^.]+$/, ""),
    kind: path.endsWith(".csv") ? "table" : "markdown",
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    tags: [],
    updatedAt: 1000,
    size: 10,
    ...over,
  };
}

interface Backend {
  notes: NoteEntry[];
  folders: string[];
  contents: Record<string, string>;
  location: NotesLocation;
  saveResult?: (path: string) => NoteSaveResult;
}

function install(b: Backend) {
  invokeMock.mockImplementation(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      const path = args.path as string;
      switch (cmd) {
        case "notes_tree":
          return { folders: b.folders, notes: b.notes };
        case "notes_location":
          return b.location;
        case "notes_read":
          return b.contents[path] ?? "";
        case "notes_save": {
          if (b.saveResult) return b.saveResult(path);
          b.contents[path] = args.content as string;
          return { saved: true, entry: entry(path, { updatedAt: 2000 }) };
        }
        case "notes_move": {
          const n = b.notes.find((x) => x.path === path)!;
          const moved = entry(`${args.folder}/${n.name}.md`);
          b.notes = b.notes.map((x) => (x === n ? moved : x));
          return moved;
        }
        case "notes_search":
          return b.notes
            .filter((n) => b.contents[n.path]?.includes(args.query as string))
            .map((n) => ({
              entry: n,
              snippet: `…${b.contents[n.path]}…`,
            }));
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotesPage />
    </QueryClientProvider>,
  );
}

const LOCAL: NotesLocation = {
  root: "/data/notes",
  shared: false,
  localOnly: 0,
};

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
});

function rowNames(): string[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((r) => within(r).getAllByRole("cell")[0].textContent ?? "");
}

describe("NotesPage", () => {
  it("lists notes and re-sorts when a column header is clicked", async () => {
    install({
      notes: [
        entry("b.md", { updatedAt: 3 }),
        entry("a.md", { updatedAt: 1 }),
        entry("c.md", { updatedAt: 2 }),
      ],
      folders: [],
      contents: {},
      location: LOCAL,
    });
    renderPage();
    await screen.findByText("a");
    // The header cell's click target is the button inside it (SortHeaderCell
    // keeps the `<th>` for `aria-sort` only).
    const nameHeader = () =>
      within(screen.getByRole("columnheader", { name: /Name/ })).getByRole(
        "button",
      );
    // Default: most recently modified first.
    expect(rowNames()).toEqual(["b", "c", "a"]);
    fireEvent.click(nameHeader());
    expect(rowNames()).toEqual(["a", "b", "c"]);
    fireEvent.click(nameHeader());
    expect(rowNames()).toEqual(["c", "b", "a"]);
  });

  it("saves edited content guarded by the loaded modification time", async () => {
    const backend: Backend = {
      notes: [entry("plan.md", { updatedAt: 1234 })],
      folders: [],
      contents: { "plan.md": "v1" },
      location: LOCAL,
    };
    install(backend);
    renderPage();
    fireEvent.click(await screen.findByText("plan"));
    const box = await screen.findByLabelText("Note content");
    await waitFor(() => expect(box).toHaveValue("v1"));
    const save = screen.getByRole("button", { name: /Saved/ });
    expect(save).toBeDisabled(); // nothing to save yet

    fireEvent.change(box, { target: { value: "v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("notes_save", {
        shared: null,
        path: "plan.md",
        content: "v2",
        expectedUpdatedAt: 1234,
      }),
    );
  });

  it("offers reload/overwrite instead of clobbering when the file changed elsewhere", async () => {
    install({
      notes: [entry("plan.md", { updatedAt: 1 })],
      folders: [],
      contents: { "plan.md": "mine" },
      location: LOCAL,
      saveResult: (path) => ({
        saved: false,
        entry: entry(path, { updatedAt: 99 }),
      }),
    });
    renderPage();
    fireEvent.click(await screen.findByText("plan"));
    const box = await screen.findByLabelText("Note content");
    await waitFor(() => expect(box).toHaveValue("mine"));
    fireEvent.change(box, { target: { value: "mine, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("changed elsewhere");
    // My edits are still in the box.
    expect(screen.getByLabelText("Note content")).toHaveValue("mine, edited");
    fireEvent.click(
      within(alert).getByRole("button", { name: /Overwrite with mine/ }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "notes_save",
        expect.objectContaining({ path: "plan.md", expectedUpdatedAt: null }),
      ),
    );
  });

  it("moves a note to another folder from the editor's folder picker", async () => {
    install({
      notes: [entry("plan.md")],
      folders: ["Ships"],
      contents: { "plan.md": "x" },
      location: LOCAL,
    });
    renderPage();
    fireEvent.click(await screen.findByText("plan"));
    const select = await screen.findByLabelText("Folder");
    fireEvent.change(select, { target: { value: "Ships" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("notes_move", {
        shared: null,
        path: "plan.md",
        folder: "Ships",
      }),
    );
  });

  it("searches across notes and shows the matching excerpt", async () => {
    install({
      notes: [entry("a.md"), entry("b.md")],
      folders: [],
      contents: { "a.md": "gate camp at Perimeter", "b.md": "unrelated" },
      location: LOCAL,
    });
    renderPage();
    await screen.findByText("a");
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "Perimeter" },
    });
    const hit = await screen.findByRole("button", { name: /gate camp/ });
    expect(hit).toHaveTextContent("a");
    expect(screen.queryByRole("button", { name: /unrelated/ })).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("notes_search", {
      shared: null,
      query: "Perimeter",
    });
  });

  it("stores notes in the shared folder only when sync is active, and offers to copy local notes", async () => {
    localStorage.setItem(STORAGE_KEYS.syncFolder, JSON.stringify("/mnt/drive"));
    localStorage.setItem(STORAGE_KEYS.syncEnabled, "true");
    install({
      notes: [],
      folders: [],
      contents: {},
      location: { root: "/mnt/drive/notes", shared: true, localOnly: 2 },
    });
    renderPage();
    await screen.findByText(/aren't in the shared folder yet/);
    expect(invokeMock).toHaveBeenCalledWith("notes_tree", {
      shared: "/mnt/drive",
    });
    expect(screen.getByText("/mnt/drive/notes")).toBeInTheDocument();
  });

  it("keeps notes local when a folder is chosen but sync isn't activated", async () => {
    localStorage.setItem(STORAGE_KEYS.syncFolder, JSON.stringify("/mnt/drive"));
    install({ notes: [], folders: [], contents: {}, location: LOCAL });
    renderPage();
    await screen.findByText(/Saved on this device only/);
    expect(invokeMock).toHaveBeenCalledWith("notes_tree", { shared: null });
  });
});

describe("NotesPage creating notes", () => {
  it("opens a freshly created note in the editor even while the list is still refetching", async () => {
    const backend: Backend = {
      notes: [entry("old.md")],
      folders: [],
      contents: { "old.md": "x" },
      location: LOCAL,
    };
    install(backend);
    // Hold every tree refetch after the first until released.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = invokeMock.getMockImplementation()!;
    let treeCalls = 0;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "notes_create") {
        const created = entry("Untitled.md", { updatedAt: 5 });
        backend.notes.push(created);
        backend.contents["Untitled.md"] = "";
        return created;
      }
      if (cmd === "notes_tree" && ++treeCalls > 1) await gate;
      return base(cmd, args);
    });

    renderPage();
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: "+ Markdown" }));
    const name = await screen.findByLabelText("Note name");
    expect(name).toHaveValue("Untitled");
    await waitFor(() => expect(name).toHaveFocus());
    release();
    await waitFor(() =>
      expect(screen.getAllByText("Untitled")).not.toHaveLength(0),
    );
    expect(screen.getByLabelText("Note name")).toBeInTheDocument();
  });
});
