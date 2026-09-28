# RunningHub Canvas Bridge

用 MCP 直接操作 RunningHub 无限画布：读取完整提示词、复制模型模板、批量排版、连接参考、上传图片及音视频、提交生成和归档结果。通过本地服务与 Chrome 扩展使用当前登录会话，支持国际站 `www.runninghub.ai` / `rhtv.runninghub.ai`，保留中国站地址识别。

## 功能

- 30 个标准 MCP 工具，配套 HTTP 与 CLI，可接入 Codex 或其他支持 stdio MCP 的客户端。
- 图片、视频、音频上传和生成入口均可用。三类上传已在国际站实测；生成已验证请求预览及模拟提交，本次没有额外提交真实生成。
- 支持文本创建、编辑、移动、连线、删除、刷新后回读，以及空白 H3 模板复制预览。
- 按完整画布网址选择操作目标，支持多标签页。编辑前选择 `allowWrites: true`，无需每次重启服务。
- 登录凭据留在网页内；同步与上传依赖随服务本地加载。

## 安装

需要 Node.js 20.19+、ffmpeg/ffprobe 和已登录 RunningHub 的 Chrome。源码与安装包位于本仓库的 [Releases](https://github.com/limyum-creator/runninghub-canvas-bridge/releases)，无需 npm 注册表发布。

```sh
git clone https://github.com/limyum-creator/runninghub-canvas-bridge.git
cd runninghub-canvas-bridge
npm ci
npm run build
RH_BRIDGE_ALLOW_GENERATION=1 npm start
```

在 `chrome://extensions/` 打开开发者模式，加载本项目 `extension` 文件夹，刷新需要操作的画布。Chrome 的本地网络权限用于连接本机 `http://127.0.0.1:18765`。

macOS 可改为后台常驻，无需保留终端：

```sh
RH_BRIDGE_ALLOW_GENERATION=1 npm run service:install
npm run service:status
```

不要同时启动手动服务与后台服务。后台安装会记住生成开关及当前画布权限，登录后自动启动。其他系统可使用手动服务。

为 Codex 添加 MCP，替换为实际绝对路径：

```sh
codex mcp add runninghub-canvas -- /absolute/path/to/node /absolute/path/to/runninghub-canvas-bridge/server/mcp.mjs
```

其他 stdio MCP 客户端使用相同命令与参数。Chrome、桥接服务和 MCP 应在同一台电脑运行。

## 使用

先调用 `rh_status`，从返回的已连接网址调用 `rh_select_canvas`；需要编辑、上传或运行时设 `allowWrites: true`。

| 用途 | MCP 工具 |
| --- | --- |
| 连接与选画布 | `rh_status`、`rh_select_canvas` |
| 读节点与参考 | `rh_canvas_summary`、`rh_get_node`、`rh_find_nodes`、`rh_connections` |
| 建立与修改 | `rh_create_text_nodes`、`rh_clone_template`、`rh_update_node`、`rh_update_params` |
| 排版与连线 | `rh_move_nodes`、`rh_connect_nodes`、`rh_delete_elements` |
| 上传 | `rh_upload_image`（兼容）和 `rh_upload_media`：图片 30 MiB，音频 50 MiB，视频 500 MiB |
| 自动归档 | `rh_set_archive_target`、`rh_archive_outputs`、`rh_archive_status`、`rh_retry_archive` |
| 生成与结果 | `rh_validate_node`、`rh_run_node`、`rh_node_result`、`rh_command_result` |

编辑和生成支持 `dryRun` 预览，上传不支持预览。H3 从真正空白模板复制，按实时模型字段设置参数。操作后回读完整节点核对文本、参考与参数。

若现有客户端尚未重新加载 MCP，可通过标准 MCP 客户端立即使用：

```sh
node scripts/mcp-call.mjs rh_status
node scripts/mcp-call.mjs rh_canvas_summary --canvas '已连接的完整画布网址'
```

生成和上传使用稳定的 `requestId`。提交超时用 `rh_command_result` 查原请求并读节点状态；去重仅在当前桥接进程存活期间有效，服务重启后也不能盲目重发。节点可能保留上次生成结果，应按本次 taskId 匹配。

## 可选：光栈（Lumen）自动归档

画布读取、编辑、上传、生成和结果查询不依赖光栈。自动归档工具目前对接光栈 MCP，需要另行安装并配置光栈；未设置归档目标时，`rh_run_node` 仅提交平台任务。

使用归档时，先确定目标项目与作品（Work），再用 `rh_set_archive_target` 绑定节点。后续 `rh_run_node` 自动登记回收任务，按本次 taskId 回收全部结果，下载、核验 SHA 与媒体信息，通过光栈 MCP 预览和导入，并回读版本。已有任务可用 `rh_archive_outputs` 登记。归档状态存于 `~/.runninghub-canvas-bridge/archives`，重启后继续；需要处理时保留全部已下载文件与原导入请求。项目身份登记、素材采用与定版遵循调用方自己的制作规则，归档不会代替这些决定。

实测边界见 [验证记录](docs/international-validation.md)。音视频上传与隔离光栈库的真实导入已验证，生成完成信号在测试中模拟。真实生成闭环、资产抽屉检索和多用户同时编辑尚未验证。

格式：PNG/JPEG/WebP、MP4/MOV/WebM、MP3/WAV/M4A/AAC/FLAC/OGG。媒体按真实内容识别；视频/音频通过仅限当前页面的短时本机文件链接上传。归档遵守光栈当前单文件 256 MiB 上限。光栈 MCP 配置默认读取其本机 `mcp-client.json`，可用 `RH_LUMEN_MCP_CONFIG` 指定。已在光栈 0.8.8（22.20）完整安装包验证：已登记空 Work 的首版导入、连续两份输出归档、原请求重试及归档服务重启，保持原 Work 且不重复版本。旧版光栈需完整更新 App；接口故障时下载文件保留，可修复后 `rh_retry_archive`，不另建 Work 绕过归属。

## 开发与打包

```sh
npm run check
npm test
npm run build
npm run release:package
npm pack --pack-destination dist
```

扩展 ZIP 与源码包输出到 `dist/`。扩展需配套本地服务运行，端口统一为 18765。历史文档保留上游记录，以本文和实时能力为准。

基于 [windzu/runninghub-canvas-bridge](https://github.com/windzu/runninghub-canvas-bridge)，Apache-2.0。署名见 [UPSTREAM.md](UPSTREAM.md)，改动见 [CHANGELOG.md](CHANGELOG.md)。

## v0.5 功能

- `rh_search_assets` 浏览或搜索平台资产库，`rh_add_asset` 复用图片、视频、音频；同一 URL 已在画布时复用现有节点。资产选择有效期 15 分钟，需保持同一个 MCP 连接及画布标签页。
- `rh_inspect_references` 识别实际媒体输出，包括 `rh-ai` 节点；`rh_bind_references` 按实时参数名写入参考并连接节点。多个输出时明确选择 URL，未指定的参考槽保持原状。
- `rh_list_models` / `rh_model_schema` 实时读取模型及参数配置，返回选项、默认值、范围和原始条件；不据此推断价格、权益或可生成性。
- MCP 连接独立保存所选画布与读写范围。同一画布的桥接修改串行执行。`rh_get_node` 返回版本指纹，`rh_batch_update_nodes` 要求逐节点版本；版本不匹配时整批拒绝。普通参数和节点修改也可传 `expectedRevisions`。

版本检查针对已同步的节点和连线，不能替代平台对跨浏览器编辑的全局事务。提交后断连且没有回执的修改保持未知，不自动重发；后续修改可能排队超时，需要核对画布再重启服务。

## Windows

Windows 10/11 使用 Node.js 20.19+、Chrome 或 Edge，以及 PATH 中的 `ffprobe.exe`（或设置 `RH_FFPROBE` 为完整路径）。在项目目录执行 `npm ci`、`npm run build`，然后 `npm run service:install`。扩展加载步骤与 macOS 相同。

后台服务使用当前用户的登录启动目录，无需管理员权限。支持 `service:start`、`service:stop`、`service:restart`、`service:status`、`service:uninstall`。运行日志位于用户主目录 `.runninghub-canvas-bridge/logs`，卸载保留归档与配置。企业策略禁用 Windows Script Host 时可用 `npm start` 前台运行。

PowerShell 如需开启生成，在安装服务前设置 `$env:RH_BRIDGE_ALLOW_GENERATION="1"`。可选光栈归档需设置 `$env:RH_LUMEN_MCP_CONFIG` 指向光栈导出的 MCP 配置文件；未配置不影响画布编辑和生成。文件路径必须属于运行 MCP/桥接的同一台电脑。
