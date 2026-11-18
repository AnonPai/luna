import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const ops = ["command", "logs", "upload", "download"] as const;
export type Op = (typeof ops)[number];
export interface Call {
  op: Op;
  assetId: string;
  accountId: string;
  value: string;
}
const names = { command: "run_command", logs: "read_log", upload: "sftp_upload", download: "sftp_download" };
const descriptions = {
  command:
    "Submit one command to the selected live Linux terminal. A person confirms dispatch and reports the observed outcome in Luna.",
  logs: "Read the last 100 lines of a regular text log under /var/log via the selected SFTP session (up to 1 MiB).",
  upload: "Upload a file chosen in Luna to a new absolute SFTP path (up to 1 MiB).",
  download: "Download a regular file via SFTP to a new local file chosen in Luna (up to 1 MiB)."
};
const str = { type: "string" };
const empty = { type: "object", properties: {}, additionalProperties: false };
const tools = [
  {
    name: "list_grants",
    description: "List enabled asset and account IDs and allowed operations.",
    inputSchema: empty
  },
  ...ops.map((op) => {
    const arg = op === "command" ? "command" : "path";
    return {
      name: names[op],
      description: descriptions[op],
      inputSchema: {
        type: "object",
        properties: { assetId: str, accountId: str, [arg]: str },
        required: ["assetId", "accountId", arg],
        additionalProperties: false
      }
    };
  })
];
export function parseCall(name: string, args: Record<string, unknown>): Call {
  const op = ops.find((o) => names[o] === name);
  if (!op || !args || typeof args !== "object") throw new Error("Invalid tool or arguments");
  const field = op === "command" ? "command" : "path";
  const { assetId, accountId } = args;
  const value = args[field];
  if (
    Object.keys(args).some((k) => !["assetId", "accountId", field].includes(k)) ||
    typeof assetId !== "string" ||
    !assetId ||
    assetId.length > 256 ||
    typeof accountId !== "string" ||
    !accountId ||
    accountId.length > 256 ||
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1024 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
    throw new Error("Invalid arguments");
  if (
    op !== "command" &&
    (!value.startsWith("/") ||
      value
        .slice(1)
        .split("/")
        .some((p) => !p || p === "." || p === "..") ||
      value.includes("\\"))
  )
    throw new Error("Use an absolute POSIX file path");
  if (op === "logs" && !value.startsWith("/var/log/")) throw new Error("Log files must be under /var/log");
  return { op, assetId, accountId, value };
}

export async function listenMcp(
  active: () => boolean,
  grants: () => Promise<unknown>,
  execute: (c: Call) => Promise<unknown>,
  port = 18761
) {
  const secret = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${secret}`);
  let busy = false;
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    const end = (status: number, body?: unknown) => {
      res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const addr = server.address();
    const host = typeof addr === "object" && addr ? `127.0.0.1:${addr.port}` : "";
    if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`))
      return end(403);
    if (req.url !== "/mcp") return end(404);
    const auth = Buffer.from(req.headers.authorization || "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected) || !active()) return end(401);
    if (req.method !== "POST") return end(405);
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return end(415);
    const version = req.headers["mcp-protocol-version"];
    if (version && version !== "2025-06-18") return end(400);
    let msg;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 16384) return end(413);
        chunks.push(chunk);
      }
      msg = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return end(400);
    }
    if (!active()) return end(401);
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return end(400);
    if (msg.id === undefined && msg.method.startsWith("notifications/")) return end(202);
    if (typeof msg.id !== "string" && !Number.isSafeInteger(msg.id)) return end(400);
    const result = (value: unknown) => end(200, { jsonrpc: "2.0", id: msg.id, result: value });
    const error = (code: number, message: string) => end(200, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    if (msg.method === "initialize")
      return result({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "luna-local", version: "5.1.0-test" }
      });
    if (msg.method === "ping") return result({});
    if (msg.method === "tools/list") return result({ tools });
    if (msg.method !== "tools/call") return error(-32601, "Unknown method");
    const content = (data: unknown) => [{ type: "text", text: JSON.stringify(data) }];
    if (busy) return result({ isError: true, content: content({ error: "Another request is active" }) });
    busy = true;
    try {
      const data =
        msg.params?.name === "list_grants"
          ? await grants()
          : await execute(parseCall(msg.params?.name, msg.params?.arguments));
      if (!active()) return end(401);
      const status=typeof data==="object" && data && "status" in data ? data.status : "";
      return result({ isError: status==="operator_reported_failure" || status==="operator_reported_policy_denied", content: content(data) });
    } catch (cause) {
      return result({
        isError: true,
        content: content({ error: cause instanceof Error ? cause.message : "Request failed" })
      });
    } finally {
      busy = false;
    }
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const addr = server.address();
  return {
    secret,
    url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}/mcp`,
    close() {
      server.close();
      server.closeAllConnections();
    }
  };
}
