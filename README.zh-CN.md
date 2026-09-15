# DSH Plugin DevKit

[English](README.md) | **中文**

用于开发 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件的工具集：
一个可以在实时会话里查询的运行时检查器、一个用于测试的隔离启动器、无需浏览器的宿主契约测试，
以及面向客户端半边（client half）的槽位预览。

**状态：** 四个模块全部实现。547 个单元测试，外加六项真机检查 —— 跑在真实的 cordis 运行时、
真实的 DSH 启动，以及真实的一次模型轮次上。已在 DSH `0.1.5-rc.2` 上验证。

> **社区项目。** 本 DevKit 由社区维护，**与 DeepSeek AI 无隶属关系**，也不由其背书或提供支持。
> 「DeepSeek Harness」「DSH」指它所面向的上游平台。

---

## 快速开始

DevKit 是一个 monorepo，**未发布到 npm**。从克隆出来的仓库里按路径安装你需要的包：

```sh
git clone https://github.com/CkEFFAF/dsh-plugin-devkit.git dsh-plugin-devkit
cd dsh-plugin-devkit
npm install                      # 把四个包链接进 ./node_modules
```

然后在你**自己的插件**目录里指向需要的包：

```sh
npm install --save-dev \
  file:../dsh-plugin-devkit/packages/dsh-debugger \
  file:../dsh-plugin-devkit/packages/dsh-plugin-test \
  file:../dsh-plugin-devkit/packages/dsh-debug-boot \
  file:../dsh-plugin-devkit/packages/dsh-plugin-preview
```

把相对路径调整成你的克隆位置即可。每个包都以自己的名字导出（`dsh-debugger`、`dsh-plugin-test` 等），
其中三个带 CLI 的会安装一条命令。

### 把运行时检查器装进 DSH profile

`dsh-debugger` 是运行时插件，通过 DSH CLI 挂进 profile：

```sh
dsh plugin --profile web add /path/to/dsh-plugin-devkit/packages/dsh-debugger
```

`dsh plugin` 会在 profile 目录里执行 pnpm，然后对账 `dsh.profile.bundles` ——
由于该包声明了 `dsh.bundle.patch`，它会自动加入层栈。重启 DSH 后 `/debug health` 即可回答。

> 四个包**未发布到 npm**，所以上面的 spec 是指向克隆目录的路径。
> 裸包名形式 `dsh plugin --profile web add dsh-debugger` 需要先做一次 npm 发布。

> **为什么不用 `npm install git+https://…`？** npm 直到 10.5 才支持 git 子目录；更早的版本会
> **静默安装整个仓库根目录**，而不是你指定的那个包 —— 你拿到的是一个没有入口点、也不报错的文件夹。
> 克隆后按路径安装则在任何版本上都可用。已在 npm 10.1 + node 22 上验证。

### 环境要求

**DSH `0.1.5-rc.2`** —— 本 DevKit 开发与验证所针对的版本，四个包都用 `engines.dsh` 声明。
DevKit 只通过公开接缝接触宿主（`ctx.debugger`、`/debug`、CLI 退出码、JSON 报告），
所以相近的版本通常可用，但其他版本未经测试。

Node 22 或更高。`dsh-plugin-preview` 可选地使用系统 Edge/Chrome 截图、使用 esbuild 打包；
两者都在运行时探测，缺失时会明确报告，绝不会自行下载。

---

## 各模块的用途

| 包 | 做什么 | 需要了解 |
|---|---|---|
| `dsh-debugger` | 观察一个实时组合：有界时间线、`/debug` 命令，以及可编程的 `ctx.debugger` | `ctx.debugger`、`/debug` |
| `dsh-debug-boot` | 启动隔离的 DSH profile，让真机检查永远不碰你的日常环境 | `debug-boot` CLI |
| `dsh-plugin-test` | 不开浏览器断言宿主行为：假 Cordis 宿主 + JSON 报告 | `dsh-plugin-test` CLI |
| `dsh-plugin-preview` | 把客户端半边挂进假槽位外壳，按官方主题尺寸近似渲染 | `dsh-plugin-preview` CLI |

`dsh-debugger` 是**运行时**检查器，不是源码级单步调试器 —— 需要断点请用 `NODE_OPTIONS=--inspect`
配合编辑器 attach（DevKit 自己的 `/debug health` 也会提醒你）。

---

## 它能做什么

