import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isDiagnostic } from "../../../../shared/mcp/command-policy";
import type { Call } from "./http";

const exec = promisify(execFile);

export async function reviewOperation(call: Call): Promise<boolean> {
  if (process.platform !== "win32" || (call.op === "command" && !isDiagnostic(call.value))) return false;
  const dir = await mkdtemp(path.join(os.tmpdir(), "luna-command-review-"));
  try {
    const configured = process.env.LUNA_REVIEW_CODEX_EXE;
    let exe = configured;
    if (!exe) {
      const where = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
      const found = await exec(where, ["codex.exe"], { cwd: dir, windowsHide: true, timeout: 3000 });
      const store = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
      const alias = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "codex.exe");
      exe = found.stdout
        .split(/\r?\n/)
        .find(
          (p) =>
            path.isAbsolute(p) &&
            (p.toLowerCase() === alias.toLowerCase() ||
              /^OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(path.relative(store, p)))
        );
    }
    if (!exe || !path.isAbsolute(exe) || path.basename(exe).toLowerCase() !== "codex.exe") return false;
    const output = path.join(dir, "decision.txt");
    const prompt = [
      "Review a single operation on an explicitly granted Linux account. Decide whether a human must review it.",
      "Return exactly APPROVE or HUMAN. Choose HUMAN for destructive, ambiguous, sensitive or modifying actions.",
      "Do not use tools or execute anything. The operation is:",
      call.op === "command"
        ? JSON.stringify(call.value)
        : {
            logs: "Read the tail of an authorized UTF-8 log. The path and contents are withheld.",
            upload: "Upload a file chosen by the human to a new remote path. Existing destinations are skipped.",
            download:
              "Download one remote file to a new path chosen by the human. The remote path and contents are withheld."
          }[call.op]
    ].join("\n");
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--disable",
      "plugins",
      "--disable",
      "hooks",
      "--disable",
      "multi_agent",
      "--output-last-message",
      output,
      prompt
    ];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(?:systemroot|windir|path|pathext|userprofile|appdata|localappdata|temp|tmp|programfiles|programfiles\(x86\)|codex_home|openai_api_key|https?_proxy|all_proxy|no_proxy)$/i.test(
          name
        )
      )
    );
    const review = exec(exe, args, { cwd: dir, env, windowsHide: true, timeout: 45000, maxBuffer: 512 * 1024 });
    review.child.stdin?.end();
    await review;
    return (await readFile(output, "utf8")).trim() === "APPROVE";
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
