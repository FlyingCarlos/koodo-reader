# Koodo Translation Agent

本地 Python 最小验证，Agent Runtime 为 **OpenAI Agents SDK 0.24.0**。
目标是验证 ChatGPT 订阅授权、本地术语工具、段落翻译、独立审校和定点修订。
当前入口为 CLI，尚未连接阅读器界面或批量解析 PDF。

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

这证明当前账号、模型和请求合同可用于本地翻译 Agent；尚未验证整本书的提取质量、
长期术语一致性、翻译耗时或双栏阅读界面。

## 后续阅读器集成

面向有文字层的 PDF：先提取有稳定 ID、来源页与坐标的文本块，再接任务与翻译流程。
开启翻译后，以左右对应的段落区块呈现英文和中文，共用滚动容器，由较长一侧决定区块高度。
原 PDF 保留独立核对入口。后续再加入全书术语版本、上下文检索、章节任务和用户修订。

## 官方依据

- [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)
- [ChatGPT 订阅授权](https://developers.openai.com/siwc/token-sharing-open-source)
- [OAuth 注册与验证](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [订阅模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
