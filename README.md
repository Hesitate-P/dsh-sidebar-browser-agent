# 侧栏浏览器 Agent 控制（dsh-sidebar-browser-agent）

给 DSH 右侧栏的**原生浏览器**加上完整的 Agent 可操作能力：管理标签页，并读取页面内容、
点击、输入、按键、滚动、执行 JS、截图返回给模型查看；带配置开关、启动自检与回归测试。

实现是**全原生**的：不依赖 Playwright/Puppeteer、不注入代理、不重写页面。页面操作直接使用
侧栏浏览器自带的 Electron `<webview>` 客户端的 Chromium API：

- `executeJavaScript()` —— 在真实页面里读取 DOM、执行脚本；
- `sendInputEvent()` —— 原生鼠标/键盘事件（真实点击、按键）；
- `capturePage()` —— Chromium 原生截图，经 attachment 服务变成图像内容块返回给模型；
- `loadURL()` / `reload()` —— 原生导航与刷新，侧栏地址栏同步更新。

## 结构

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | bundle patch，插入 Host 插件行（id `sidebar-browser-agent`） |
| `index.js` | Host 半：配置与开关、`sidebar_browser` / `sidebar_page` 工具、HTTP 长轮询桥、截图转 attachment、启动自检 |
| `client.js` | 浏览器半：长轮询取命令，用公开 `ctx.sidebarRight` 管理标签、用原生 webview 操作页面；`status` 输出自检信息 |
| `locale/*.json` | 插件列表显示用的标题与描述（中/英） |
| `icon.svg` | 插件图标 |
| `vendor/` | 内置的 MIT 依赖（schemastery + cosmokit），使 link 安装的插件也能声明原生 Config schema，见 `vendor/NOTICE.md` |
| `test/` | 零依赖离线回归测试（Host 桥/工具/配置 + Client guest 脚本），`node test/run.mjs` |

### 为什么需要桥

右侧栏布局与标签状态属于浏览器页面，只有页面持有 `ctx.sidebarRight`。Host 工具把命令排入队列，
页面半长轮询取走命令、执行后回传结果（截图走同一条通道）。所有桥路由都经过
`ctx.connection.requestRejection` 的准入检查。

### webview 定位方式

侧栏为每个标签渲染 title 和 body 两个带 `data-sidebar-right-tab="<tabId>"` 的节点，
外层是 `[data-sidebar-right-session]`。body 节点内是原生 `<webview data-sidebar-browser-frame>`，
插件按 (sessionId, tabId) 精确定位它，不依赖标签顺序或坐标猜测；找不到时返回明确诊断而不是静默失败。

## 工具

### `sidebar_browser` —— 标签页管理

| action | 说明 | 参数 |
| --- | --- | --- |
| `status` | 桥状态、载体类型、原生能力、插件版本、配置、attachment 自检 | — |
| `list` | 列出标签页（含原生读取的 URL / 标题） | — |
| `open` | 新建标签页打开网页 | `url` |
| `navigate` | 在当前标签页内原生导航 | `tabId`、`url` |
| `reload` | 原生刷新 | `tabId` |
| `focus` | 切换到标签页 | `tabId` |
| `close` | 关闭标签页 | `tabId` |

### `sidebar_page` —— 页面读取与操作

| action | 说明 | 参数 |
| --- | --- | --- |
| `read` | 读取页面：`text` 可见文本 / `interactive` 可交互元素（含 CSS selector 与坐标）/ `html` 源码 | `mode`、`selector`、`maxChars`、`maxElements` |
| `click` | 原生点击：按 CSS selector、按可见文本、或按视口坐标 | `selector` / `contains` / `x`+`y` |
| `type` | 聚焦输入框写入文本（可替换原值、可回车提交），触发真实 input/change 事件 | `selector`、`text`、`clear`、`submit` |
| `press` | 原生按键：Enter/Tab/Escape/Backspace/Delete/方向键/PageUp/PageDown/Home/End/Space | `key` |
| `scroll` | 滚动页面或把元素滚入视口 | `dy`、`dx`、`selector` |
| `wait` | 轮询等待 selector 或页面文本出现 | `selector` / `contains`、`timeoutMs` |
| `eval` | 在页面执行 JavaScript，返回 JSON 结果（可做任意 DOM 操作） | `code` |
| `screenshot` | 截取当前视口，图像作为内容块返回给模型 | — |

