<script setup lang="ts">
import type { ApprovalMode } from "../../../shared/mcp/command-policy";
defineProps<{ disabled: boolean }>();
const mode = defineModel<ApprovalMode>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const id = useId();
const choices = computed(() => [
  { value: "ask", label: zh.value ? "请求批准" : "Ask for approval" },
  { value: "assisted", label: zh.value ? "帮我批准" : "Approve for me" },
  { value: "full", label: zh.value ? "完全访问" : "Full access" }
]);
</script>

<template>
  <div class="mt-2 space-y-1">
    <label :for="id" class="block text-sm">{{ zh ? "操作授权模式" : "Operation approval mode" }}</label>
    <USelect
      :id="id"
      :model-value="mode || 'ask'"
      :items="choices"
      :disabled="disabled"
      @update:model-value="mode = $event as ApprovalMode"
    />
    <p class="text-xs text-muted">
      <template v-if="!mode || mode === 'ask'">
        {{ zh ? "每次操作均在 Luna 中确认。" : "Confirm each operation in Luna." }}
      </template>
      <template v-else>
        <template v-if="mode === 'assisted'">
          {{
            zh
              ? "由本机 Codex 调用模型审核诊断命令或文件操作类型；要求人工或服务不可用时弹窗。"
              : "Local Codex requests a model decision for diagnostics and file operations. A human reviews escalations and unavailable decisions."
          }}
        </template>
        <template v-else>
          {{
            zh
              ? "已授权的只读诊断、日志读取和防覆盖传输直接放行。"
              : "Granted read-only diagnostics, log reads and no-overwrite transfers proceed directly."
          }}
        </template>
        {{
          zh
            ? "删除和影响不明的 Shell 命令必须人工审核。传输时仍需选本地文件。JumpServer 审批继续生效。"
            : "Deletion and unclassified shell commands require human approval. Transfers still use the file picker. JumpServer approvals remain in effect."
        }}
      </template>
    </p>
  </div>
</template>
