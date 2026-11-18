<script setup lang="ts">
import type { ApprovalMode } from "../../../shared/mcp/command-policy";
import type { AssetDetail } from "~/types";
import { getAssetDetailRequest, getAuthorizedAssets } from "~/composables/useApiRequest";
import CommandApprovalSelect from "~/features/mcp/CommandApprovalSelect.vue";
import messages from "~/features/mcp/messages.json";
import McpServiceControl from "~/features/mcp/ServiceControl.vue";
import { desktopInvoke } from "~/shared/desktop/bridge";
import { useUserInfoStore } from "~/store/modules/userInfo";

const actions = ["command", "logs", "upload", "download"] as const;
type Action = (typeof actions)[number];
interface Grant {
  approvalMode?: ApprovalMode;
  enabled: boolean;
  assetId: string;
  assetName: string;
  accountId: string;
  accountName: string;
  permissions: Action[];
}
interface Policy {
  scope: string;
  revision: string;
  grants: Grant[];
}
const { t } = useI18n({ useScope: "local", messages });
const user = useUserInfoStore();
const identity = computed(() => ({ account: user.currentAccountId, org: user.currentUser?.org?.id || "" }));
const available = computed(() => isDesktopRuntime() && user.loggedIn && Boolean(identity.value.account));
const policy = ref<Policy>();
const draft = ref<Grant[]>([]);
const groups = computed(() =>
  Object.values(Object.groupBy(draft.value, (row) => row.assetId)).filter((rows): rows is Grant[] =>
    Boolean(rows?.length)
  )
);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(policy.value?.grants || []));
const query = ref("");
const offset = ref(0);
const count = ref(0);
const assets = ref<{ id: string; name: string; address: string }[]>([]);
const details = ref<AssetDetail>();
const selected = ref("");
const loading = ref(false);
const loadingAccounts = ref(false);
const saving = ref(false);
const error = ref("");
const saved = ref(false);
let generation = 0;
let searchId = 0;
let detailId = 0;

async function refresh() {
  const id = ++generation;
  ++searchId;
  ++detailId;
  policy.value = undefined;
  assets.value = [];
  count.value = offset.value = 0;
  selected.value = query.value = error.value = "";
  draft.value = [];
  details.value = undefined;
  saved.value = saving.value = loadingAccounts.value = loading.value = false;
  if (!available.value) return;
  try {
    const loaded = await desktopInvoke<Policy>("mcp_permissions_load", identity.value);
    if (generation !== id) return;
    policy.value = loaded;
    draft.value = structuredClone(loaded.grants);
    await search(0);
  } catch {
    if (generation === id) error.value = t("Mcp.LoadError");
  }
}

async function search(start: number) {
  const id = ++searchId;
  ++detailId;
  loadingAccounts.value = false;
  selected.value = "";
  details.value = undefined;
  assets.value = [];
  count.value = 0;
  loading.value = true;
  error.value = "";
  try {
    const response = await getAuthorizedAssets(
      { search: query.value.trim(), limit: 20, offset: start },
      identity.value.org
    );
    if (id !== searchId) return;
    assets.value = response.results
      .filter((a) => a.is_active !== false && typeof a.id === "string")
      .map((a) => ({ id: String(a.id), name: String(a.name || a.id), address: String(a.address || "") }));
    count.value = response.count;
    offset.value = start;
  } catch {
    if (id === searchId) error.value = t("Mcp.LoadError");
  } finally {
    if (id === searchId) loading.value = false;
  }
}

async function select(id: string) {
  const request = ++detailId;
  selected.value = id;
  details.value = undefined;
  error.value = "";
  loadingAccounts.value = true;
  try {
    const detail = await getAssetDetailRequest(id, identity.value.org);
    if (request !== detailId) return;
    if (detail.id !== id || detail.is_active === false) throw new Error();
    details.value = detail;
  } catch {
    if (request === detailId) error.value = t("Mcp.LoadError");
  } finally {
    if (request === detailId) loadingAccounts.value = false;
  }
}

const accounts = computed(() =>
  (details.value?.permed_accounts || details.value?.permedAccounts || []).filter((a) => a.id)
);
function grantFor(accountId: string) {
  return draft.value.find((row) => row.assetId === selected.value && row.accountId === accountId);
}

function toggle(accountId: string, action: Action, checked: boolean) {
  const account = accounts.value.find((a) => a.id === accountId);
  if (!account || !details.value || saving.value) return;
  const row = grantFor(accountId);
  const enabled = draft.value.find((r) => r.assetId === selected.value)?.enabled ?? true;
  const permissions = new Set(row?.permissions || []);
  if (checked) permissions.add(action);
  else permissions.delete(action);
  draft.value = draft.value.filter((r) => r !== row);
  if (permissions.size)
    draft.value.push({
      ...(row?.approvalMode && permissions.has("command") ? {approvalMode:row.approvalMode} : {}),
      enabled,
      assetId: selected.value,
      assetName: details.value.name || selected.value,
      accountId,
      accountName: account.name || account.username || accountId,
      permissions: actions.filter((p) => permissions.has(p))
    });
  saved.value = false;
}

