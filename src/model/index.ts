// The data model of the vault's data block (spec §4.2, vault-format.md §4): types, reading,
// validation, serialization, times and the changes of §4.7.

export * from "./types.ts";
export * from "./time.ts";
export {
  DATA_FORMAT,
  DATA_VERSION,
  MAX_REVISION,
  entryContentProblem,
  fieldKeyProblem,
  isJSONError,
  isReservedFieldKey,
  isValidFieldKey,
  newerDataError,
  newId,
  newVaultData,
  parseVaultData,
  serializeVaultData,
  serializeVaultDataText,
  validateEntryContent,
  validateVaultData,
  validationProblem,
} from "./data.ts";
export * from "./ops.ts";
export { JSONSyntaxError, MAX_DEPTH, parseJSON, quoteJSON } from "./json.ts";
