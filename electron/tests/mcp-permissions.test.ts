import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpPermissions } from "../src/desktop/mcp-permissions";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luna-mcp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { origin: "https://jump.example", orgId: "sales", sessionKey: "user1" };
  const policy = new McpPermissions(directory, () => state);
  const initial = await policy.load();
  const grant = {
    enabled: true,
    assetId: "linux1",
    accountId: "ops",
    assetName: "Linux",
    accountName: "ops",
    permissions: ["logs"]
  };
  return { state, policy, initial, grant, directory };
}

test("only explicitly selected asset, account and operation are permitted after reopening", async (t) => {
  const { state, policy, initial, grant, directory } = await fixture(t);
  assert.equal(await policy.permits("linux1", "ops", "logs"), false);
  await policy.save({ ...initial, grants: [grant] });
  const reopened = new McpPermissions(directory, () => state);
  assert.equal(await reopened.permits("linux1", "ops", "logs"), true);
  assert.equal(await reopened.permits("linux1", "ops", "upload"), false);
  assert.equal(await reopened.permits("linux2", "ops", "logs"), false);
  assert.equal(await reopened.permits("linux1", "root", "logs"), false);
});

test("asset can be disabled or revoked", async (t) => {
  const { policy, initial, grant } = await fixture(t);
  const saved = await policy.save({ ...initial, grants: [grant] });
  const disabled = await policy.save({ ...saved, grants: [{ ...grant, enabled: false }] });
  assert.equal(await policy.permits("linux1", "ops", "logs"), false);
  assert.equal(disabled.grants.length, 1);
  await policy.save({ ...disabled, grants: [] });
  assert.deepEqual((await policy.load()).grants, []);
});

test("old command-only modes cannot silently grant unattended file operations", async (t) => {
  const { policy, initial, grant, directory } = await fixture(t);
  const saved = await policy.save({
    ...initial,
    grants: [{ ...grant, permissions: ["command", "logs"], approvalMode: "full" }]
  });
  const file = path.join(directory, `${saved.scope}.json`);
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.modeVersion;
  await writeFile(file, JSON.stringify(legacy));
  const restored = await policy.load();
  assert.equal(restored.grants[0].approvalMode, undefined);
  assert.deepEqual(restored.grants[0].permissions, ["command", "logs"]);
});

test("approval mode is opt-in and account scoped for command and file grants", async (t) => {
  const { policy, initial, grant, directory, state } = await fixture(t);
  await policy.save({
    ...initial,
    grants: [
      { ...grant, permissions: ["command"], approvalMode: "full" },
      { ...grant, accountId: "other", permissions: ["command"] },
      { ...grant, accountId: "reader", approvalMode: "full" },
      { ...grant, accountId: "unknown-mode", permissions: ["command"], approvalMode: "invalid" }
    ]
  });
  const saved = await new McpPermissions(directory, () => state).load();
  assert.deepEqual(
    saved.grants.map((g) => g.approvalMode ?? "ask"),
    ["full", "ask", "full", "ask"]
  );
});

test("switching site, account or organization isolates grants and rejects stale editors; logout denies access", async (t) => {
  const { policy, initial, grant, state } = await fixture(t);
  const saved = await policy.save({ ...initial, grants: [grant] });
  for (const key of ["orgId", "origin", "sessionKey"] as const) {
    const original = state[key];
    state[key] += "-other";
    assert.equal(await policy.permits("linux1", "ops", "logs"), false);
    assert.throws(() => policy.save(saved), /identity changed/);
    state[key] = original;
  }
  state.sessionKey = "";
  await assert.rejects(policy.permits("linux1", "ops", "logs"), /Login required/);
});

test("concurrent edits have one winner and invalid grants are rejected", async (t) => {
  const { policy, initial, grant } = await fixture(t);
  const results = await Promise.allSettled([policy.save({ ...initial, grants: [grant] }), policy.save(initial)]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected"]
  );
  assert.throws(() => policy.save({ ...initial, grants: [{ ...grant, permissions: ["anything"] }] }), /Invalid/);
  assert.throws(() => policy.save({ ...initial, grants: [grant, grant] }), /Duplicate/);
});
