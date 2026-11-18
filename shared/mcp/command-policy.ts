export type ApprovalMode = "ask" | "assisted" | "full";

// Only options with defined, non-mutating semantics. In particular, hostname and
// date can change the system when given other arguments. Never tokenize a shell script.
export function isDiagnostic(command: string) {
  return (
    /^(?:hostname(?: -(?:s|f))?|uptime(?: -(?:p|s))?|uname(?: -[asnrvmo]+)?|whoami|pwd|date(?: -u)?|nproc|free(?: -(?:b|k|m|g|h))?|df(?: -(?:h|k|m|T))?(?: \/)?)$/.test(
      command
    ) && !/[\r\n]/.test(command)
  );
}