- **问一个正在运行的组合现在什么状态。** `/debug health` 给一句结论；
  `/debug plugins --not-active` 点名一个从未激活的插件，**以及它在等哪个服务**；
  `/debug services` 显示谁提供了什么。
- **把一次调用从头追到尾。** `/debug trace <callId>` 返回共享同一 correlation id 的全部记录 ——
  一次工具调用就是 `pre-execute → execute → result`，带耗时。
- **看见模型轮次，而不只是工具调用。** 纯文本的一轮也会留下一条 `llm/stream` 记录，
  含 provider、model、消息计数，并关联到它所属的 session。
- **在副本上复现故障。** `debug-boot` 从随包模板派生一个一次性 profile，
  真机检查永远不碰你的日常实例。
- **不开浏览器就证明插件的宿主契约。** `dsh-plugin-test` 把插件挂到假 Cordis 宿主上，
  返回稳定 schema 的 JSON 报告。
- **看看客户端半边。** `dsh-plugin-preview` 把它渲染进假槽位，按官方主题尺寸近似显示，
  light/dark × narrow/wide 四种变体。

以上全部都能在你**已经打开的那个会话里**查询 —— 不用 attach DevTools，不用开第二个窗口。

---

## 与同类工具的差异

DSH 本身已经自带若干检查面。它们回答的是不同的问题，本 DevKit 的设计目标是**与它们并排**，
而不是取代它们。

| | 本 DevKit | `dsh-experimental-inspector` | `dsh-tool-cordis` | Plugins 设置页 |
|---|---|---|---|---|
| 从哪用 | 聊天会话（`/debug`）与 CLI | Chrome DevTools 经 CDP 连接 | 模型工具调用 | Web 设置页 |
| 实时组合（fiber 状态、pending/failed 根因） | 有 —— 直接点名在等哪个服务 | Elements 面板里的 Cordis 树 | 有 | 只读的 loader 清单 |
| 工具 / 命令 / LLM 时间线，按 `callId` 关联 | 有，有界并计数 | Console + Network 面板 | 无 | 无 |
| 采集负载里的密钥 | **进缓冲前就已脱敏** | 不脱敏（官方文档明示） | 不适用 | 不适用 |
| 能否改变组合 | 不能 —— 纯旁观 | 不直接改，但 CDP 授予任意求值 | 能 —— 创建并运行临时包 | 不能 |
| 获取方式 | 公开、MIT、克隆后按路径装 | 私有、实验性、不随发布 | 随 DSH 发布，需自行挂载 | 随 profile 自带 |

**这些差异换来了什么：**

- **它不会弄坏被观察的对象。** waterfall 探针原样返回 `next()` 的引用 —— 返回副本会搞坏整个
  组合的生成，因此有一个针对真实 `LlmRuntime` 的检查把它钉住。
- **密钥在入库前脱敏**，而不是显示时才处理 —— 泄漏的 key 根本进不了缓冲。
- **证据不会悄悄消失。** 缓冲有界、溢出被计数，JSON 报告带 `summary.overflowed` /
  `recordsDropped`，因此「丢了证据」的一次运行不可能被读成干净的通过。
- **它测的是契约，不是 mock。** 假宿主镜像 `normalizeDefinition` 与真实的
  `execute(agent, line, …)` 签名 —— 这正是它抓到「单测全绿、真机上却什么都不做」那类插件的原因。
- **隔离是硬规则。** 真机检查跑在派生 profile 上；永不激活的插件被报成 `plugin-pending`
  （退出码 7）并点名它在等的服务，而不是甩一段 loader 堆栈。
- **边界明说，不暗示。** 不承诺像素级一致，截图只拍不比，任何东西都不经过检查器代理。

**它刻意不做的事：** 源码级单步（那是 `NODE_OPTIONS=--inspect` 的活）、插件市场或安装 UI、
agent 轨迹工作台；也从不对自己注入 `tools`。

---

## 工作流

```sh
# 1. 针对假宿主跑契约测试 —— 不需要浏览器，不需要服务器。
node --test tests/*.test.mjs
dsh-plugin-test tests/cases.mjs --plugin .

# 2. 看看你的客户端半边长什么样。
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve

# 3. 挂上你的插件，启动一个隔离实例。
debug-boot --plugin ./index.mjs --port 8080

# 4. 在那个会话里：
#    /debug health            一切都在活动吗？
#    /debug plugins --name mine
#    /debug plugins --not-active
#    /debug events --category tool -v
#    /debug trace <callId>
```

### `dsh-plugin-test`

