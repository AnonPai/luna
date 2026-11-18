<script setup lang="ts">
import { desktopInvoke } from "~/shared/desktop/bridge";
const url = ref("");
const message = ref("");
const busy = ref(false);
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
let timer: ReturnType<typeof setInterval> | undefined;
async function status() {
  try {
    url.value = await desktopInvoke<string>("mcp_status");
  } catch {
    url.value = "";
  }
}
async function action(cmd: string) {
  busy.value = true;
  message.value = "";
  try {
    await desktopInvoke(cmd);
    if (cmd === "mcp_copy") message.value = zh.value ? "本机 MCP 令牌已复制" : "Local MCP token copied";
    await status();
  } catch {
    message.value = zh.value
      ? "操作失败，请检查登录状态及端口 18761 是否已占用。"
      : "Check the login and availability of port 18761.";
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void status();
  timer = setInterval(status, 3000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <SettingsSection :title="zh ? '本机 MCP 服务' : 'Local MCP service'">
    <div class="flex flex-wrap items-center gap-3">
      <UButton :loading="busy" @click="action(url ? 'mcp_stop' : 'mcp_start')">
        {{ url ? (zh ? "停止服务" : "Stop service") : zh ? "启动服务" : "Start service" }}
      </UButton>
      <code v-if="url">{{ url }}</code>
      <UButton v-if="url" variant="outline" :disabled="busy" @click="action('mcp_copy')">
        {{ zh ? "复制访问令牌" : "Copy access token" }}
      </UButton>
    </div>
    <p role="status">{{ message }}</p>
  </SettingsSection>
</template>
