// `passh <version>` (cli.md §2.26): "dev" unless set at build time (scripts/build.ts defines
// PASSH_VERSION through `bun build --define`).

declare const PASSH_VERSION: string | undefined;

export const VERSION_STRING: string = typeof PASSH_VERSION !== "undefined" ? PASSH_VERSION : "dev";
