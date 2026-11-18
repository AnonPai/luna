import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalMode } from "../../../shared/mcp/command-policy";

export const operations = ["command", "logs", "upload", "download"] as const;
type Operation = (typeof operations)[number];
type Grant = {
  approvalMode?: ApprovalMode;
  enabled: boolean;
  assetId: string;
  assetName: string;
  accountId: string;
  accountName: string;
  permissions: Operation[];
};
type Policy = { revision: string; grants: Grant[] };
type Identity = { origin: string; sessionKey: string; orgId: string };

function checkedGrants(value: unknown): Grant[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error("Invalid MCP grants");
  const seen = new Set<string>();
  return value.map((row) => {
    if (
      !row ||
      typeof row.enabled !== "boolean" ||
      ![row.assetId, row.assetName, row.accountId, row.accountName].every(
        (field) => typeof field === "string" && field.trim().length > 0 && field.length <= 256
      ) ||
      !Array.isArray(row.permissions) ||
      !row.permissions.length ||
      !row.permissions.every((item: Operation) => operations.includes(item))
    )
      throw new Error("Invalid MCP grant");
    const key = JSON.stringify([row.assetId, row.accountId]);
    if (seen.has(key)) throw new Error("Duplicate MCP grant");
    seen.add(key);
    return {
      ...(row.approvalMode === "assisted" || row.approvalMode === "full" ? { approvalMode: row.approvalMode } : {}),
      enabled: row.enabled,
      assetId: row.assetId,
      assetName: row.assetName,
      accountId: row.accountId,
      accountName: row.accountName,
      permissions: operations.filter((p) => row.permissions.includes(p))
    };
  });
}

export class McpPermissions {
  private pending = Promise.resolve();
  constructor(
    private directory: string,
    private current: () => Identity
  ) {}

  private scope() {
    const { origin, sessionKey, orgId } = this.current();
    if (!origin || !sessionKey) throw new Error("Login required");
    return createHash("sha256")
      .update(JSON.stringify([origin, sessionKey, orgId || ""]))
      .digest("hex");
  }

  private async read(scope: string): Promise<Policy> {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, `${scope}.json`), "utf8"));
      if (typeof data.revision !== "string") throw new Error("Invalid MCP revision");
      const grants = checkedGrants(data.grants);
      // Older modes covered commands only. Require a new selection before applying them to file operations.
      if (data.modeVersion !== 3) for (const grant of grants) delete grant.approvalMode;
      return { revision: data.revision, grants };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: "", grants: [] };
      throw error;
    }
  }

  async load() {
    const scope = this.scope();
    const policy = await this.read(scope);
    if (this.scope() !== scope) throw new Error("MCP identity changed");
    return { scope, ...policy };
  }

  save(input: { scope: string; revision: string; grants: unknown }) {
    const scope = this.scope();
    if (scope !== input.scope) throw new Error("MCP identity changed");
    const grants = checkedGrants(input.grants);
    const change = this.pending.then(async () => {
      const previous = await this.read(scope);
      if (input.revision !== previous.revision) throw new Error("MCP settings changed. Reload before saving.");
      const policy = { revision: randomUUID(), grants };
      await mkdir(this.directory, { recursive: true });
      const filename = path.join(this.directory, `${scope}.json`);
      const temp = `${filename}.${policy.revision}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ ...policy, modeVersion: 3 }), { flag: "wx", mode: 0o600 });
        if (scope !== this.scope()) throw new Error("MCP identity changed");
        await rename(temp, filename);
      } finally {
        await rm(temp, { force: true });
      }
      return { scope, ...policy };
    });
    this.pending = change.then(
      () => {},
      () => {}
    );
    return change;
  }

  async permits(assetId: string, accountId: string, operation: Operation) {
    const { grants } = await this.load();
    return grants.some(
      (row) =>
        row.enabled && row.assetId === assetId && row.accountId === accountId && row.permissions.includes(operation)
    );
  }

  async transferFolder(assetId: string, accountId: string, operation: "upload" | "download") {
    const scope = this.scope();
    const key = createHash("sha256")
      .update(JSON.stringify([scope, assetId, accountId]))
      .digest("hex");
    let dir = await realpath(this.directory);
    for (const part of ["transfers", key, operation]) {
      dir = path.join(dir, part);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (path.relative(dir, await realpath(dir))) throw new Error("Transfer folder must not be redirected");
    }
    if (scope !== this.scope()) throw new Error("MCP identity changed");
    return dir;
  }
}
