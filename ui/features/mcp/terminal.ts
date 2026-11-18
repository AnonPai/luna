import type { Terminal } from "@xterm/xterm";
import type { Run } from "./sessions";

// An interactive Koko PTY does not transmit a process exit code. The operator
// confirms what they saw, including ACL review/denial, before output is returned.
export function mcpTerminalOperation(
  terminal: () => Terminal | null,
  send: (text: string) => boolean,
  toast: ReturnType<typeof useToast>
): Run {
  return async ({ op, value }, check) => {
    const term = terminal();
    if (op !== "command" || !term || term.buffer.active.type !== "normal")
      throw new Error("Visible SSH shell required");
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
