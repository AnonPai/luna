# Luna 桌面端 MCP 设置

基线为官方 `jumpserver/luna` 的 `client-v5.1.0`，提交 `ed5ff185a0fc70603652309acbd40d4398fc81a5`。登录桌面客户端后，从设置侧栏打开 **MCP 设置**。

搜索资产并点选，勾选账号可用的操作并保存。启动本机 MCP 服务后复制访问令牌。请在同一个 PowerShell 窗口设置令牌并启动 Codex：

```powershell
$env:LUNA_MCP_TOKEN = (Get-Clipboard -Raw).Trim()
Set-Clipboard -Value ' '
codex mcp add luna --url http://127.0.0.1:18761/mcp --bearer-token-env-var LUNA_MCP_TOKEN
codex
```

只需添加一次 MCP 配置。服务重启后请更新环境变量并重新启动 Codex。

## 操作授权模式

在「已选资产与账号」为对应账号选择模式并保存。升级后保留原资产和操作勾选，旧模式回到「请求批准」，避免自动扩大文件权限。

| 模式 | Luna 的处理 |
| --- | --- |
| 请求批准 | 每次在本机显示目标、账号、操作和命令或路径，由操作者决定。 |
| 帮我批准 | 对可判定的诊断命令、日志读取和防覆盖文件传输，Luna 调用本机 Codex CLI 审核。只有模型明确返回 APPROVE 才放行。模型要求人工、返回异常、未登录或 45 秒超时都转人工。 |
| 完全访问 | 已勾选的结构化日志和文件操作、可判定的只读诊断直接放行。上传和下载直接使用专用目录。 |

三种模式下，删除、截断、脚本、组合命令和其他无法判定影响的自由 shell 均逐次人工审核。命令语法覆盖 hostname、uptime、uname、whoami、pwd、date、nproc、free、df 的受支持只读形式，如 uname -a、uptime -p、free -h、df -h /。交互终端须停在可识别的空提示符。自动返回的 output_observed 表示观察到输出，exitCode 为 null。成功响应的 approval 字段标明 human、agent 或 full。

Agent 使用已经登录的 Windows Codex CLI 和其模型服务。审核输入仅含已识别的诊断命令或通用文件操作描述。资产地址、账号、文件路径、文件内容和 JumpServer 凭据不进入审核提示。默认查找 WindowsApps 下的 codex.exe，也可在启动 Luna 前用 LUNA_REVIEW_CODEX_EXE 指定可信 Codex 可执行文件的绝对路径。每次审核使用临时工作目录；Luna 以只读沙箱启动审核进程并禁用 shell、插件和 hooks。

调用 list_grants 获取该账号的 uploadDir 和 downloadDir。上传前将本地文件放入 uploadDir，文件名与远程目标的 basename 相同；下载成功后查看响应的 localPath。两个方向均防止覆盖，无需文件选择框。每个文件限 1 MiB。文件操作依赖 KoKo 分块传输能力。资产必须在当前服务端详情中识别为 Linux，账号须具有确定的 ID。测试包只使用本次客户端进程中通过普通登录授权建立的连接。由 SSH 连接交换出的 SFTP 会话沿用其绑定。首次调用会按资产 ID 和托管账号 ID 自动打开所需的 SSH 或 SFTP 会话，沿用 JumpServer 审批。每次操作会核对服务端资产及账号和本地授权，在审批后、分块间及返回结果前复核本地授权。已送入终端的命令仍由活动的 JumpServer 会话管理。

在真实环境验收时，可以在一个明确获准的测试账号上执行 `hostname` 和 `uptime`，再试一个由管理员指定的拒绝规则。用同一份测试文件比较上传下载摘要，并按账号、资产和时间在 JumpServer 核对命令、审批和文件审计记录。

## 跟进上游

功能分支为 `feature/windows-local-mcp`。服务逻辑在 `electron/src/desktop/mcp/`，前端适配在 `ui/features/mcp/`。上游接入点为 Electron 主进程、终端及 SFTP 会话注册和设置导航。官方远端为 `origin`。

升级前获取官方标签，用 `git worktree add -b <升级分支> <新目录> <新官方标签>` 建立单独工作树，在新工作树中重放本分支的功能提交。若上游调整了设置系统或 IPC 入口，保留新版本的结构，重新接入对应入口。升级分支验证通过后再合并。

## 本地验证

在仓库根目录运行以下命令。组件测试使用模拟资产和模拟 IPC。权限测试使用临时目录及模拟登录身份。

```powershell
pnpm install --frozen-lockfile
node --import tsx --test electron/tests/mcp-permissions.test.ts
pnpm exec vitest run --browser.enabled=false ui/features/mcp
pnpm exec vitest run --config tests/mcp/vitest.config.mts
pnpm typecheck:web
pnpm typecheck:electron
pnpm generate:client
```

Windows x64 打包使用 Node 24、pnpm 11.4.0 和满足 `electron/ssh-helper/go.mod` 的 Go 工具链。先运行 `pnpm electron:prepare`，再运行 `pnpm --dir electron package`。本次机器缺少用于重新编译 node-pty 的 Visual Studio Spectre 库，打包时临时为 Forge 的 `rebuildConfig.ignoreModules` 设置 `["node-pty"]`，保留 npm 包自带的 Windows x64 原生模块。源码中的官方 Forge 配置保持原样。已从最终 app.asar 加载 node-pty 并验证了 Windows PTY 输出。