async function save() {
  if (!policy.value || saving.value) return;
  const id = generation;
  saving.value = true;
  saved.value = false;
  error.value = "";
  try {
    const next = await desktopInvoke<Policy>("mcp_permissions_save", {
      ...identity.value,
      scope: policy.value.scope,
      revision: policy.value.revision,
      grants: JSON.parse(JSON.stringify(draft.value))
    });
    if (id !== generation) return;
    policy.value = next;
    draft.value = structuredClone(next.grants);
    saved.value = true;
  } catch {
    if (id === generation) error.value = t("Mcp.SaveError");
  } finally {
    if (id === generation) saving.value = false;
  }
}

watch([identity, available], refresh, { immediate: true });
onBeforeUnmount(() => {
  ++generation;
  ++detailId;
  ++searchId;
});
</script>

<template>
  <div v-if="available" class="space-y-6">
    <McpServiceControl />
    <p v-if="error" role="alert" class="text-error">
      {{ error }}
      <UButton color="neutral" variant="link" :disabled="saving" @click="refresh">{{ t("Mcp.Reload") }}</UButton>
    </p>
    <template v-if="policy">
      <SettingsSection :title="t('Mcp.Assets')">
        <form class="flex gap-2" @submit.prevent="search(0)">
          <UInput v-model="query" class="flex-1" :aria-label="t('Mcp.Search')" :placeholder="t('Mcp.Search')" />
          <UButton type="submit" :loading="loading">{{ t("Mcp.Search") }}</UButton>
        </form>
        <div class="grid gap-2 sm:grid-cols-2">
          <UButton
            v-for="asset in assets"
            :key="asset.id"
            color="neutral"
            :variant="selected === asset.id ? 'solid' : 'outline'"
            :aria-pressed="selected === asset.id"
            @click="select(asset.id)"
          >
            {{ asset.name }} · {{ asset.address }}
          </UButton>
        </div>
        <p v-if="!loading && !assets.length && !error" class="text-muted">{{ t("Mcp.NoAssets") }}</p>
        <div v-if="count > 20" class="flex gap-2">
          <UButton :disabled="offset === 0 || loading" @click="search(offset - 20)">←</UButton>
          <span>{{ offset + 1 }}–{{ Math.min(offset + 20, count) }} / {{ count }}</span>
          <UButton :disabled="offset + 20 >= count || loading" @click="search(offset + 20)">→</UButton>
        </div>
      </SettingsSection>
      <SettingsSection v-if="selected" :title="t('Mcp.Accounts')">
        <p v-if="loadingAccounts" role="status">{{ t("Mcp.Loading") }}</p>
        <p v-else-if="details && !accounts.length">{{ t("Mcp.NoAccounts") }}</p>
        <fieldset v-for="a in accounts" :key="a.id" class="rounded border border-default p-3">
          <legend class="px-1">{{ a.name }} · {{ a.username || a.alias || a.id }}</legend>
          <div class="flex flex-wrap gap-4">
            <UCheckbox
              v-for="action in actions"
              :key="action"
              :label="t(`Mcp.${ action}`)"
              :disabled="saving"
              :model-value="Boolean(grantFor(a.id)?.permissions.includes(action))"
              @update:model-value="toggle(a.id, action, $event === true)"
            />
          </div>
        </fieldset>
      </SettingsSection>
      <SettingsSection :title="t('Mcp.Grants')">
        <p v-if="!draft.length" class="text-muted">{{ t("Mcp.Empty") }}</p>
        <div v-for="rows in groups" :key="rows[0]!.assetId">
          <UCheckbox
            :model-value="rows.every((row) => row.enabled)"
            :label="rows[0]!.assetName"
            :disabled="saving"
            @update:model-value="
              (v) => {
                for (const row of rows) row.enabled = v === true;
                saved = false;
              }
            "
          />
          <div
            v-for="row in rows"
            :key="row.accountId"
            class="flex items-center justify-between gap-3 border-b border-default py-2"
          >
            <div>
              <strong>{{ row.accountName }}</strong>
              <CommandApprovalSelect
v-if="row.permissions.includes('command')" v-model="row.approvalMode"
                :disabled="saving || !row.enabled" @update:model-value="saved = false"
/>
              <p class="text-sm text-muted">{{ row.permissions.map((p) => t(`Mcp.${ p}`)).join(" · ") }}</p>
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="saving"
              @click="
                draft = draft.filter((r) => r !== row);
                saved = false;
              "
            >
              {{ t("Mcp.Remove") }}
            </UButton>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <UButton :loading="saving" :disabled="!dirty" @click="save">{{ t("Mcp.Save") }}</UButton>
          <span role="status">{{ dirty ? t("Mcp.Unsaved") : saved ? t("Mcp.Saved") : "" }}</span>
        </div>
      </SettingsSection>
    </template>
  </div>
</template>
