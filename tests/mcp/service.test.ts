import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DesktopMcp } from "../../electron/src/desktop/mcp/desktop";
import { McpPermissions } from "../../electron/src/desktop/mcp-permissions";
import { mcpFileOperations } from "../../ui/features/mcp/files";
import { mcpTerminalOperation } from "../../ui/features/mcp/terminal";

const mock = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}));
const clean: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
  vi.clearAllMocks();
});
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "luna-local-mcp-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const identity = { origin: "https://fixture.invalid", sessionKey: "test-user", orgId: "org" };
  const grant = {
    assetId: "linux",
    accountId: "ops",
    assetName: "Fixture",
    accountName: "Ops",
    enabled: true,
    permissions: ["command", "logs", "upload", "download"]
  };
  const policy = new McpPermissions(dir, () => identity);
  await policy.save({ ...(await policy.load()), grants: [grant] });
  const auth = {
    currentSession: () => identity,
    apiRequest: vi.fn(async () => ({ id: "linux", type: { value: "linux" }, permed_accounts: [{ id: "ops" }] }))
  };
  const win = { isDestroyed: () => false, once: () => {} } as any;
  const sent: string[] = [];
  const files = new Map<string, Buffer>([["/var/log/test.log", Buffer.from("one\ntwo\n")]]);
  let localStatus = 0;
  let screen = "";
  const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const data = Buffer.from([0, 10, 255, 42]);
  const local = path.join(dir, "input.bin");
  const dest = path.join(dir, "output.bin");
  await writeFile(local, data);
  mock.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  mock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [local] });
  mock.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest });
  let staged: Buffer;
  const fileRun = mcpFileOperations(
    {
      prepareTransfer: async (i) => ({ state: files.has(i.targetPath) ? "skipped" : "ready", committedBytes: 0 }),
      writeChunk: async (i) => {
        staged = Buffer.from(i.data);
        return { committedBytes: staged.length };
      },
      commitTransfer: async (i) => {
        const expected = staged?.length
          ? digest(Buffer.concat([Buffer.alloc(32), Buffer.from(digest(staged), "hex")]))
          : "0".repeat(64);
        expect(i.sha256).toBe(expected);
        files.set(i.targetPath, staged || Buffer.alloc(0));
      },
      cancelTransfer: async () => {},
      readChunk: async (i) => {
        const b = files.get(i.path)!;
        const part = b.subarray(i.offset, i.offset + i.length);
        return { offset: i.offset, data: part, sha256: digest(part), eof: i.offset + part.length === b.length };
      }
    } as any,
    async (p) =>
      p === "/"
        ? ([{ name: "var", is_dir: true, perm: "d" }] as any)
        : p === "/var"
          ? ([{ name: "log", is_dir: true, perm: "d" }] as any)
          : ([...files.keys()]
              .filter((f) => path.posix.dirname(f) === p)
              .map((f) => ({ name: path.posix.basename(f), is_dir: false, perm: "-" })) as any)
  );
  const term = {
    cols: 100,
    buffer: {
      active: { type: "normal", cursorX: 0, baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => screen }) }
    },
    registerMarker: () => ({ line: 0, isDisposed: false, dispose: () => {} })
  };
  let diagnosticScreen = false;
  const prompt = "ops@host:~$ ";
  const terminalRun = mcpTerminalOperation(
    () => term as any,
    (text) => {
      sent.push(text);
      if (diagnosticScreen) {
        term.buffer.active.cursorY = 2;
        term.buffer.active.getLine = ((line: number) => ({
          translateToString: (_trim: boolean, start = 0, end?: number) =>
            [prompt + text.trimEnd(), "fixture-output", prompt][line]!.slice(start, end)
        })) as typeof term.buffer.active.getLine;
      }
      screen =
        (
          { "hostname\r": "fixture-linux", "uptime\r": "up 3 days", "false\r": "fixture failure" } as Record<
            string,
            string
          >
        )[text] || "fixture: blocked by ACL";
      localStatus = text === "false\r" ? 1 : text === "restricted\r" ? 2 : 0;
      return true;
    },
    {
      add: (n) => {
        queueMicrotask(() => n.actions[localStatus].onClick());
        return { id: "notice" };
      },
      remove: () => {}
    } as any
  );
  const service = new DesktopMcp(
    policy,
    () => auth,
    (id) => {
      void (async () => {
        let token;
        try {
          token = await service.control("mcp_find", { id, tokens: ["ssh-token", "sftp-token"] }, win);
          const args = { id, token };
          const call = await service.control("mcp_claim", args, win);
          const check = async () => {
            await service.control("mcp_check", args, win);
          };
          const result = await (call.op === "command" ? terminalRun : fileRun)(call, check);
          await service.control("mcp_finish", { ...args, result }, win);
        } catch (e) {
          await service.control("mcp_finish", { id, token, error: (e as Error).message }, win).catch(() => {});
        }
      })();
    },
    mock.dialog as any,
    mock.clipboard as any,
    0
  );
  clean.push(() => service.reset());
  await service.observe(
    {
      method: "POST",
      path: "/api/v1/authentication/connection-token/",
      body: { asset: "linux", account: "ops", protocol: "ssh" }
    },
    async () => ({ id: "ssh-token" })
  );
  await service.observe(
    { method: "POST", path: "/api/v1/authentication/connection-token/exchange/", body: { id: "ssh-token" } },
    async () => ({ id: "sftp-token" })
  );
  const url = await service.control("mcp_start", {}, win);
  await service.control("mcp_copy", {}, win);
  const key = mock.clipboard.writeText.mock.lastCall![0];
  async function rpc(method: string, params: any = {}, headers: Record<string, string> = {}) {
    return fetch((await service.control("mcp_status", {}, win)) || url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
        ...headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
  }
  async function call(name: string, args: any) {
    const r = await rpc("tools/call", { name, arguments: { assetId: "linux", accountId: "ops", ...args } });
    const body: any = await r.json();
    return JSON.parse(body.result.content[0].text);
  }
  function idleShell() {
    diagnosticScreen = true;
    term.buffer.active.cursorX = prompt.length;
    term.buffer.active.cursorY = 0;
    term.buffer.active.getLine = () => ({
      translateToString: (_trim?: boolean, start = 0, end?: number) => prompt.slice(start, end)
    });
  }
  return { rpc, call, service, policy, win, sent, auth, dest, data, identity, idleShell };
}

