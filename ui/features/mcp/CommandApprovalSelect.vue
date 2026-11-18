<script setup lang="ts">
import type { ApprovalMode } from '../../../shared/mcp/command-policy';
import { diagnostics } from '../../../shared/mcp/command-policy';
defineProps<{ disabled: boolean }>();
const mode = defineModel<ApprovalMode>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const id = useId();
const choices = computed(() => [
  { value: "ask", label: zh.value ? "请求批准" : "Ask for approval" },
  { value: "assisted", label: zh.value ? "帮我批准" : "Approve for me" },
  { value: "full", label: zh.value ? "完全访问（内置诊断）" : "Full access (built-in diagnostics)" }
]);
</script>

<template>
  <div class="mt-2 space-y-1">
    <label :for="id" class="block text-sm">{{ zh ? "命令授权模式" : "Command approval mode" }}</label>
    <USelect
      :id="id"
      :model-value="mode || 'ask'"
      :items="choices"
      :disabled="disabled"
      @update:model-value="mode = $event as ApprovalMode"
    />
    <p class="text-xs text-muted">
      <template v-if="!mode || mode === 'ask'">
        {{ zh ? "每条命令均在 Luna 中确认。" : "Confirm each command in Luna." }}
      </template>
      <template v-else>
        {{ zh ? "免本地确认：" : "Without local approval: "
        }}{{ mode === "assisted" ? "hostname, uptime" : diagnostics.join(", ") }}.
        {{
          zh
            ? "其他命令逐次确认。JumpServer 审批仍然生效。"
            : "Other commands require confirmation. JumpServer approvals still apply."
        }}
      </template>
    </p>
  </div>
</template>
