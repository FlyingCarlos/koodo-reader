# Koodo Translation Agent

本地 Python 翻译后台，Agent Runtime 为 **OpenAI Agents SDK 0.24.0**。
已接入 PDF 文本提取、章节任务、ChatGPT 订阅授权、本地术语工具、段落翻译、独立审校和定点修订。
入口包括 CLI 和原阅读器中的“翻译与双语”面板。

## 在阅读器中使用

1. 在 `https://koodoreader.localhost` 打开有文字层的 PDF，点击上方“翻译与双语”。
2. 首次点击“提取本书”，将浏览器书库中的 PDF 副本交给本机后台。若浏览器不能读取，可选择原始 PDF。
3. 通过原生目录或页码选择章节，面板跟随当前阅读位置。选择订阅支持的模型，点击“翻译当前章节”。开启“显示英中对照”。
4. 译文分批出现；只有翻译和独立审校均通过的段落才计入“已审校”。可暂停/继续，关闭页面不影响后台任务。

英文在左、中文在右，直接嵌入原生 PDF 页面的 iframe。左侧保留原 PDF、文本层、链接和坐标，
右侧按原页显示译文；滚动模式共用原阅读器的滚动区域，页高取两侧较高的一侧。
阅读区域不足 560px 的滚动模式，在同一页面内改为原 PDF 在上、中文在下，保持原生缩放。
原生目录、页码、跳转返回、搜索、书签、选中菜单和笔记继续使用已有组件，双语开关不会卸载 Viewer。
英文高亮保持原 PDF 坐标；中文高亮使用带版本的段落文字锚点，仍通过原生选中菜单和笔记编辑器操作。
中文引文变更时拒绝错位恢复；关闭双语后英文批注数据仍使用原格式。PDF 文字重排模式保持原行为，
当前双语显示使用 PDF 原版式。架构和验证边界见 [PDF 翻译集成](../docs/pdf-translation.md)。

Node 服务自动管理 loopback `3017` 上的 Python 子进程，浏览器通过同源 `/api/translation/`
访问。重启前台服务会同时重启后台，运行中的章节重新排队并复用已保存阶段；主动暂停的章节不自动恢复。
同一章节绑定原模型和术语快照，重复提交返回同一任务，避免覆盖译文。

PDF 提取使用 PyMuPDF，保留原文、段落 ID、物理页、坐标与章节映射；有书签时使用主章节，
否则按十页分组。去掉小字号页边文字、合并可判定的跨页段落，并把拼接图片瓦片合成插图。
每批最多 12 段、6,000 字符，复用已有 Agent 工作流。源文件上限 128 MB / 3,000 页。

当前限制：扫描 PDF 不做 OCR；复杂多栏、表格、公式及字体连字可能提取不完整，需对照原 PDF。
代码与图片保留原样，图片里的文字不翻译。暂无全书一键排队、人工修订界面或跨章节上下文检索；
术语快照以推理工程技术书为首批预设。`needs_review` 会明确显示待复核，不宣称完成。

## 安装和运行

在本目录执行，使用 `uv.lock` 固定依赖：

```sh
uv sync --locked --python 3.12
uv run koodo-translate login
```

将打印的授权地址在 **Edge** 打开。确认名称为 `Koodo Reader Translation`，由用户完成
ChatGPT 登录和订阅使用授权。回调只监听 `127.0.0.1`，默认等待五分钟；超时可重新运行。
本工具不读取 Codex 的登录文件，也不回退到环境中的 API Key。

```sh
uv run koodo-translate status
uv run koodo-translate models
uv run koodo-translate translate --input examples/sample.json --model <models返回的slug>
uv run koodo-translate jobs
uv run koodo-translate show <job-id>
uv run koodo-translate translate --input examples/sample.json --model <原model> --resume <job-id>
```

示例是本项目编写的两段技术说明，不读取现有书库。实际请求会把输入文本、相关术语与审校
上下文发送到 OpenAI；使用用户授权的 ChatGPT 计划额度或可用 credits，并受账号、应用和
模型访问限制。模型列表不是计费成功的证明，必须实际完成推理后才能确认接入可用。

## 执行与数据

1. 翻译 Agent 先调用具名本地工具 `book.lookup_glossary`，返回带源段落 ID 的中文译文。
2. 程序检查段落顺序、完整 ID 集合和显式保护的代码/公式字面量。
3. 独立审校 Agent 返回包含原文证据、位置、严重程度和建议的问题列表。
4. 有问题时只修订受影响段落，再审一次；仍有问题标记 `needs_review`，保留所有版本。

初版独立审校指角色和上下文独立，默认使用用户选择的同一模型，不意味着错误独立或质量
已获人工认证。结构检查也不能证明段落内部不存在语义漏译。