`read` 的 `interactive` 输出示例：

```
[2] <button type=button> "Say hello" selector=#greet @(118,261)
```

随后即可 `click --selector "#greet"`。页面结构未知时先 `read interactive`。

## 配置

插件声明了原生 Schemastery `Config`（Plugin Manager 的插件详情页可直接编辑；修改后该行重启生效）。
未配置时使用默认值：

```yaml
- id: sidebar-browser-agent
  config:
    enabled: true            # false = 不注册两个工具（桥路由仍在，便于诊断）
    allowedHosts: []         # 空 = 允许所有 HTTP(S) 主机；否则按精确主机或子域后缀限制 open/navigate
    allowEval: true          # false = 禁用 sidebar_page eval
    allowNativeInput: true   # false = 禁用 click / type / press
```

主机名匹配规则：条目 `example.com` 允许 `example.com` 与其任意子域；`*.example.com` 同样按子域后缀处理；
也可以写带端口的 `localhost:8765`（端口精确匹配）。

## 诊断与自检

- 插件启动时 `apply` 会做一次自检：`webServer` / `connection` / `tools` / `attachments` 是否就绪，
  通过日志输出 `sidebar-browser-agent 0.2.0: ready (...)`；attachment 缺失会 warn（截图不可用）。
- `sidebar_browser status` 的 note 末尾带：
  - `checks={...}`：页面半自检，含插件版本、载体、DOM 标记、guest webview、原生 API 清单、
    当前 guest URL、Harness release（版本 + commit）；
  - `host-plugin=...`：Host 版本、生效配置、attachment 可用性。
- 原生 API 或 DOM 标记缺失时，`checks.apiMissing` / `surface=false` / `webview=false` 会直接暴露问题。

## 安装

### 从 GitHub 安装（推荐给使用者）

Plugin Manager（或 `plugin_manager` 工具）接受 pnpm 能解析的安装规格。仓库带标签后：

```text
github:Hesitate-P/dsh-sidebar-browser-agent#v0.2.1
```

- Web 界面：Plugins → 添加插件 → 粘贴上面的规格（DSH 会先用 `git ls-remote` 检查 GitHub 连通性，再交给 pnpm 安装）；
- Agent 工具：`plugin_manager install_bundle(target: "github:Hesitate-P/dsh-sidebar-browser-agent#v0.2.1")`。

也可以直接填 GitHub 仓库 URL。安装完成后 profile 依赖会记录为 `github:...#v0.2.0`，bundle 自动选中并启用。
`engines.dsh` 声明兼容 `>=0.2.2-rc.1 <0.3.0`，Git 规格在安装后由 DSH 校验版本要求。

### 从 npm 安装（发布后，可一键更新）

包名 `dsh-sidebar-browser-agent`。发布后在 Plugin Manager 中以 `dsh-sidebar-browser-agent@<version>` 安装，
此后详情页会出现 **Update**（DSH 的版本列表与 Update 只对 registry 安装的第三方包生效）。

### 开发安装（link）

通过 Plugin Manager 安装本目录的**绝对路径**：

```text
plugin_manager install_bundle(target: /path/to/sidebar-browser-agent)
```

profile 以 `link:` 指向该目录，**不要移动或删除它**。Host 半代码修改后重启 Harness
（或对该行 disable→enable）才会重新加载；`client.js` 修改会被客户端 HMR 自动热换。link 安装没有 Update 按钮。

## 更新

