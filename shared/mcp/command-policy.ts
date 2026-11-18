export type ApprovalMode = "ask" | "assisted" | "full";

const basic = ["hostname", "uptime"];
export const diagnostics = [...basic, "uname -r", "whoami", "pwd", "date -u", "nproc", "free -m", "df -h /"];

export function preapproved(mode: ApprovalMode | undefined, command: string) {
  return (mode === "assisted" && basic.includes(command)) || (mode === "full" && diagnostics.includes(command));
}
