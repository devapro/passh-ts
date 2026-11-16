// Isolated environments for tests and manual runs: every variable that could reach the
// user's real files points into a fresh folder under passh-ts/tmp/ (or /dev/shm for the
// runtime folder, which must be tmpfs for `edit --editor`).

import { mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const TMP = join(ROOT, "tmp");
/** The reference implementation, used only as a black box. */
export const REF_BIN = join(ROOT, "reference/passh-go");
/** Our compiled binary (bun run build:host). */
export const TS_BIN = join(ROOT, "dist/passh");
/** Run our implementation from source: [bun, run, src/main.ts]. */
export const TS_SRC_CMD = [process.execPath, "run", join(ROOT, "src/main.ts")];

export interface IsolatedEnv {
  dir: string;
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  runtimeDir: string;
  tmpDir: string;
  configFile: string;
  storeDir: string;
  gnupgHome: string;
  /** Default vault path used by the helpers: <dataHome>/passh/vault.passh. */
  vault: string;
  env: Record<string, string>;
  cleanup(): void;
}

/**
 * Creates an isolated environment. `name` makes the folder easy to find; the folder is
 * short so that the agent socket path stays under 103 bytes.
 */
export function isolatedEnv(name = "t"): IsolatedEnv {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, name.slice(0, 8) + "-"));
  const home = join(dir, "home");
  const configHome = join(dir, "cfg");
  const dataHome = join(dir, "data");
  const stateHome = join(dir, "st");
  const tmpDir = join(dir, "tmp");
  const storeDir = join(dir, "store");
  const gnupgHome = join(dir, "gnupg");
  let runtimeDir = join(dir, "run");
  if (existsSync("/dev/shm")) {
    try {
      runtimeDir = mkdtempSync("/dev/shm/passh-ts-test-");
    } catch {
      /* fall back to a disk folder */
    }
  }
  for (const d of [home, configHome, dataHome, stateHome, tmpDir, storeDir, gnupgHome, runtimeDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const configFile = join(configHome, "passh", "config.toml");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USER: "tester",
    LOGNAME: "tester",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_RUNTIME_DIR: runtimeDir,
    TMPDIR: tmpDir,
    PASSH_CONFIG: configFile,
    PASSWORD_STORE_DIR: storeDir,
    GNUPGHOME: gnupgHome,
    EDITOR: "",
    VISUAL: "",
  };
  return {
    dir,
    home,
    configHome,
    dataHome,
    stateHome,
    runtimeDir,
    tmpDir,
    configFile,
    storeDir,
    gnupgHome,
    vault: join(dataHome, "passh", "vault.passh"),
    env,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      if (runtimeDir.startsWith("/dev/shm/")) {
        try {
          rmSync(runtimeDir, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
}

/**
 * Runs a command without a controlling terminal (setsid), so /dev/tty can't be opened.
 * `stdin` is written and closed.
 */
export async function run(cmd: string[], env: Record<string, string>, opts: { stdin?: string | Uint8Array; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(["setsid", "-w", ...cmd], {
    env,
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  const bytes = new Uint8Array(out);
  return { code, stdout: new TextDecoder().decode(bytes), stderr: err, stdoutBytes: bytes };
}

/** Writes a minimal config file naming the vault. */
export async function writeConfig(e: IsolatedEnv, extra = "", vault = e.vault): Promise<void> {
  mkdirSync(join(e.configHome, "passh"), { recursive: true, mode: 0o700 });
  await Bun.write(e.configFile, `vault = ${JSON.stringify(vault)}\n${extra}`);
}
