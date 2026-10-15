# 程序下载

[全部发布文件](https://github.com/sincostancscseccot/2048-sandbox/releases/tag/v0.9.0) · [备用在线试玩](https://sincostancscseccot.github.io/2048-sandbox/) · [源码](https://github.com/sincostancscseccot/2048-sandbox)

| 程序 | 下载 | 摘要 |
|---|---|---|
| 安卓离线安装包 | [v0.9.0 APK](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.9.0-android.apk) | [SHA-256](2048-sandbox-v0.9.0-android.apk.sha256) |
| 本地程序 | [v0.9.0 ZIP](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.9.0.zip) | [SHA-256](2048-sandbox-v0.9.0.zip.sha256) |
| 静态网页 | [网页 ZIP](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.9.0-web.zip) | [SHA-256](2048-sandbox-v0.9.0-web.zip.sha256) |
| 单文件网页 | [HTML](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.9.0-web.html) | [SHA-256](2048-sandbox-v0.9.0-web.html.sha256) |
| 云枢部署项目 | [Node.js 22 ZIP](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.9.0-cloud.zip) | [SHA-256](2048-sandbox-v0.9.0-cloud.zip.sha256) |

本地 ZIP 解压后双击“启动试玩.cmd”，需要 Node.js 24.19+（24.x），无需 pnpm 或安装项目依赖。安卓 APK 无需 Node.js，首次启动即可离线使用。静态 ZIP 和单文件 HTML 用于网页托管；云枢 ZIP 根目录含 package.json，通过 npm start 监听平台提供的 PORT 和 0.0.0.0。

[本地说明](../docs/release/本地版使用说明.md) · [安卓说明](../android/README.md) · [网页发布说明](../docs/release/网页发布说明.md)

云枢已接收部署包；当前部署受平台运行环境限制，尚未上线。请先使用备用在线版。

## 历史程序包

以下原始 ZIP 未重新生成，作为历史产品附于 v0.9.0 发布页；不代表另有对应版本的 Git 源码快照。

- [v0.8.3 键盘修复](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.8.3.zip) / [摘要](2048-sandbox-v0.8.3.zip.sha256)
- [v0.8.2 显示与对局管理](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.8.2.zip) / [摘要](2048-sandbox-v0.8.2.zip.sha256)
- [v0.8.1 动效与音效](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.8.1.zip) / [摘要](2048-sandbox-v0.8.1.zip.sha256)
- [v0.8.0 M6 本地版](https://github.com/sincostancscseccot/2048-sandbox/releases/download/v0.9.0/2048-sandbox-v0.8.0.zip) / [摘要](2048-sandbox-v0.8.0.zip.sha256)

程序包不含个人对局、签名私钥、SDK、node_modules 或开发缓存。对局应另外导出为 .2048backup，不能用程序安装包代替游戏备份。二进制和生成后的网页通过 GitHub Release 提供；源码仓库保留校验和与构建入口。
