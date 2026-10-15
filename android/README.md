# 安卓离线版

从 [v0.9.0 发布页](https://github.com/sincostancscseccot/2048-sandbox/releases/tag/v0.9.0) 下载 `2048-sandbox-v0.9.0-android.apk` 并在安卓设备上安装。运行资源直接包含在 APK 中，首次启动也可离线使用；无需 Node.js、账号或在线服务器。

要求 Android 8.0（API 26）及以上，并使用支持现代网页功能的 Android System WebView / Chrome（111 及以上）。应用标识为 `com.sandbox2048.app`，目标 SDK 为 36。当前实测环境是 Android 15（API 35）模拟器，WebView 124；尚未进行真机测试。

## 保存与文件

- 对局保存在本应用中，与网页版分别保存。不同版本之间通过完整备份迁移，文件格式仍为 v1。
- “导出备份”打开系统保存窗口；选择位置并确认后才显示成功。取消不会改变游戏状态。
- “文件与恢复”使用系统文件选择器，先验证并预览，再导入独立副本。可与网页版、本地版交换 `.2048backup`、`.2048lab`、`.2048state` 和规则 JSON。
- 安卓返回键先关闭弹窗、取消选格或返回首页，再退出。保存未确认时先处理保存。
- 覆盖安装同一签名的更新可保留记录；卸载或清除应用数据会删除本地记录。更新前建议导出完整备份。

不申请互联网或整盘存储权限。游戏使用 APK 内的 HTTPS 虚拟来源；外部网页不会载入具有文件桥接能力的游戏页面。数据校验在构建时预编译，内置页面禁止动态代码求值和嵌入外部框架。

## 从源码构建

准备 Node.js 24.19+（24.x）、pnpm 11.25.0、JDK 17+（本项目使用 JDK 21）、Android SDK Platform 36 和 Build Tools 35.0.0。Gradle Wrapper 固定为 9.1.0 并校验官方 SHA-256；Android Gradle Plugin 为 8.13.0。

```powershell
pnpm install --frozen-lockfile
$env:ANDROID_HOME = 'C:\Android\Sdk'
pnpm release:android
```

脚本先生成本地包及安卓网页资源，再构建和验证签名。输出位于 `release/`。`.work/android-web/` 是生成目录，不应手工修改。SDK 默认读取 `ANDROID_HOME`，也可调用 `scripts/build-android.ps1 -SdkRoot <SDK目录>`。

首次构建会在 `.private/android/` 生成 RSA 3072 位发布密钥和由 Windows DPAPI 加密的密码。该目录已排除于 Git，APK 只包含公钥证书。必须妥善备份密钥；DPAPI 密码只适用于当前 Windows 用户，迁移电脑前应通过安全方式另行保存凭据。不要重新生成密钥后覆盖同一应用的正式更新。

## 安卓验证

`scripts/build-android.ps1 -WithTests` 同时生成与 Release APK 使用同一签名的测试 APK。测试 APK 仅用于自建模拟器，内含一个临时文档 Provider，不属于发布产品。

```powershell
adb install -r release/2048-sandbox-v0.9.0-android.apk
adb install -r android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
adb shell svc wifi disable
adb shell svc data disable
adb shell am instrument -w com.sandbox2048.app.test/com.sandbox2048.app.SmokeTestRunner
```

测试覆盖离线首次运行、有效移动与保存、原生备份写入及取消、真实触摸唤起文件选择器、导出再导入、独立副本、返回键和 Activity 重启恢复。只在无个人数据的测试模拟器运行。

原生依赖及许可证见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)，构建后的 APK 资源中附实际依赖版本表和网页依赖许可原文。
