// Printing (spec §5.4, §7.2, print.md): the password sheet and the recovery key sheet as
// rows and blocks, their text form, and the `print` / `recovery-key print` commands.

export { parseFields, isFieldKey, fieldLabel, DEFAULT_FIELDS, STANDARD_FIELDS, type FieldName, type StandardField } from "./fields.ts";
export { buildPasswordSheet, selectEntries, groupEntries, notesLines, legendLines, formatDate, Scope, type Sheet, type PasswordSheetInput } from "./sheet.ts";
export { buildRecoverySheet, keyLines, recoveryCommands, RECOVERY_COMMANDS, type RecoverySheetInput } from "./recovery.ts";
export { renderText, paginate, pageHeader, bodyHeight, PAGE_LINES } from "./text.ts";
export { rowLines, rowHeight, valueRows, type Row, type RowKind, type Block } from "./rows.ts";
export { cellsOf, marksOf, chunkCells, hardWrap, proseWrap, textWidth, COLUMNS, VALUE_WIDTH, type Cell, type MarkMode } from "./cells.ts";
export { outputPath, checkOutputFree, writeNewOutput, onTmpfs, tmpfsWarning, shellQuote } from "./output.ts";
export {
  runPrint,
  runPrintWeb,
  runRecoveryKeyPrint,
  writeRecoverySheet,
  recoverySheetText,
  defaultRecoverySheetPath,
  printWebSettings,
  type PrintFlags,
  type RecoveryKeyPrintFlags,
  type PrintDeps,
  type PrintTty,
  type OpenEntries,
  type OpenKey,
} from "./commands.ts";
export { PRINT_CATALOG_RU } from "./catalog_ru.ts";
export { PRINT_CATALOG_SR } from "./catalog_sr.ts";
