import type { Terminal } from "@xterm/xterm";
import type { Run } from "./sessions";
import { diagnostics } from "../../../shared/mcp/command-policy";

function currentInput(term: Terminal) {
  const b = term.buffer.active;
  const line = b.getLine(b.baseY + b.cursorY);
  if (!line || line.isWrapped || line.translateToString(true, b.cursorX)) return "";
  return line.translateToString(false, 0, b.cursorX);
}

// Capture only the output between this command's echo and the same shell prompt.
// A PTY prompt is observable, but does not carry a numeric exit code.
async function diagnostic(term: Terminal, value: string, send: (text: string) => boolean, check: () => Promise<void>) {
  await check();
  const prompt = currentInput(term);
  if (
    !diagnostics.includes(value) ||
    term.buffer.active.type !== "normal" ||
    !/^[\w.-]+@[\w.-]+:[^\r\n#$]*[#$] $/.test(prompt) ||
    term.buffer.active.cursorX + value.length >= term.cols
  )
    throw new Error("Open a visible SSH terminal with an empty Linux shell prompt");
  const marker = term.registerMarker(0);
  if (!marker) throw new Error("Cannot track terminal output");
  try {
    if (!send(`${value  }\r`)) throw new Error("Terminal input rejected");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const b = term.buffer.active;
      if (b.type !== "normal" || marker.isDisposed) break;
      const last = b.baseY + b.cursorY;
      if (last <= marker.line || currentInput(term) !== prompt) continue;
      if (b.getLine(marker.line)?.translateToString(true) !== prompt + value || last - marker.line > 16) break;
      const lines: string[] = [];
      for (let i = marker.line + 1; i < last; i++) lines.push(b.getLine(i)?.translateToString(true) || "");
      const output = lines.join("\n");
      await check();
      return {
        command: value,
        output,
        exitCode: null,
        status: output ? "output_observed" : "unconfirmed",
        source: "interactive terminal screen"
      };
    }
    return { command: value, output: "", exitCode: null, status: "unconfirmed", source: "interactive terminal screen" };
  } finally {
    marker.dispose();
  }
}

// An interactive Koko PTY does not transmit a process exit code. The operator
// confirms what they saw, including ACL review/denial, before output is returned.
export function mcpTerminalOperation(
  terminal: () => Terminal | null,
  send: (text: string) => boolean,
  toast: ReturnType<typeof useToast>
): Run {
  return async ({ op, value, autoDiagnostics }, check) => {
    const term = terminal();
    if (op !== "command" || !term || term.buffer.active.type !== "normal")
      throw new Error("Visible SSH shell required");
    if (autoDiagnostics) return diagnostic(term, value, send, check);
    const marker = term.registerMarker(0);
    const startX = term.buffer.active.cursorX;
    if (!marker) throw new Error("Terminal output tracking unavailable");
    try {
      await check();
      if (!send(`${value}\r`)) throw new Error("Terminal input rejected");
      const status = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => end("unconfirmed"), 110000);
        const notice = toast.add({
          title: `MCP · ${value}`,
          description: "请在此终端完成 JumpServer 审批，观察命令结果后选择状态。将返回本次终端屏幕输出。",
          duration: 0,
          close: false,
          actions: [
            { label: "已完成", onClick: () => end("operator_confirmed_completed") },
            { label: "执行失败", onClick: () => end("operator_reported_failure") },
            { label: "策略拒绝", onClick: () => end("operator_reported_policy_denied") }
          ]
        });
        function end(s: string) {
          clearTimeout(timer);
          toast.remove(notice.id);
          resolve(s);
        }
        if (terminal() !== term) {
          clearTimeout(timer);
          toast.remove(notice.id);
          reject(new Error("Terminal changed"));
        }
      });
      await check();
      const b = term.buffer.active;
      if (marker.isDisposed || terminal() !== term || b.type !== "normal")
        throw new Error("Terminal changed; output unavailable");
      const last = b.baseY + b.cursorY;
      const lines: string[] = [];
      for (let i = Math.max(marker.line, last - 200); i <= last; i++)
        lines.push(b.getLine(i)?.translateToString(true, i === marker.line ? startX : 0) || "");
      return {
        status,
        exitCode: null,
        command: value,
        output: lines.join("\n").slice(-16000),
        source: "interactive terminal screen (includes echo and prompt)"
      };
    } finally {
      marker.dispose();
    }
  };
}
