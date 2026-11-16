// The vault on disk (spec §4.5–§4.8, §4.10, §5.1; storage.md §3–§7): opening, key sources,
// saving, automatic backups, the rollback record, and the cores of `verify`, `backup` and
// `backups`.
//
//   const v = await openVault(cfg.vault, { config: cfg, io, rollback: "prompt",
//     sources: [agentSource, passphraseKeySource(tty)], confirmOlder: ttyConfirmOlder(tty) });
//   const next = cloneVaultData(v.data); …; await v.save(next); v.close();

export * from "./types.ts";
export { absPath, openVault, Vault } from "./open.ts";
export { createVault, type CreateOptions } from "./create.ts";
export {
  currentKeySource,
  identityKeySource,
  paperKeySource,
  passphraseKeySource,
  PASSPHRASE_TRIES,
  readPaperKey,
  recoverWrongKeyError,
  type PaperKeyOptions,
  type PassphraseSourceOptions,
} from "./keysources.ts";
export {
  errBusy,
  errCancelled,
  errChanged,
  errExists,
  errInBackups,
  errKeyBlockDamaged,
  errLocked,
  errNoVault,
  errRollbackDeclined,
  errVaultStat,
  openHint,
  VaultErrorCode,
  withOpenHint,
  withPath,
} from "./errors.ts";
export {
  checkVaultExists,
  rollbackReportText,
  runBackup,
  runBackups,
  runVerify,
  ttyConfirmOlder,
  type BackupOptions,
  type BackupsOptions,
  type VerifyOptions,
} from "./commands.ts";
export {
  backupDirName,
  backupLine,
  backupName,
  backupsRoot,
  damagedBackupList,
  listAllBackups,
  listFolder,
  matchingFolders,
  parseBackupName,
  stampDisplay,
  type BackupFile,
  type BackupFolder,
} from "./backups.ts";
export {
  checkRollback,
  decodeRecord,
  encodeRecord,
  formatRecordTime,
  olderText,
  parseRecordTime,
  readRecord,
  recordPath,
  updateRecord,
  type RecordEntry,
  type RecordRead,
  type RecordTime,
  type RecordUpdate,
} from "./rollback.ts";
export { vaultTestHooks, type FaultPoint, type VaultTestHooks } from "./hooks.ts";
