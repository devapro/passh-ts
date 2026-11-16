// Serbian (Latin script, ekavian) catalogue (i18n.md; glossary: spec/docs/translations.md).
// Area fragments are merged here; later keys win, so the print area's normative sheet-frame
// strings (print.md §8) come last.

import type { Catalog } from "./index.ts";
import { PRINT_CATALOG_SR } from "../print/catalog_sr.ts";
import { SR_CORE } from "./sr_core.ts";
import { SR_CLI } from "./sr_cli.ts";
import { SR_TUI } from "./sr_tui.ts";

export const SR: Catalog = {
  ...SR_CORE,
  ...SR_CLI,
  ...SR_TUI,
  ...PRINT_CATALOG_SR,
};
