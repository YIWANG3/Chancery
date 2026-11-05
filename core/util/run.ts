import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command without a shell; rejects on non-zero exit with the command and stderr in the message. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException & { code?: number | string })?.code;
        if (err) {
          const shown = args.map((a) => (a.length > 60 ? a.slice(0, 57) + "…" : a)).join(" ");
          const detail = (stderr || "").trim() || (stdout || "").trim().slice(-500) || err.message;
          const e = new Error(`${cmd} ${shown} failed (${String(code)}): ${detail}`);
          reject(e);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
}
