// Errors and warnings of the container (vault-format.md §2.2–§2.5). Messages carry no
// `<path>: ` prefix: the storage layer adds it (storage.md §3.1).

import { EN, errorf, PasshError, TN, type Localizable } from "../i18n/index.ts";

/** What went wrong with the container. */
export type ContainerErrorKind = "not-vault" | "newer-container" | "truncated" | "damaged";

/**
 * A container error. `code` is the kind (for hasCode), `block` the block (1 or 2) for
 * truncated and damaged blocks, `warnings` those found before the failure (§2.2 step 4).
 */
export class ContainerError extends PasshError {
  readonly kind: ContainerErrorKind;
  readonly block: 1 | 2 | undefined;
  warnings: ContainerWarning[] = [];

  constructor(kind: ContainerErrorKind, block: 1 | 2 | undefined, format: string, ...args: unknown[]) {
    super(format, args, { code: kind });
    this.name = "ContainerError";
    this.kind = kind;
    this.block = block;
  }
}

/** `not a passh vault` (§2.2 step 3). */
export function errNotVault(): ContainerError {
  return new ContainerError("not-vault", undefined, "not a passh vault");
}

/** `not a passh vault: unknown container version 0`. */
export function errUnknownVersion0(): ContainerError {
  return new ContainerError("not-vault", undefined, "not a passh vault: unknown container version 0");
}

/** `made by a newer passh; upgrade passh (container version V)`. */
export function errNewerContainer(v: bigint): ContainerError {
  return new ContainerError("newer-container", undefined, "made by a newer passh; upgrade passh (container version %d)", v);
}

/** `file is truncated: <reason>`. */
export function errTruncated(block: 1 | 2 | undefined, reason: PasshError): ContainerError {
  return new ContainerError("truncated", block, "file is truncated: %s", reason);
}

/** `file is damaged (block n): <reason>`. */
export function errDamaged(block: 1 | 2, reason: PasshError): ContainerError {
  return new ContainerError("damaged", block, "file is damaged (block %d): %s", block, reason);
}

// Reasons (§2.2, §2.3).
export const reasons = {
  empty: () => errorf("the file is empty"),
  endsInMagic: () => errorf("it ends in the passh-vault line"),
  missing: (n: number) => errorf("block %d is missing", n),
  cutShort: (n: number) => errorf("block %d is cut short", n),
  noEnd: (n: number) => errorf("block %d has no END line", n),
  badBegin: () => errorf("its BEGIN line is missing or damaged"),
  badEnd: () => errorf("its END line is missing or damaged"),
  badBase64: () => errorf("bad base64"),
  emptyBlock: () => errorf("the block is empty"),
  badHeader: () => errorf("bad age header"),
  keyBlockNotScrypt: () => errorf("the key block isn't encrypted with a passphrase"),
  dataBlockNotX25519: () => errorf("the data block isn't encrypted to a vault key"),
  impossibleSize: () => errorf("the encrypted data has an impossible size (cut short or extended)"),
};

/**
 * A warning of the lenient parse (§2.2 steps 4 and 6): `ignored N line(s) of text before
 * the passh-vault line` / `… after the last END line`. passh writes the plural properly
 * ("1 line", "2 lines"). `message` is English; `localize()` gives the current language.
 */
export class ContainerWarning implements Localizable {
  constructor(
    readonly where: "before" | "after",
    readonly lines: number,
  ) {}

  #forms(): [string, string] {
    return this.where === "before"
      ? ["ignored %d line of text before the passh-vault line", "ignored %d lines of text before the passh-vault line"]
      : ["ignored %d line of text after the last END line", "ignored %d lines of text after the last END line"];
  }

  get message(): string {
    const [one, other] = this.#forms();
    return EN(this.lines, one, other, this.lines);
  }

  localize(): string {
    const [one, other] = this.#forms();
    return TN(this.lines, one, other, this.lines);
  }

  toString(): string {
    return this.message;
  }
}

/** §2.5: `not a passh vault: the file is larger than 64 MiB` (opening, `backup`); code too-large. */
export function errFileTooLarge(): PasshError {
  return new PasshError("not a passh vault: the file is larger than 64 MiB", [], { code: "too-large" });
}

/** §2.5: `<~path> is larger than 64 MiB: not a passh vault` (`verify`); code too-large. */
export function errVerifyTooLarge(tildePath: string): PasshError {
  return new PasshError("%s is larger than 64 MiB: not a passh vault", [tildePath], { code: "too-large" });
}

/** §2.5: `not a passh vault: not a regular file` (opening); code not-regular. */
export function errNotRegularFile(): PasshError {
  return new PasshError("not a passh vault: not a regular file", [], { code: "not-regular" });
}

/** §2.5: `<~path> is not a regular file` (`verify`); code not-regular. */
export function errVerifyNotRegular(tildePath: string): PasshError {
  return new PasshError("%s is not a regular file", [tildePath], { code: "not-regular" });
}

/**
 * §2.5: a save whose encoded file would exceed 64 MiB is refused (code too-large).
 * SPEC-GAP: the spec gives no text; this one follows spec-audit #3 ("nothing was saved").
 */
export function errEncodedTooLarge(size: number): PasshError {
  return new PasshError("the vault file would be %d bytes, larger than 64 MiB, which passh can't open; nothing was saved", [size], {
    code: "too-large",
  });
}
