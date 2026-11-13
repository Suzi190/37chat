# 云曰 · Android APK 打包说明

这个仓库的网页版（`app/index.html`）外面套了一层极薄的 Android WebView 壳，
用 GitHub Actions 就能直接产出可安装的 APK，不需要在本地装 Android Studio。

## 一、目录结构

```
app/                       网页端源码（唯一需要日常修改的地方）
  index.html
  vendor/                  FontAwesome / markdown-it / dexie 等本地依赖
tools/
  prepare-apk-assets.mjs   构建前把 app/ 同步进 android/.../assets/www
  make-icons.ps1           由 icon.jpg 生成各分辨率启动器图标（换图标时重跑）
icon.jpg                   图标原图（736×736）
android/                   Android 工程（只有一个 MainActivity）
  app/src/main/java/com/yunyue/app/MainActivity.java
  app/src/main/res/...     图标、应用名「云曰」、主题
.github/workflows/android.yml  CI：推送即打包
```

## 二、用 GitHub 打包（推荐，零本地环境）

1. 把本次改动提交并推送到 GitHub（`main` 分支）：

   ```bash
   git add .
   git commit -m "feat: 云曰 Android APK 打包"
   git push origin main
   ```

2. 打开仓库页面 → **Actions** → 左侧 **Build APK** → 等 3~6 分钟。

3. 构建成功后，在该次运行页面底部 **Artifacts** 下载 `yunyue-apk.zip`，
   解压得到：

   - `yunyue.apk`：正式包（`com.yunyue.app`），没配签名密钥时用 debug 签名，一样能装
   - `yunyue-debug.apk`：调试包（`com.yunyue.app.debug`），可以和正式包同时安装

4. 也可以手动触发：Actions → Build APK → **Run workflow**。

> 没有配置签名密钥时，GitHub Actions 每次构建用的是临时 debug 密钥。
> 想长期覆盖安装同一个包、或要上架商店，请按第六节配置正式签名。

## 三、本地打包（可选）

需要 JDK 17 + Android SDK（`ANDROID_HOME` 指向 SDK 目录）：

```bash
node tools/prepare-apk-assets.mjs
cd android
gradle assembleRelease    # 产物：android/app/build/outputs/apk/release/app-release.apk
```

如果本机有 Android SDK 但没装 Gradle，可在 `android/` 下执行
`gradle wrapper --gradle-version 8.7` 生成 `gradlew` 后再用 `./gradlew assembleRelease`。

### 已在本机实测通过（2026-11-13）

| 检查项 | 结果 |
| --- | --- |
| `javac` 单独编译 `MainActivity.java`（classpath = `platforms/android-34/android.jar`） | 通过，只有 deprecation 提示 |
| `build.gradle` / `settings.gradle` / `app/build.gradle` Groovy 语法解析 | 通过 |
| `gradle help`（AGP 8.5.2 + Gradle 8.11.1 配置阶段） | `BUILD SUCCESSFUL` |
| `gradle assembleDebug` | `BUILD SUCCESSFUL`，`app-debug.apk` 2.27 MB |
| `gradle assembleRelease`（无密钥 → 回退 debug 签名） | `BUILD SUCCESSFUL`，`app-release.apk` 1.97 MB |
| `apksigner verify --print-certs` | `CN=Android Debug`，签名有效 |
| `aapt2 dump badging` | `package=com.yunyue.app`、`versionName=1.0.0`、`minSdk=24`、`targetSdk=34`、label=云曰、自适应图标 |
| APK 内 `assets/www/` | 12 个文件（index.html + vendor 11 个） |

本机产出的两个包已复制到 `dist/`（该目录不进 Git）：

- `dist/yunyue.apk` —— 正式包名 `com.yunyue.app`，可直接装
- `dist/yunyue-debug.apk` —— 包名 `com.yunyue.app.debug`，可与正式包共存（调试用）

> 本地构建时用到的 SDK 组件：`platforms;android-34`、`build-tools;34.0.0`、`platform-tools`，
> Gradle 8.11.1、JDK 17。GitHub Actions 里固定在 Gradle 8.7 + JDK 17，同样能过。

