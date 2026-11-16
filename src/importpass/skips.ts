// Why a store file was skipped (import-export.md §1.8): the reasons, in report order, and
// their details.

/** The reasons of §1.8's table, in the order the report counts them. */
export const SKIP_REASONS = [
  "invalid-path",
  "in-vault",
  "duplicate",
  "outside",
  "broken",
  "folder-link",
  "not-regular",
  "unreadable",
  "too-large",
  "decrypt",
  "not-text",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** The English text of each reason (the catalogue key; translated in the report). */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  "invalid-path": "invalid path",
  "in-vault": "already in the vault",
  duplicate: "duplicate path",
  outside: "symlink leads outside the store",
  broken: "broken symlink",
  "folder-link": "symlink to a folder",
  "not-regular": "not a regular file",
  unreadable: "unreadable",
  "too-large": "too large",
  decrypt: "decryption failed",
  "not-text": "not a text entry",
};

/** A skipped store file or folder. */
export interface Skip {
  /** The store-relative path with `/`, as bytes (file names need not be UTF-8). */
  file: Buffer;
  reason: SkipReason;
  /**
   * The detail after `: `, or none. A PasshError is translated when the report is written;
   * an OS error (Errno) prints its text (`permission denied`).
   */
  detail?: Error;
}
