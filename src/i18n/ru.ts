// Russian catalogue (i18n.md; glossary: spec/docs/translations.md). Keys are the English texts.
// Area fragments are merged here; later keys win, so the print area's normative sheet-frame
// strings (print.md §8) come last.

import type { Catalog } from "./index.ts";
import { PRINT_CATALOG_RU } from "../print/catalog_ru.ts";
import { RU_CORE } from "./ru_core.ts";
import { RU_CLI } from "./ru_cli.ts";
import { RU_TUI } from "./ru_tui.ts";

export const RU: Catalog = {
  ...RU_CORE,
  ...RU_CLI,
  ...RU_TUI,
  ...PRINT_CATALOG_RU,
};
