// Registers the ru and sr catalogues (loaded lazily, only when the language is chosen).
// The English texts are the keys (i18n.md §4).

import { registerCatalog } from "./index.ts";
import { RU } from "./ru.ts";
import { SR } from "./sr.ts";

registerCatalog("ru", () => RU);
registerCatalog("sr", () => SR);
