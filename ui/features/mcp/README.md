# Luna 桌面端 MCP 设置

基线为官方 `jumpserver/luna` 的 `client-v5.1.0`，提交 `ed5ff185a0fc70603652309acbd40d4398fc81a5`。登录桌面客户端后，从设置侧栏打开 **MCP 设置**。

搜索资产并点选，勾选账号可用的操作。在「已选资产与账号」中可以取消勾选整个资产，保留账号选择。点击「保存权限」后生效。移除行会清除该账号的本地授权。重载会丢弃未保存的修改。

资产列表和账号列表分别使用 Luna 的 `getAuthorizedAssets` 和 `getAssetDetailRequest`。Electron 主进程按站点、当前登录账号及组织分开存储本地策略，每个授权精确匹配资产 ID、资产账号 ID 和操作。重新打开设置时会从磁盘读取。并发保存使用版本检查。策略文件仅含显示名称、标识、勾选状态和版本。

本提交交付设置页及权限判断。后续接入 MCP 工具时，每次操作应以实际连接绑定的资产及账号调用 `McpPermissions.permits`，并通过 JumpServer 重新核实权限。服务端负责命令过滤、审批及审计。设置页本身不会开启 HTTP 监听或执行资产操作。

## 跟进上游

功能分支为 `feature/windows-local-mcp`。四个上游接入点分别是 Electron 的 `desktop/main.ts`、设置导航 `settingsPanel.vue`、设置路径解析 `useSettingsWindow.ts` 和内嵌页面注册 `layouts/default.vue`。业务页面、权限存储、文案和测试独立维护。官方远端为 `origin`。

升级前获取官方标签，用 `git worktree add -b <升级分支> <新目录> <新官方标签>` 建立单独工作树，在新工作树中重放本分支的功能提交。若上游调整了设置系统或 IPC 入口，保留新版本的结构，重新接入对应入口。升级分支验证通过后再合并。

## 本地验证

在仓库根目录运行以下命令。组件测试使用模拟资产和模拟 IPC。权限测试使用临时目录及模拟登录身份。

```powershell
pnpm install --frozen-lockfile
node --import tsx --test electron/tests/mcp-permissions.test.ts
pnpm exec vitest run --browser.enabled=false ui/features/mcp/settings.test.ts
pnpm typecheck:web
pnpm typecheck:electron
pnpm generate:client
```
