// `passh unlock [--ttl d]` (cli.md §2.14, agent-session.md §A2.3) and `passh lock` (cli.md
// §2.15, §A2.9): the CLI wiring of src/agent's runUnlock and runLock.

import { UsageError } from "../errors.ts";
import { runLock, runUnlock, type UnlockOpened } from "../agent/index.ts";
import { passphraseKeySource } from "../vault/index.ts";
import type { RunContext } from "./command.ts";
import { commandIO, commandTerminal, configAndVault, openForCommand } from "./open.ts";

/**
 * `unlock`: `--ttl` ≤ 0 is a usage error before anything else (§A2.3 step 1, so even without
 * a config file); then the config and the vault file; then src/agent's flow: an agent
 * already serving this key block (`Already unlocked: …`, no terminal needed), else the
 * passphrase on /dev/tty (the agent is not asked: the full open with the rollback check, 3
 * tries) and a new agent.
 */
export async function runUnlockCmd(ctx: RunContext): Promise<void> {
  const ttl = ctx.flags.duration("ttl");
  if (ttl !== undefined && ttl <= 0n) throw new UsageError("--ttl must be more than zero");
  const cfg = configAndVault(ctx);
  const tty = commandTerminal();
  await runUnlock({
    config: cfg,
    vaultPath: cfg.vault,
    ttl,
    io: commandIO,
    tty,
    openWithPassphrase: async (): Promise<UnlockOpened> => {
      const v = await openForCommand(cfg, tty, { sources: [passphraseKeySource(tty)] });
      return { identity: v.identity(), keyBlock: v.keyBlock, realPath: v.realPath, close: () => v.close() };
    },
  });
}

/**
 * `lock`: the config and the vault file must exist (the socket is named by the vault's real
 * path); `Locked: the agent (pid <n>) stopped.` or `No agent is running for <file>.`, exit 0.
 */
export async function runLockCmd(ctx: RunContext): Promise<void> {
  const cfg = configAndVault(ctx);
  await runLock({ config: cfg, vaultPath: cfg.vault, io: commandIO });
}
