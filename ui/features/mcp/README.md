# Luna 桌面端 MCP 设置

基线为官方 `jumpserver/luna` 的 `client-v5.1.0`，提交 `ed5ff185a0fc70603652309acbd40d4398fc81a5`。登录桌面客户端后，从设置侧栏打开 **MCP 设置**。

搜索资产并点选，勾选账号可用的操作。在「已选资产与账号」中可以取消勾选整个资产，保留账号选择。点击「保存权限」后生效。移除行会清除该账号的本地授权。重载会丢弃未保存的修改。

资产列表和账号列表分别使用 Luna 的 `getAuthorizedAssets` 和 `getAssetDetailRequest`。Electron 主进程按站点、当前登录账号及组织分开存储本地策略，每个授权精确匹配资产 ID、资产账号 ID 和操作。重新打开设置时会从磁盘读取。并发保存使用版本检查。策略文件仅含显示名称、标识、勾选状态和版本。

## Windows 测试包

解压整个目录后运行 `JumpServer.exe`。这是未签名的 x64 测试构建。客户端使用上游的单实例和 `jms2` 协议注册行为。有正式版在运行时，先保存工作并正常退出，再启动测试版，以免打开原客户端。测试包没有随附可选的本地人脸识别引擎；服务器要求的验证仍须满足。

在「设置 → MCP 设置」保存授权并启动服务，复制访问令牌。MCP 固定监听 `127.0.0.1:18761`，每次启动生成新的 256 位访问令牌。停止、退出登录或切换账号、站点、组织后需要重新启动并复制新令牌。该令牌与 JumpServer 登录凭据分开。

在同一个 PowerShell 会话中执行以下命令。首次添加一次 `luna` 即可。后续换令牌时重新读取剪贴板并在此 PowerShell 中重新启动 Codex。Codex Desktop 若已在运行，其进程不会继承这个 PowerShell 的新环境。

```powershell
$env:LUNA_MCP_TOKEN = (Get-Clipboard -Raw).Trim()
Set-Clipboard -Value ' '
codex mcp add luna --url http://127.0.0.1:18761/mcp --bearer-token-env-var LUNA_MCP_TOKEN
codex
```

涉及人工审批时，可在 Codex 的 `[mcp_servers.luna]` 配置段中设置 `tool_timeout_sec = 200`。若客户端先行超时，在 Luna 中查看请求状态，再决定是否重试，避免重复执行。

| 工具 | 在 Luna 中的使用条件与结果 |
| --- | --- |
| `list_grants` | 返回当前身份已启用的资产 ID、账号 ID 和本地操作权限。 |
| `run_command` | 打开对应 Linux 资产和托管账号的 SSH 终端，保持目标终端可见并停在空闲 shell 提示符。确认请求后，原样提交一行命令。通过 JumpServer 的正常终端界面处理审批，在 Luna 通知中选择已完成、执行失败或策略拒绝。输出来自终端屏幕，包含回显及提示符。状态来自操作者，`exitCode` 为 `null`。110 秒未确认时返回 `unconfirmed`。 |
| `read_log` | 打开该账号的 SFTP 面板。读取 `/var/log/` 下的 UTF-8 常规文件，检查目录和文件类型，最多返回末尾 100 行及 16000 字符。 |
| `sftp_upload` | 在本机选择源文件，使用 KoKo 文件传输协议写入指定的绝对远程路径，冲突策略为跳过。 |
| `sftp_download` | 从指定的常规文件读取数据，校验分块摘要，在本机选定的新路径保存。目标文件系统须支持硬链接，已有文件会保留。 |

在「已选资产与账号」中为每个有命令权限的账号选择模式，然后保存。旧授权默认「请求批准」。选择「帮我批准」会自动放行 hostname、uptime；选择「完全访问（内置诊断）」还可直接执行 uname -r、whoami、pwd、date -u、nproc、free -m 和 df -h /。命令按整行精确匹配，目录外的命令走原人工确认。自动模式要求前台 Ubuntu 终端停在可识别的空提示符；读到命令回显和相同提示符后返回 output_observed，exitCode 为 null。日志及 SFTP 操作仍逐次确认。每个文件限 1 MiB。文件操作依赖 KoKo 分块传输能力。资产必须在当前服务端详情中识别为 Linux，账号须具有确定的 ID。测试包只使用本次客户端进程中通过普通登录授权建立的连接。由 SSH 连接交换出的 SFTP 会话沿用其绑定。连接不匹配时返回失败。每次操作会核对服务端资产及账号和本地授权，在审批后、分块间及返回结果前复核本地授权。已送入终端的命令仍由活动的 JumpServer 会话管理。

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
