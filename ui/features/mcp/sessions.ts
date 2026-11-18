import { desktopInvoke, desktopListen } from "~/shared/desktop/bridge";
import { isElectronRuntime } from "~/utils/runtime";
import { useUserInfoStore } from "~/store/modules/userInfo";

interface Request {
  autoDiagnostics?: boolean;
  op: "command" | "logs" | "upload" | "download";
  value: string;
  data?: string;
}
export type Run = (request: Request, check: () => Promise<void>) => Promise<unknown>;
type Endpoint = { token: () => string | undefined; run: Run };
const endpoints = new Set<Endpoint>();
interface OpenTarget {
  assetId: string;
  accountId: string;
  orgId: string;
  protocol: "ssh" | "sftp";
}
type OpenSession = (id: string, target: OpenTarget) => Promise<void>;

async function findEndpoint(id: string) {
  const active = [...endpoints].map((endpoint) => ({ endpoint, token: endpoint.token() })).filter((e) => e.token);
  const token = await desktopInvoke<string | undefined>("mcp_find", { id, tokens: active.map((e) => e.token) });
  return token ? active.find((e) => e.token === token) : undefined;
}

async function handle(id: string, open: OpenSession) {
  let match = await findEndpoint(id);
  if (!match) {
    const target = await desktopInvoke<OpenTarget>("mcp_open_target", { id });
    try {
      await open(id, target);
      const deadline = Date.now() + 30000;
      while (!match && Date.now() < deadline) {
        match = await findEndpoint(id);
        if (!match) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!match) throw new Error("Connection not ready");
    } catch {
      await desktopInvoke("mcp_open_failed", { id });
      return;
    }
  }
  const { endpoint, token } = match;
  const check = async () => {
    await desktopInvoke("mcp_check", { id, token });
    if (!endpoints.has(endpoint) || endpoint.token() !== token) throw new Error("Luna session changed");
  };
  const request = await desktopInvoke<Request>("mcp_claim", { id, token });
  try {
    await check();
    const result = await endpoint.run(request, check);
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
}

export function useMcpWorkspace() {
  if (!isElectronRuntime()) return;
  const assets = useAssetAction();
  const tabs = useWorkspaceTabs();
  const user = useUserInfoStore();
  const open: OpenSession = async (id, target) => {
    const check = async () => {
      await desktopInvoke("mcp_open_check", { id });
      if (!user.loggedIn || (user.currentUser?.org?.id || "") !== target.orgId) throw new Error("Identity changed");
    };
    const panes = tabs.tabs.value
      .flatMap((tab) => tab.panes)
      .filter((p) => p.protocol === target.protocol && p.assetId === target.assetId && p.status === "connected");
    const tokenFor = (p: (typeof panes)[number]) => String(p.payload?.id || p.payload?.token?.id || "");
    const bound = await desktopInvoke<string | undefined>("mcp_find", {
      id,
      tokens: panes.map(tokenFor).filter(Boolean)
    });
    const existing = bound && panes.find((p) => tokenFor(p) === bound);
    await check();
    if (existing) tabs.setActivePane(existing.id);
    else await assets.openGrantedSession(target.assetId, target.accountId, target.protocol, target.orgId, check);
  };
  const listening = desktopListen<string>("mcp-request", (e) => {
    void handle(e.payload, open).catch(() => {});
  });
  onScopeDispose(() => {
    void listening.then((stop) => stop()).catch(() => {});
  });
}
