import type { BrowserWindow, Clipboard, Dialog } from "electron";
import { randomUUID, createHash } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";
import path from "node:path";
import type { McpPermissions } from "../mcp-permissions";
import { listenMcp } from "./http";
import type { Call } from "./http";
import { preapproved } from "../../../../shared/mcp/command-policy";

const limit = 1024 * 1024;
interface Target {
  assetId: string;
  accountId: string;
  kind: "ssh" | "sftp";
  scope: string;
}
interface Job {
  autoDiagnostics?: boolean;
  id: string;
  call: Call;
  scope: string;
  owner: BrowserWindow;
  claimed: boolean;
  token?: string;
  destination?: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
export class DesktopMcp {
  private transport?: Awaited<ReturnType<typeof listenMcp>>;
  private owner?: BrowserWindow;
  private job?: Job;
  private identity = "";
  private generation = 0;
  private bindings = new Map<string, Target>();
  constructor(
    private policy: McpPermissions,
    private auth: () => any,
    private notify: (id: string) => void,
    private dialog: Dialog,
    private clipboard: Clipboard,
    private port = 18761
  ) {}
  private scope() {
    try {
      const s = this.auth().currentSession();
      return JSON.stringify([s.origin, s.sessionKey, s.orgId || ""]);
    } catch {
      return "";
    }
  }
  stop() {
    this.generation++;
    this.transport?.close();
    this.transport = undefined;
    this.identity = "";
    this.owner = undefined;
    this.job?.reject(new Error("Luna session or MCP service closed. In-flight execution status unknown."));
    this.job = undefined;
  }
  reset() {
    this.stop();
    this.bindings.clear();
  }
  async observe(request: any, invoke: () => Promise<any>) {
    const identity = this.scope();
    const gen = this.generation;
    const response = await invoke();
    if (
      !identity ||
      identity !== this.scope() ||
      gen !== this.generation ||
      request.method !== "POST" ||
      request.service === "kael" ||
      !response?.id
    )
      return response;
    const session = this.auth().currentSession();
    if (request.orgId && request.orgId !== session.orgId) return response;
    let target: Target | undefined;
    if (request.path === "/api/v1/authentication/connection-token/") {
      const b = request.body;
      if (
        b &&
        ["sftp", "ssh"].includes(b.protocol) &&
        typeof b.asset === "string" &&
        typeof b.account === "string" &&
        !b.account.startsWith("@")
      )
        target = { assetId: b.asset, accountId: b.account, kind: b.protocol, scope: identity };
    } else if (request.path === "/api/v1/authentication/connection-token/exchange/") {
      const parent = this.bindings.get(request.body?.id);
      if (parent?.scope === identity) target = { ...parent, kind: "sftp" };
    }
    if (target) {
      if (this.bindings.size >= 512) this.bindings.delete(this.bindings.keys().next().value!);
      this.bindings.set(response.id, target);
    }
    return response;
  }
  private live(gen: number) {
    return (
      this.generation === gen &&
      Boolean(this.identity && this.identity === this.scope() && this.owner && !this.owner.isDestroyed())
    );
  }
  private async checked(job: Job) {
    const grants = (await this.policy.load()).grants;
    if (
      this.job !== job ||
      !this.live(this.generation) ||
      this.identity !== job.scope ||
      !grants.some(
        (g) =>
          g.enabled &&
          g.assetId === job.call.assetId &&
          g.accountId === job.call.accountId &&
          g.permissions.includes(job.call.op) &&
          (!job.autoDiagnostics || preapproved(g.approvalMode, job.call.value))
      ) ||
      this.scope() !== job.scope
    )
      throw new Error("MCP grant or session expired");
  }
  private async dispatch(call: Call) {
    const scope = this.identity;
    const owner = this.owner;
    const gen = this.generation;
    if (!owner || !this.live(gen) || !(await this.policy.permits(call.assetId, call.accountId, call.op)))
      throw new Error("Operation not granted");
    const detail = await this.auth()
      .apiRequest({ method: "GET", path: `/api/v1/perms/users/self/assets/${encodeURIComponent(call.assetId)}/` })
      .catch(() => null);
    const linux = [detail?.type, detail?.platform].some((v) =>
      /linux/i.test(typeof v === "string" ? v : String(v?.value || v?.name || ""))
    );
    if (
      !this.live(gen) ||
      !linux ||
      detail?.id !== call.assetId ||
      detail.is_active === false ||
      !detail.permed_accounts?.some((a) => a.id === call.accountId)
    )
      throw new Error("Linux asset or account unavailable");
    const tokens = [...this.bindings]
      .filter(
        ([, t]) =>
          t.assetId === call.assetId &&
          t.accountId === call.accountId &&
          t.scope === scope &&
          t.kind === (call.op === "command" ? "ssh" : "sftp")
      )
      .map(([id]) => id);
    if (!tokens.length) throw new Error("Open the matching Luna SSH or SFTP session first");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let timer: ReturnType<typeof setTimeout>;
      const fail = (e: Error) => {
        clearTimeout(timer);
        if (this.job?.id === id) this.job = undefined;
        reject(e);
      };
      timer = setTimeout(() => fail(new Error("Request timed out; execution status unknown")), 180000);
      this.job = {
        call,
        scope,
        owner,
        id,
        claimed: false,
        reject: fail,
        resolve: (v) => {
          clearTimeout(timer);
          this.job = undefined;
          resolve(v);
        }
      };
      this.notify(id);
      setTimeout(() => {
        if (this.job?.id === id && !this.job.claimed) fail(new Error("No matching live Luna session in this window"));
      }, 3000).unref();
    });
  }
  async control(cmd: string, args: any, win: BrowserWindow) {
    if (cmd === "mcp_start") {
      const identity = this.scope();
      if (!identity) throw new Error("Login required");
      this.stop();
      const gen = this.generation;
      this.identity = identity;
      this.owner = win;
      const transport = await listenMcp(
        () => this.live(gen),
        async () => {
          const p = await this.policy.load();
          return p.grants.filter((g) => g.enabled);
        },
        (c) => this.dispatch(c),
        this.port
      );
      if (!this.live(gen)) {
        transport.close();
        throw new Error("Session changed");
      }
      this.transport = transport;
      win.once("closed", () => {
        if (this.owner === win) this.stop();
      });
      return transport.url;
    }
    if (cmd === "mcp_status") return this.live(this.generation) && this.owner === win ? this.transport?.url || "" : "";
    if (!this.live(this.generation) || this.owner !== win) throw new Error("MCP is inactive");
    if (cmd === "mcp_stop") {
      this.stop();
      return;
    }
    if (cmd === "mcp_copy") {
      if (this.transport) this.clipboard.writeText(this.transport.secret);
      return;
    }
    const j = this.job;
    if (!j || j.id !== args.id || j.owner !== win) throw new Error("Expired request");
    try {
      await this.checked(j);
    } catch (error) {
      j.reject(new Error("MCP grant or session expired; in-flight outcome unknown"));
      throw error;
    }
    if (cmd === "mcp_find") {
      if (!Array.isArray(args.tokens)) throw new Error("Invalid sessions");
      return args.tokens.find((token) => {
        const t = this.bindings.get(token);
        return (
          t?.scope === j.scope &&
          t.assetId === j.call.assetId &&
          t.accountId === j.call.accountId &&
          t.kind === (j.call.op === "command" ? "ssh" : "sftp")
        );
      });
    }
    if (cmd === "mcp_claim") {
      const t = this.bindings.get(args.token);
      if (
        j.claimed ||
        t?.scope !== j.scope ||
        t.assetId !== j.call.assetId ||
        t.accountId !== j.call.accountId ||
        t.kind !== (j.call.op === "command" ? "ssh" : "sftp")
      )
        throw new Error("Session mismatch");
      j.claimed = true;
      j.token = args.token;
      try {
        const { op, value, assetId, accountId } = j.call;
        const grant = (await this.policy.load()).grants.find((g) => g.assetId === assetId && g.accountId === accountId);
        if (!grant) throw new Error("Grant revoked");
        if (op === "command" && preapproved(grant.approvalMode, value)) {
          j.autoDiagnostics = true;
          await this.checked(j);
          return { ...j.call, autoDiagnostics: true };
        }
        const choice = await this.dialog.showMessageBox(win, {
          type: "question",
          buttons: ["取消", "允许这一次"],
          defaultId: 0,
          cancelId: 0,
          message: op === "command" ? "确认当前终端位于空闲的 Linux shell 提示符，再执行命令" : "允许这次 SFTP 操作？",
          detail: [`${grant.assetName} · ${assetId}`, `${grant.accountName} · ${accountId}`, op, value].join("\n")
        });
        if (choice.response !== 1) throw new Error("Declined in Luna");
        let data: string | undefined;
        if (op === "upload") {
          const pick = await this.dialog.showOpenDialog(win, {
            properties: ["openFile"],
            title: "选择上传文件（最多 1 MiB）"
          });
          if (pick.canceled) throw new Error("Upload cancelled");
          const file = await open(pick.filePaths[0], "r");
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > limit) throw new Error("Invalid upload or file exceeds 1 MiB");
            const bytes = Buffer.alloc(limit + 1);
            let size = 0;
            while (size < bytes.length) {
              const r = await file.read(bytes, size, bytes.length - size, null);
              if (!r.bytesRead) break;
              size += r.bytesRead;
            }
            if (size !== stat.size) throw new Error("Upload source changed");
            data = bytes.subarray(0, size).toString("base64");
          } finally {
            await file.close();
          }
        } else if (op === "download") {
          const pick = await this.dialog.showSaveDialog(win, {
            title: "选择新的下载文件名",
            defaultPath: path.posix.basename(value)
          });
          if (pick.canceled || !pick.filePath) throw new Error("Download cancelled");
          j.destination = pick.filePath;
        }
        await this.checked(j);
        return { ...j.call, data };
      } catch (e) {
        j.reject(e instanceof Error ? e : new Error("Request failed"));
        throw e;
      }
    }
    if (!j.claimed || j.token !== args.token) throw new Error("Request not claimed");
    if (cmd === "mcp_check") return true;
    if (cmd !== "mcp_finish") throw new Error("Unknown MCP operation");
    if (args.error) {
      j.reject(new Error(String(args.error).slice(0, 512)));
      return;
    }
    try {
      let result = args.result;
      if (j.call.op === "download") {
        if (typeof result?.data !== "string" || result.data.length > Math.ceil(limit / 3) * 4 || !j.destination)
          throw new Error("Invalid download");
        const bytes = Buffer.from(result.data, "base64");
        if (bytes.length > limit) throw new Error("Download exceeds limit");
        const temp = path.join(path.dirname(j.destination), `.luna-${randomUUID()}.part`);
        const file = await open(temp, "wx");
        try {
          try {
            await file.writeFile(bytes);
          } finally {
            await file.close();
          }
          await this.checked(j);
          await link(temp, j.destination);
        } finally {
          await unlink(temp);
        }
        result = {
          status: "downloaded",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        };
      }
      await this.checked(j);
      j.resolve({ assetId: j.call.assetId, accountId: j.call.accountId, operation: j.call.op, ...result });
    } catch (e) {
      j.reject(e instanceof Error ? e : new Error("File operation failed"));
      throw e;
    }
  }
}
