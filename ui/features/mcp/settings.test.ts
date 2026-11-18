import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import page from "../../pages/setting/mcp.vue?raw";

it("compiles the settings page and edits an account grant through the actual component", async () => {
  const { descriptor } = parse(page);
  const script = compileScript(descriptor, { id: "mcp-settings" });
  const template = compileTemplate({
    id: "mcp-settings",
    filename: "mcp.vue",
    source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ["typescript"] }
  });
  expect(template.errors).toEqual([]);
  const loaded = { scope: "fixture", revision: "", grants: [] };
  const invoke = vi.fn(async (name, args) =>
    name === "mcp_permissions_load" ? loaded : { ...args, revision: "saved" }
  );
  const list = vi.fn(async () => ({ count: 1, results: [{ id: "a", name: "host", address: "fixture" }] }));
  const detail = vi.fn(async () => ({ id: "a", name: "host", permed_accounts: [{ id: "u", name: "ops" }] }));
  const user = Vue.reactive({ currentAccountId: "user", currentUser: { org: { id: "org" } }, loggedIn: true });
  const modules: Record<string, unknown> = {
    vue: Vue,
    "~/composables/useApiRequest": { getAuthorizedAssets: list, getAssetDetailRequest: detail },
    "~/shared/desktop/bridge": { desktopInvoke: invoke },
    "~/store/modules/userInfo": { useUserInfoStore: () => user },
    "~/features/mcp/messages.json": {}
  };
  const globals = {
    ref: Vue.ref,
    computed: Vue.computed,
    watch: Vue.watch,
    onBeforeUnmount: Vue.onBeforeUnmount,
    useI18n: () => ({ t: (s: string) => s }),
    isDesktopRuntime: () => true
  };
  const js = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const component = new Function(
    "require",
    ...Object.keys(globals),
    `const exports={};\n${js}\nreturn exports.default;`
  )((id: string) => modules[id], ...Object.values(globals));
  const setup = component.setup;
  let state: ReturnType<typeof setup>;
  component.setup = (props: unknown, context: unknown) => {
    state = setup(props, context);
    return () => null;
  };
  const renderer = Vue.createRenderer({
    insert() {},
    remove() {},
    patchProp() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null
  });
  const app = renderer.createApp(component);
  app.mount({});
  try {
    await vi.waitFor(() => expect(state.assets.value).toHaveLength(1));
    expect(list).toHaveBeenCalledWith({ search: "", limit: 20, offset: 0 }, "org");
    await state.select("a");
    state.toggle("u", "logs", true);
    state.toggle("u", "upload", true);
    state.toggle("u", "logs", false);
    await state.save();
    expect(invoke).toHaveBeenLastCalledWith(
      "mcp_permissions_save",
      expect.objectContaining({
        account: "user",
        org: "org",
        grants: [
          {
            enabled: true,
            assetId: "a",
            assetName: "host",
            accountId: "u",
            accountName: "ops",
            permissions: ["upload"]
          }
        ]
      })
    );
    expect(state.dirty.value).toBe(false);
    user.loggedIn = false;
    await Vue.nextTick();
    expect(state.draft.value).toEqual([]);
    expect(state.available.value).toBe(false);
  } finally {
    app.unmount();
  }
});