每个成功阶段写入 SQLite。失败后从已保存阶段继续，恢复必须使用相同输入、术语表、模型和
工作流版本。额度错误暂停任务；流中断不会被当作成功，不会自动改走 API Key 计费。
在收到模型结果但尚未保存时崩溃，恢复可能重新请求这一阶段；不承诺计费层面恰好执行一次。

默认状态目录：

```text
~/Library/Application Support/koodoreader/translation-agent/
  host.json             稳定的本机安装标识
  registration.json     尚未完成验证的注册记录（存在时）
  credentials.json      当前订阅授权和轮换凭据
  jobs.sqlite3          输入、翻译、审校、修订与用量记录
  books/<book-id>/      源 PDF 和带版本、页码及坐标的 document.json
```

目录权限为 `0700`，新建凭据和数据文件权限为 `0600`，凭据以原子替换写入并序列化刷新。
初版只维护一个当前账号，尚无账号切换或登出界面；可在 ChatGPT 设置中管理或撤销该应用的
访问。数据不位于 Git、`build/` 或浏览器存储中。`--state-dir <目录>` 可为测试指定独立目录。
SDK 托管 tracing 已关闭，诊断输出不打印凭据或 OAuth 错误响应正文。

## 订阅请求约束

- 仅使用官方 `https://api.openai.com/v1/responses`，OAuth 请求由本机后台处理。
- 模型请求必须 `store=false`、`stream=true`，必须接收到 `response.completed` 才能接受输出。
- 使用命名空间中的本地函数工具，不依赖托管 File Search、Code Interpreter 或 MCP。
- 上下文、阶段状态及长期记忆由本机维护；不使用服务端 conversation 或 previous-response ID。
- 单次输入限制为 20 个段落、共 20,000 字符；每阶段限 6 个 Agent 回合和 180 秒。
- 原文作为待翻译数据处理，不执行书内指令。工具当前只读取传入的术语，不访问任意文件。

## 验证

```sh
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest -q
```

测试以真实 Agents SDK 搭配模拟 HTTP/SSE 验证请求体、命名空间工具、结构化结果、审校修订、
限额暂停和断点续传；OAuth 测试检查 PKCE、回调 state、签名、audience、nonce、有效期和刷新。
这些测试不消耗模型额度，也不能替代真实账号授权和在线推理验证。

### 在线验证记录：2026-10-25

已使用正式 Sign in with ChatGPT 授权和账号可用的 `gpt-6.1-sol` 完成最小验证：

- `examples/sample.json` 的两段技术说明完成翻译；翻译 Agent 实际调用
  `book.lookup_glossary`，独立审校无问题，任务状态为 `completed`。
- 对该任务执行 `--resume`，直接返回原有产物，用量记录未增加。
- 另建诊断任务，将初稿故意写成“即使吞吐量有所改善，也应部署”，对应原文为
  `If batch_size = 8 increases latency, do not deploy it, even if throughput improves.`。
  审校定位到否定含义颠倒，修订为“如果 batch_size = 8 增加延迟，即使吞吐量有所改善，
  也不要部署该配置。”，再次审校通过，原始错误初稿与审校证据均保留。
- 两个任务共记录 6 次模型请求，输入 2,582 tokens、输出 320 tokens；全程使用本工具
  的订阅授权，没有 API Key 回退。此处用量是该次样本运行的结果，不代表单书费用或限额。

### PDF 与双栏验证：2026-10-25

使用本机《Inference Engineering》PDF（259 页）完成提取，识别 13 个主章节分组及 2,584 个文本/图片区块。
第 0 章 `Chapter 0: Inference`（PDF 实际第 17–24 页）拆成 4 批、42 个可翻译区块，全部完成
翻译与审校，`needs_review=0`。3 幅插图保留原样；没有将全部 259 页标记为已翻译。

该章任务为 `26a087d6-2478-4aa9-9545-51b1b247e12b`，使用 `gpt-6.1-sol`，记录 12 次模型请求，
输入 15,096 tokens、输出 2,583 tokens。结果保存在私有状态目录，可从书库直接打开。
这验证了当前书的首章流程，不能证明全书提取无误、长期术语一致或译文达到人工出版质量。

序言（PDF 实际第 11–16 页）另从 Edge 点击“翻译本章”启动，暂停后重启服务确认仍为
`paused`，再从界面继续，最终 41/41 段审校完成。该任务为
`53a89d7f-2e4d-43ef-a2ee-4dc72a50dffd`。两章以外的译文仍需用户在阅读器中按章启动。

19 项离线测试还覆盖 PDF 章节/页眉/跨页段落/代码/图片拼接、上传与原文读取、章节去重、
暂停和恢复接口，以及重启后仅恢复运行任务。浏览器检查涵盖左右段落对齐、共用滚动、目录与页码跳转。

## 官方依据

- [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)
- [ChatGPT 订阅授权](https://developers.openai.com/siwc/token-sharing-open-source)
- [OAuth 注册与验证](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [订阅模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
