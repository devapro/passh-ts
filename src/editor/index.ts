// The external editor of `passh edit --editor` (agent-session.md §A6, spec §5.6, S1).
// The built-in entry form is the TUI's (src/tui).
//
//   const editor = chooseEditor();             // before unlocking; throws `$EDITOR: …`
//   const base = findTmpBase();                // { ok: false, error } → note + built-in form
//   const out = await editExternally({ tty, editor, base: base.base, text, validate });

export { chooseEditor, detectKind, editorArgv, editorFlags, kindOfName } from "./choose.ts";
export type { EditorChoice, EditorKind } from "./choose.ts";
export { findTmpBase, leftoverEditFolders, onMemoryFs, EDIT_DIR_PREFIX } from "./tmpfs.ts";
export type { TmpBase } from "./tmpfs.ts";
export { editExternally, removeEditFolder, isEditInterrupted, EDIT_MAX } from "./edit.ts";
export type { EditOptions, EditOutcome, Validation } from "./edit.ts";
