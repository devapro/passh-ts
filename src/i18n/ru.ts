// Russian catalogue (i18n.md; glossary: spec/docs/translations.md). Keys are the English texts.
// Area fragments are merged here; later keys win.

import type { Catalog } from "./index.ts";
import { PRINT_CATALOG_RU } from "../print/catalog_ru.ts";

export const RU: Catalog = {
  ...PRINT_CATALOG_RU,
};