## 四、四条需求分别是怎么实现的

### 1. 全屏，连状态栏/刘海区域也用起来

- `MainActivity.applyFullscreen()`：
  `WindowInsetsController.hide(systemBars())`（Android 11+）/
  `IMMERSIVE_STICKY`（Android 7~10）+ `LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS`，
  窗口 `setDecorFitsSystemWindows(false)`，内容一直画到挖孔/刘海里；
  系统栏只在边缘滑入时临时浮现，几秒后自动隐藏。
- 刘海高度通过 `root.setOnApplyWindowInsetsListener` 读出来，
  以 dp 写进页面变量 `--android-inset-top`；
  页面顶部那条模拟状态栏（`.status-bar`）用它做上内边距，
  所以内容铺满整个屏幕，但时间/电量文字不会被挖孔挡住。
- 键盘弹出时：viewport 里补了 `interactive-widget=resizes-content`，
  布局视口会跟着缩小，聊天输入框不会被键盘顶住。

### 2. 左右滑动 / 返回键 = 退回上一页，而不是退出 App

- 原生侧：`onBackPressed()` 先执行页面里的 `window.__appBack()`，
  只有它返回 `false`（说明已经在桌面、没有上一页）时才 `finish()` 退出。
  这样系统返回手势 / 返回键的行为与 App 内返回按钮一致。
- 页面侧（`app/index.html` 末尾的「安卓壳适配」脚本）：
  - `window.__appBack()` 会点击当前页面上真实的 `.back-button`，
    子页面自己的清理逻辑（保存草稿、停止朗读等）照样执行；
  - 触摸滑动：横向位移 ≥ 70px、且明显大于纵向位移时触发同一个返回逻辑；
  - 在桌面（`page-home`）上滑动不响应，因此绝不会因为误滑而退出 App；
  - 手势起点在输入框、或横向可滚动容器（如桌面分页）里时不接管。

### 3. 数据导入 / 导出

- **导入**：页面里的 `<input type="file">`（`#import-data-input`、头像、角色卡等）
  由 `AppChromeClient.onShowFileChooser()` 接到系统文件选择器，
  并把 `accept`（`.json` / `image/*` / `.lrc` / `.ttf`…）翻译成 MIME 过滤，
  选完文件后 `parseResult()` 把内容交回网页，和浏览器里完全一样。
- **导出**：网页原本生成 `blob:` 链接再点 `download`，WebView 无法直接下载。
  页面里的适配脚本在捕获阶段拦截 `a[download]`，把 blob 分片（512KB/片）
  通过 `AndroidBridge` 交给原生，按顺序写入
  **「下载/云曰/」**（Android 10+ 走 MediaStore，无需权限；Android 7~9 会申请一次存储权限，
  失败则回落到 App 私有目录），完成后用 Toast 提示保存位置。
- 导出文件名沿用网页逻辑（`37Chat-data-日期.json`），导入只校验内容、不看文件名。

### 4. 应用名「云曰」+ 新图标

- 名字：`android/app/src/main/res/values/strings.xml` 里的 `app_name`，
  同时打包时会替换网页 `<title>` 与 `apple-mobile-web-app-title`。
  包名仍是 `com.yunyue.app`（与旧版不同，所以属于「新装」而不是覆盖升级）。
- 图标：`tools/make-icons.ps1` 从根目录 `icon.jpg` 生成
  - `mipmap-*/ic_launcher.png`：Android 7 及以下的圆角方形图标
  - `mipmap-*/ic_launcher_round.png`：圆形启动器图标
  - `mipmap-*/ic_launcher_foreground.png`：Android 8+ 自适应图标前景
    （108dp 画布、主体占 80%，圆形/方形/水滴遮罩都不会切到主体）
  - `mipmap-anydpi-v26/ic_launcher*.xml`：自适应图标声明，底色 `#0E0C0A`
- 换图标：替换根目录 `icon.jpg` 后执行
  `powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1`，再提交即可。

## 五、为什么不直接用 `file://` 打开网页

