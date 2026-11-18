import { desktopInvoke, desktopListen } from "~/shared/desktop/bridge";
import { isElectronRuntime } from "~/utils/runtime";

interface Request {
  autoDiagnostics?: boolean;
  op: "command" | "logs" | "upload" | "download";
  value: string;
  data?: string;
}
export type Run = (request: Request, check: () => Promise<void>) => Promise<unknown>;
type Endpoint = { token: () => string | undefined; run: Run };
const endpoints = new Set<Endpoint>();
let listening: Promise<unknown> | undefined;

async function handle(id: string) {
  const active = [...endpoints].map((endpoint) => ({ endpoint, token: endpoint.token() })).filter((e) => e.token);
  const token = await desktopInvoke<string | undefined>("mcp_find", { id, tokens: active.map((e) => e.token) });
  const match = active.find((e) => e.token === token);
  if (!match || !token) return;
  const check = async () => {
    await desktopInvoke("mcp_check", { id, token });
    if (!endpoints.has(match.endpoint) || match.endpoint.token() !== token) throw new Error("Luna session changed");
  };
  const request = await desktopInvoke<Request>("mcp_claim", { id, token });
  try {
    await check();
    const result = await match.endpoint.run(request, check);
    await check();
    await desktopInvoke("mcp_finish", { id, token, result });
  } catch (e) {
    await desktopInvoke("mcp_finish", { id, token, error: e instanceof Error ? e.message : "Operation failed" });
  }
}

export function registerMcpEndpoint(token: Endpoint["token"], run: Run) {
  if (!isElectronRuntime()) return;
  const endpoint = { token, run };
  endpoints.add(endpoint);
  onScopeDispose(() => endpoints.delete(endpoint));
  listening ??= desktopListen<string>("mcp-request", (e) => {
    void handle(e.payload).catch(() => {});
  }).catch(() => {
    listening = undefined;
  });
}