DSH Plugin Manager 的 **Update** 按钮只接受"以自身包名保存的 registry spec"的第三方包；
GitHub 安装（`github:...` 规格）不会出现 Update。对应更新方式：

| 安装来源 | 更新方式 |
| --- | --- |
| GitHub 安装 | Plugin Manager 中先 **Remove**，再安装新标签：`github:Hesitate-P/dsh-sidebar-browser-agent#v0.2.1`。工具等价操作：`plugin_manager remove_bundle` → `install_bundle`。移除期间插件短暂不可用，重新安装后恢复。 |
| npm 安装 | 详情页 **Update**：列出更高版本、校验 `engines.dsh`/peer 后一键替换；失败会回滚并重装旧版本。 |

如果希望 GitHub 安装也具备一键更新：把包发布到 npm（仓库自带 `.github/workflows/publish.yml`，
在 GitHub 配置 `NPM_TOKEN` secret 后推送 `v*` 标签即自动测试并发布），然后把 profile 的安装来源切换到
registry spec（`dsh-sidebar-browser-agent@<version>`）一次即可。

## 发布流程

```bash
node scripts/set-version.mjs 0.2.1   # 同步 package.json 与 index.js/client.js 的 PLUGIN_VERSION
npm test                             # 回归测试同时校验三处版本一致性
git commit -am "release v0.2.1"
git tag v0.2.1
git push --follow-tags               # CI 跑测试；配置了 NPM_TOKEN 时 publish workflow 发布 npm
```

### 本地打包

```bash
npm run pack:check       # 校验 npm pack 文件清单
npm pack                 # 生成 dsh-sidebar-browser-agent-0.2.0.tgz
```

`files` 已显式包含运行文件、`vendor/`、`test/`、`README.md`、`CHANGELOG.md`、`LICENSE`。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 测试

```bash
node test/run.mjs        # 或 npm test
```

- `test/host-harness.mjs`：真实 Config 校验、开关门禁、工具注册、输出 schema、HTTP 桥往返、
  截图 attachment + 图像块、版本一致性；
- `test/client-harness.mjs`：在 vm + 假 DOM 中执行真实 guest 脚本，覆盖 read/click/type/press/
  scroll/wait/eval/screenshot、原生导航刷新、后台会话与自检输出。

零第三方依赖、无需运行中的 Harness。

## 跨会话（后台）行为

页面切到别的会话时（`status` 的 `mounted` 是另一个会话 id）：

- **可用**：`read` / `click` / `type` / `press` / `scroll` / `wait` / `eval`、`navigate` / `reload`、
  `list` / `status`。原生 webview 在会话切走后仍保持挂载，结果会附带「操作未显示在屏幕上」的说明。
- **不可用**：`open` / `focus` / `close`（改变可见侧栏布局，必须让调用会话在屏幕上）；
  `screenshot`（Chromium 无法截取隐藏的 guest，会返回明确提示，切回即可）。

## 限制

- 页面操作需要 **DSH Desktop 原生载体（Electron webview）**；Web 构建下侧栏浏览器是沙箱跨域 iframe，
  页面操作会明确报错，标签页管理仍可用，读取纯文本可改用 `web_fetch`。
- 调用时 Harness 页面必须打开；`open`/`focus`/`close`/`screenshot` 需要调用会话正显示在页面上。
- 截图是当前视口（非整页长图），且只在会话可见时可靠；超宽图会自动降采样，最大约 12MB base64。
- `eval` 可在页面执行任意 JS（可用配置关闭），等同把该页面当作可编程环境；请只在可信页面使用。
- 侧栏浏览器对页面有沙箱限制：无下载、无弹窗（会转为新侧栏标签）、无权限授予，页面也访问不到 DSH 应用。

## 许可

本插件 MIT（见 `LICENSE`）。`vendor/` 内置的 `@deepseek-ai/schemastery` 与
`@deepseek-ai/cosmokit` 同为 MIT，来源与改动见 `vendor/NOTICE.md`。
