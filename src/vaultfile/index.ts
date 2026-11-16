// The vault container (vault-format.md §2): lenient parse, block checks without a key,
// canonical write, the recovery-mode parse and the size limit.

export {
  checkBlock,
  encodeContainer,
  MAGIC_LINE,
  MAX_VAULT_FILE_SIZE,
  parseContainer,
  parseContainerForRecovery,
  trimSpaceBytes,
} from "./container.ts";
export type { Container, RecoveryContainer } from "./container.ts";
export {
  ContainerError,
  ContainerWarning,
  errEncodedTooLarge,
  errFileTooLarge,
  errNotRegularFile,
  errVerifyNotRegular,
  errVerifyTooLarge,
} from "./errors.ts";
export type { ContainerErrorKind } from "./errors.ts";
