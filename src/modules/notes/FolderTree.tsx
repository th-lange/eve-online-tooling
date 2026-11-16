import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Library,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  baseName,
  DRAG_FOLDER,
  DRAG_NOTE,
  isWithin,
  type FolderNode,
} from "./notesModel";

/** A one-line text input that commits on Enter and cancels on Escape/blur. */
function NameInput({
  initial = "",
  placeholder,
  label,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim() !== "") onCommit(value.trim());
          else onCancel();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      onBlur={onCancel}
      className="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-100 outline-none ring-1 ring-indigo-500"
    />
  );
}

export interface FolderTreeProps {
  root: FolderNode;
  /** Total notes, for the "All notes" row. */
  totalNotes: number;
  /** `null` = all notes, `""` = top level, otherwise a folder path. */
  selected: string | null;
  onSelect: (folder: string | null) => void;
  onCreateFolder: (parent: string, name: string) => void;
  onRenameFolder: (path: string, name: string) => void;
  onDeleteFolder: (path: string) => void;
  onMoveNote: (notePath: string, folder: string) => void;
  onMoveFolder: (folderPath: string, parent: string) => void;
}

/** The folder sidebar: "All notes", the top level, and the nested folders —
 *  each a drop target for dragged notes and folders. */
export function FolderTree(props: FolderTreeProps) {
  const { root, totalNotes, selected, onSelect } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  function acceptsDrop(e: DragEvent): boolean {
    const types = e.dataTransfer.types;
    return types.includes(DRAG_NOTE) || types.includes(DRAG_FOLDER);
  }

  function dropProps(path: string) {
    return {
      onDragOver: (e: DragEvent) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(path);
      },
      onDragLeave: () => setDropTarget((t) => (t === path ? null : t)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const note = e.dataTransfer.getData(DRAG_NOTE);
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        if (note) props.onMoveNote(note, path);
        else if (folder && !isWithin(path, folder)) {
          props.onMoveFolder(folder, path);
        }
      },
    };
  }

  const rowBase = (active: boolean, dropping: boolean) =>
    `group flex items-center gap-1 rounded px-1.5 py-1 text-sm ${
      dropping
        ? "bg-indigo-900/60 ring-1 ring-indigo-500"
        : active
          ? "bg-zinc-800 text-zinc-100"
          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
    }`;

  function renderFolder(node: FolderNode, depth: number) {
    const isCollapsed = collapsed.has(node.path);
    const hasChildren = node.children.length > 0;
    return (
      <li key={node.path}>
        {renaming === node.path ? (
          <div
            className="flex items-center gap-1 px-1.5 py-1"
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
          >
            <NameInput
              initial={node.name}
              label={`Rename folder ${node.name}`}
              onCommit={(name) => {
                setRenaming(null);
                if (name !== node.name) props.onRenameFolder(node.path, name);
              }}
              onCancel={() => setRenaming(null)}
            />
          </div>
        ) : (
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_FOLDER, node.path);
              e.dataTransfer.effectAllowed = "move";
            }}
            {...dropProps(node.path)}
            className={rowBase(
              selected === node.path,
              dropTarget === node.path,
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
          >
            <button
              type="button"
              onClick={() => toggle(node.path)}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.name}`}
              className={`shrink-0 text-zinc-600 hover:text-zinc-300 ${hasChildren ? "" : "invisible"}`}
            >
              {isCollapsed ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              onDoubleClick={() => setRenaming(node.path)}
              title={node.path}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <Folder size={13} className="shrink-0 text-zinc-500" />
              <span className="truncate">{node.name}</span>
            </button>
            <span className="shrink-0 text-xs text-zinc-600 group-hover:hidden group-focus-within:hidden">
              {node.noteCount}
            </span>
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
              <IconButton
                label={`New folder in ${node.name}`}
                onClick={() => setCreatingIn(node.path)}
              >
                <FolderPlus size={12} />
              </IconButton>
              <IconButton
                label={`Rename folder ${node.name}`}
                onClick={() => setRenaming(node.path)}
              >
                <Pencil size={12} />
              </IconButton>
              <IconButton
                label={`Delete folder ${node.name}`}
                onClick={() => props.onDeleteFolder(node.path)}
              >
                <Trash2 size={12} />
              </IconButton>
            </span>
          </div>
        )}
        {creatingIn === node.path && (
          <NewFolderRow
            depth={depth + 1}
            parent={node.path}
            onDone={() => setCreatingIn(null)}
            onCreate={props.onCreateFolder}
          />
        )}
        {hasChildren && !isCollapsed && (
          <ul>{node.children.map((c) => renderFolder(c, depth + 1))}</ul>
        )}
      </li>
    );
  }

  return (
    <nav aria-label="Note folders" className="text-sm">
      <ul>
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={`${rowBase(selected === null, false)} w-full text-left`}
          >
            <Library size={13} className="ml-4 shrink-0 text-zinc-500" />
            <span className="flex-1">All notes</span>
            <span className="text-xs text-zinc-600">{totalNotes}</span>
          </button>
        </li>
        <li>
          <div
            {...dropProps("")}
            className={`${rowBase(selected === "", dropTarget === "")}`}
          >
            <button
              type="button"
              onClick={() => onSelect("")}
              className="flex flex-1 items-center gap-1.5 pl-4 text-left"
            >
              <Folder size={13} className="shrink-0 text-zinc-500" />
              <span className="flex-1">Top level</span>
            </button>
            <span className="text-xs text-zinc-600 group-hover:hidden group-focus-within:hidden">
              {root.noteCount}
            </span>
            <span className="hidden group-hover:flex group-focus-within:flex">
              <IconButton
                label="New folder at top level"
                onClick={() => setCreatingIn("")}
              >
                <FolderPlus size={12} />
              </IconButton>
            </span>
          </div>
          {creatingIn === "" && (
            <NewFolderRow
              depth={1}
              parent=""
              onDone={() => setCreatingIn(null)}
              onCreate={props.onCreateFolder}
            />
          )}
          <ul>{root.children.map((c) => renderFolder(c, 1))}</ul>
        </li>
      </ul>
    </nav>
  );
}

function NewFolderRow({
  depth,
  parent,
  onDone,
  onCreate,
}: {
  depth: number;
  parent: string;
  onDone: () => void;
  onCreate: (parent: string, name: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 px-1.5 py-1"
      style={{ paddingLeft: `${depth * 12 + 6}px` }}
    >
      <NameInput
        label={`New folder name${parent ? ` in ${baseName(parent)}` : ""}`}
        placeholder="Folder name"
        onCommit={(name) => {
          onDone();
          onCreate(parent, name);
        }}
        onCancel={onDone}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}