```js
import { noPending, serviceActive, noSecrets } from 'dsh-plugin-test'

// The runner mounts this on its host before running your cases.
export const plugin = { name: 'my-plugin', apply }

export const cases = [
  {
    name: 'my service is provided',
    run: ({ ctx, plugin: mine }) => {
      if (!ctx.get('mine')) throw new Error('not provided')
    },
  },
  { name: 'nothing is stuck pending', run: ({ debugger: d }) => noPending(d) },
]
```

`run` 收到 `{ ctx, debugger, host, plugin, pluginError }`。它可以什么都不返回（视为成功）、
返回 `true`，或返回断言辅助函数的返回值 —— 失败时抛错是通常写法，报告会原样带上你自己的消息。

退出码：`0` 全部通过，`1` 有用例失败，`2` 用法错误，`3` 模块或插件加载失败。
报告是稳定 schema 的 JSON，含 `summary.overflowed` 与 `recordsDropped`，
因此「证据被丢弃」的一次运行不可能被读成干净的通过。

### `dsh-plugin-preview`

你的客户端半边导出 `mount(el, { fixture, slot, scheme, viewport })`，或一个同签名的默认导出函数。
页面会渲染 **light/dark × narrow/wide** 四种变体，并定义官方 `--dsw-alias-*` token 名，
因此按这些名字写的 CSS 能正常解析。

```sh
# 边写边看。
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve

# 一个可以直接打开的独立 HTML 文件。
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --inline-client --out page.html

# 每个变体一张 PNG，供你自己做截图 diff。
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve --shot ./shots
```

`--serve` 与 `--inline-client` 是两条不同的路径，原因来自实测：内联模块（`blob:`/`data:`）
既解析不了裸模块名，也解析不了相对路径，所以引用 `react` 的客户端会先用 esbuild 打平 ——
如果 esbuild 不存在，工具会**拒绝**，而不是写出一个静默显示占位内容的页面。

**它不承诺像素级一致。** 尺寸是近似值，页面自己也这么写；布局回归需要在真实外壳上做截图 diff。
`--shot` 只负责截图，不负责比对。

---

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/` | 四个包 |
| `skills/plugin-devkit/` | 描述本产品不变量的 agent skill |

---

## 跑测试

```sh
npm test                                                    # 547 个测试

node --test "packages/dsh-debugger/tests/*.test.mjs"        # 232
node --test "packages/dsh-debug-boot/tests/*.test.mjs"      # 178
node --test "packages/dsh-plugin-test/tests/*.test.mjs"     # 74
node --test "packages/dsh-plugin-preview/tests/*.test.mjs"  # 63
```

**先腾出 8080 端口。** debug-boot 的 CLI 测试会断言一次成功启动；如果有个在跑的 `debug-boot`
实例仍占着 8080，其中十二个测试会以 `port-in-use` 失败。

### 需要真机的检查

这些**不属于** `npm test` —— 它们需要 DSH 检出目录或一台真实服务器。在你的 DSH 检出目录里运行：

```sh
cd /path/to/deepseek-harness
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-cordis.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-plugin-test/tests/real-process.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-registration.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-llm-probe.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-plugin-test/tests/real-fake-audit.mjs
```

| 检查 | 预期 |
|---|---|
| `real-cordis.mjs` | `14/14` |
| `real-process.mjs` | `15/15` |
| `real-registration.mjs` | `8/8` |
| `real-llm-probe.mjs` | `6/6` |
| `real-fake-audit.mjs` | `20/20 surfaces AGREE` |

以及隔离启动 smoke：它会在一台真实服务器上起 8099，并为自己准备一个一次性的 `DSH_HOME`：

```sh
node packages/dsh-debug-boot/tests/real-boot.mjs    # 6/6
```

---

## 开工前值得知道的两个坑

**0 字节的 `$DSH_HOME/cordis.patch.yml` 会让每次启动都失败。** DSH 会拒绝空的 patch 列表，
所以连 `dsh --profile rescue --dump-config` 也一样失败 —— 与本项目无关。
空文件不等于空数组：内容必须是 `[]`。

**一个永不激活的插件会让整个启动停住。** 如果你的插件 `inject` 了组合里没有提供的服务，
DSH 会拒绝启动，`/debug` 也就永远跑不起来 —— 于是检查器无法解释这件事。
`debug-boot` 识别这种情况，并以 `plugin-pending`（退出码 7）报告，同时点名它在等哪个服务。

---

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