工程通过 `WebViewClient.shouldInterceptRequest` 把
`https://localhost/**` 映射到 `assets/www/**`。这样页面运行在
`https://localhost` 这个安全来源下：IndexedDB（Dexie）、`localStorage`、
`crypto.subtle`、`navigator.clipboard`、`fetch` 都和浏览器里一致，
不会像 `file://` 那样被各种限制（也是数据导入导出能正常工作的前提）。

## 六、配置正式签名（可选）

1. 本地生成密钥（一次性）：

   ```bash
   keytool -genkeypair -v -keystore yunyue.jks -alias yunyue \
           -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 yunyue.jks          # Windows: certutil -encode yunyue.jks out.txt
   ```

2. 仓库 Settings → Secrets and variables → Actions，添加：

   | Secret | 值 |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | 上一步的 base64 文本 |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
   | `ANDROID_KEY_ALIAS` | `yunyue` |
   | `ANDROID_KEY_PASSWORD` | key 口令 |

3. 再次运行 workflow，`yunyue.apk` 就是正式签名包了。

## 七、装上了但闪退 / 打不开怎么排查

从 2026-11-13 的版本起，壳里加了三层兜底，正常情况下不该再出现「点开就闪退」：

1. **启动期异常不再闪退**：`onCreate` 里的任何异常都会被 `showFatalError()` 接住，
   直接把堆栈铺在屏幕上（可长按复制），并写进 `last-crash.txt`。
   → 看到「云曰 启动失败」页面，把那段文字截图就能定位原因。
2. **进程级崩溃下次可见**：未捕获异常会落盘，下次启动时在页面顶部显示一条红色横幅，
   点一下关闭。
3. **WebView 渲染进程崩溃自恢复**：`onRenderProcessGone()` 接管（默认行为会连累整个 App
   被杀掉，用户看到的就是闪退），销毁旧 WebView 后重建并重新加载。
4. **安全模式**：万一 `https://localhost` 被 ROM 拦截，会自动回退到
   `file:///android_asset/www/index.html` 并提示「安全模式加载中」
   （这个模式下 IndexedDB 不可用，只当兜底）。
5. **开屏自检**：页面 `<head>` 最前面注入了一段纯 ES5 脚本，卡在开屏时会把原因写在
   「37Chat / 正在加载数据」那行字的位置上，红字，形如
   `启动脚本出错：…` / `初始化失败：…` / `初始化卡住了（8 秒未完成）… | WebView 120 | https://localhost/index.html`。
   看到红字直接截图即可。另外打包时开屏大字已经从 37Chat 改成「云曰」
   （Dexie 库名 `37ChatDB` 保持不动，否则等于清空用户数据）。

如果仍然直接闪退（连错误页都来不及显示），那就是进程级/native 崩溃，需要系统日志：

```bash
# 手机开 USB 调试，连电脑后
adb logcat -b crash -d            # 只看崩溃
adb logcat -d | findstr YunYue    # 看应用自己的日志（TAG = YunYue）
```

把 `FATAL EXCEPTION` 那一段发出来即可。

另外两个常见「打不开」的误会：

- **提示「应用未安装」**：说明签名冲突（不是闪退）。没配正式签名时，
  GitHub Actions 每次跑都是全新的临时 debug 密钥，和上一次的包签名不同，不能覆盖安装。
  解决：先卸载旧包，或者按第六节固定正式签名。
- **想验证「是不是新包的问题」**：装 `yunyue-debug.apk`（包名 `com.yunyue.app.debug`），
  它能和正式包共存，全新安装、互不影响。



- **装不上 / 提示已存在同签名应用冲突**：debug 签名与正式签名不能共存，
  先卸载旧包（数据会丢，先导出备份）。
- **网页更新了但 APK 里还是老内容**：APK 里的网页是打包时快照，
  改完 `app/` 要重新跑一次 workflow。
- **想在手机上调试网页**：连电脑后打开 Chrome `chrome://inspect`，
  WebView 已开启调试（`setWebContentsDebuggingEnabled(true)`）。
- **导出失败**：先看 Toast 提示的路径；若 Android 7~9 拒绝了存储权限，
  文件会写到 App 私有目录（`Android/data/com.yunyue.app/files/Download/`）。
