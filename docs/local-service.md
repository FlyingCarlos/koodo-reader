# 本地服务维护

本 fork 的主干为 `codex/main`，基于官方 `v2.4.6`，包含我们自行维护的修复和 macOS 服务配置。`fork` 指向 `FlyingCarlos/koodo-reader`，`origin` 指向官方仓库。

## 当前机器配置

这些配置用于 Carlos 的 Mac，路径和 Node 版本是有意固定的。迁移机器、移动项目或升级 Node 时，需要同步调整以下文件并重新安装 LaunchAgent：

- `config/com.carlosz.koodoreader.plist`：工作目录、runner 路径及日志路径。
- `scripts/run-service.zsh`：项目目录、Node 路径及 `PATH`。
- `scripts/koodoreader-service.zsh`：项目目录。

当前项目目录为 `/Users/carlosz/service/koodoreader`，Node 为 `/Users/carlosz/.nvm/versions/node/v24.16.0/bin/node`。

服务标签为 `com.carlosz.koodoreader`，安装位置为 `~/Library/LaunchAgents/com.carlosz.koodoreader.plist`。服务器只监听 `127.0.0.1:3016`，只提供 `build/` 下的文件；`/healthz` 在首页、资源清单和清单入口文件齐全时返回 HTTP 200，否则返回 503。

配置和脚本纳入版本控制；`node_modules/`、`build/` 和 `logs/` 不提交。runner 会加载项目 `.env`，其中已有上游跟踪的文件，不要把密钥或个人凭据写入该文件。

## 构建与更新

首次安装依赖：

```sh
yarn install --frozen-lockfile --ignore-scripts --ignore-optional
```

Web 部署不需要 Electron 原生 postinstall 或 macOS 可选文件监听器。若之前安装遗留了 `node_modules/fsevents`，先移除该可选包；它会在这台 Mac 上导致构建停滞。

每次影响运行的修改后：

```sh
node --check scripts/local-server.cjs
zsh -n scripts/run-service.zsh
zsh -n scripts/koodoreader-service.zsh
plutil -lint config/com.carlosz.koodoreader.plist
yarn build
yarn service:restart
yarn service:status
curl --noproxy '*' --fail http://127.0.0.1:3016/healthz
curl --noproxy '*' --fail https://koodoreader.localhost/healthz
```

如果修改了 plist 或 runner，用 `yarn service:install` 替代 `yarn service:restart`，以重新加载服务定义。安装和重启都会短暂中断服务。其他维护命令为 `yarn service:stop` 和 `yarn service:logs`，日志位于项目 `logs/`。

## Caddy 与 Homepage

这两个全局服务的配置保留在各自位置，不复制进本仓库。重建环境时，Caddy 的 `/opt/homebrew/etc/Caddyfile` 需要包含：

```caddyfile
koodoreader.localhost {
	tls internal
	reverse_proxy 127.0.0.1:3016
}
```

Homepage 的 `/Users/carlosz/service/homepage/config/services.yaml` 在 `macOS 本地服务` 分组中保留一个 `Koodo Reader` 卡片，`href` 为 `https://koodoreader.localhost`，`siteMonitor` 为 `http://127.0.0.1:3016/healthz`。更新后还需确认卡片监控返回 `status: 200`。

## 阅读数据

这套服务提供 Web 应用，不提供服务端书库或同步功能。阅读数据仍由 Web 客户端管理；官方网站的书库不会自动迁移到本地域名。迁移或备份书籍与笔记应使用阅读器自身的导入、导出及备份功能。