it("requires local auth, rejects foreign origins, negotiates MCP and invalidates credentials on reset", async () => {
  const s = await setup();
  expect((await s.rpc("tools/list", {}, { authorization: "Bearer wrong" })).status).toBe(401);
  expect((await s.rpc("tools/list", {}, { origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await (await s.rpc("initialize")).json()).result.protocolVersion).toBe("2025-06-18");
  expect((await (await s.rpc("tools/list")).json()).result.tools).toHaveLength(5);
  s.service.reset();
  await s.service.control("mcp_start", {}, s.win);
  expect((await s.rpc("tools/list")).status).toBe(401);
  s.identity.sessionKey = "";
  s.service.reset();
  await expect(s.service.control("mcp_copy", {}, s.win)).rejects.toThrow();
});
it("dispatches hostname and uptime; preserves reported failure and denial without inventing an exit code", async () => {
  const s = await setup();
  for (const [command, status, text] of [
    ["hostname", "operator_confirmed_completed", "fixture-linux"],
    ["uptime", "operator_confirmed_completed", "up 3 days"],
    ["false", "operator_reported_failure", "fixture failure"],
    ["restricted", "operator_reported_policy_denied", "fixture: blocked by ACL"]
  ]) {
    expect(await s.call("run_command", { command })).toMatchObject({
      assetId: "linux",
      accountId: "ops",
      status,
      output: text,
      exitCode: null
    });
  }
  expect(s.sent).toEqual(["hostname\r", "uptime\r", "false\r", "restricted\r"]);
});
it("applies the saved mode to exact commands and returns diagnostic output without either local prompt", async () => {
  const s = await setup();
  for (const [mode, command, automatic] of [
    ["assisted", "hostname", true],
    ["assisted", "uname -r", false],
    ["full", "uname -r", true],
    ["full", "hostname && uptime", false],
    ["ask", "hostname", false]
  ] as const) {
    const p = await s.policy.load();
    await s.policy.save({ ...p, grants: p.grants.map((g) => ({ ...g, approvalMode: mode })) });
    s.idleShell();
    mock.dialog.showMessageBox.mockClear();
    if (!automatic) mock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const result = await s.call("run_command", { command });
    if (automatic) {
      expect(mock.dialog.showMessageBox).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "output_observed", output: "fixture-output", exitCode: null });
    } else {
      expect(mock.dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(result.error).toMatch(/declined/i);
    }
  }
});

it("checks account, operation, live server permission and human rejection before dispatch", async () => {
  const s = await setup();
  expect((await s.call("run_command", { accountId: "root", command: "hostname" })).error).toMatch(/grant/i);
  mock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
  expect((await s.call("run_command", { command: "uptime" })).error).toMatch(/declined/i);
  s.auth.apiRequest.mockResolvedValueOnce({ id: "linux", type: { value: "linux" }, permed_accounts: [] });
  expect((await s.call("run_command", { command: "hostname" })).error).toMatch(/unavailable/i);
  const p = await s.policy.load();
  await s.policy.save({ ...p, grants: [] });
  expect((await s.call("run_command", { command: "hostname" })).error).toMatch(/grant/i);
  expect(s.sent).toEqual([]);
});
it("reads a log, round trips binary files, rejects path traversal and preserves existing destinations", async () => {
  const s = await setup();
  expect((await s.call("read_log", { path: "/var/log/test.log" })).output).toBe("one\ntwo");
  expect((await s.call("read_log", { path: "/var/log/../secret" })).error).toBeTruthy();
  expect((await s.call("sftp_upload", { path: "/tmp/test.bin" })).bytes).toBe(4);
  expect((await s.call("sftp_upload", { path: "/tmp/test.bin" })).error).toBeTruthy();
  expect((await s.call("sftp_download", { path: "/tmp/test.bin" })).bytes).toBe(4);
  expect(await readFile(s.dest)).toEqual(s.data);
  expect((await s.call("sftp_download", { path: "/tmp/test.bin" })).error).toBeTruthy();
});

it("enforces read-only grants and rechecks a grant revoked during the native confirmation", async () => {
  const s = await setup();
  const p = await s.policy.load();
  await s.policy.save({ ...p, grants: p.grants.map((g) => ({ ...g, permissions: ["logs"] })) });
  expect((await s.call("sftp_download", { path: "/var/log/test.log" })).error).toMatch(/grant/i);
  expect((await s.call("run_command", { command: "hostname" })).error).toMatch(/grant/i);
  mock.dialog.showMessageBox.mockImplementationOnce(async () => {
    await s.policy.save({ ...(await s.policy.load()), grants: [] });
    return { response: 1 };
  });
  expect((await s.call("read_log", { path: "/var/log/test.log" })).error).toMatch(/expired/i);
  expect(s.sent).toEqual([]);
});
