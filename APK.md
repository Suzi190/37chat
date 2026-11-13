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
- **刘海区不再是「一条白条」**：壳里系统状态栏已经隐藏，
  如果页面那条还铺 `--header-bg-color`（纯白），刘海区就是一块白底、跟页面底色对不上，
  看起来就像没全屏。所以 Java 侧在 `onPageFinished` 和刘海高度变化时都会注入
  `document.documentElement.classList.add('android-shell')`，
  页面 CSS 用 `html.android-shell .status-bar` 把它改成**透明、只留 20px 显示时间/电量**，
  露出来的就是页面自己的底色 —— 刘海区等于被页面用起来了。
  浏览器里打开（没有这个 class）仍然是原来那条带白底的模拟状态栏。
- 启动瞬间的窗口底色 `window_background` / `rootView` 背景都改成页面的 `#FDF6F7`，
  不再先黑一下再变浅色。
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
- 图标：`tools/make-launcher-icon.mjs`（从 `tools/launcher-source.png` 生成）
  - `mipmap-*/ic_launcher_background.png`：**无色磨砂玻璃**底（浅白渐变 + 细颗粒 + 柔光 + 边缘亮线），
    不透明的，避免半透明底色被启动器垫成灰块
  - `mipmap-*/ic_launcher_foreground.png`：中央嵌一枚圆形插画徽章（直径 60%，落在自适应图标安全区内），
    四周是透明的，露出底下的玻璃
  - `mipmap-*/ic_launcher.png` / `ic_launcher_round.png`：Android 7 及以下的圆角方 / 圆形图标
  - `mipmap-anydpi-v26/ic_launcher*.xml`：自适应图标声明，
    `background` 指向 `@mipmap/ic_launcher_background`（不是纯色了），`foreground` 指向徽章
- **为什么以前换图标「没变化」**（踩过的坑，写在这里免得再踩）：
  Android 8.0+ 的桌面只认 `mipmap-anydpi-v26/ic_launcher.xml` 这一份「自适应图标」。
  - 只替换 `ic_launcher.png` → 8.0+ 根本不读，看起来毫无变化；
  - 只改 `colors.xml` 里的 `ic_launcher_background` 颜色 → 前景 PNG 自带一层黑底，把底色整块盖住，
    同样看不出变化；
  - 直接跑 `make-icons.ps1` 把 `icon.jpg` 整幅缩成前景 → 整幅是不透明方图，既露直角、也顶掉了背景色。
  所以现在改成「玻璃底（背景图）+ 圆形徽章（前景，透明边）」两层，
  前景不遮背景，换哪一层都能立刻看出来。
- 换图 / 换色：
  ```powershell
  # 换插画：替换 tools/launcher-source.png 后
  node tools\make-launcher-icon.mjs
  # 顺手把徽章换成别的配色（默认保留原插画的米金色）
  node tools\make-launcher-icon.mjs --tint=#3B5B7A
  ```
  原始图标自动备份在 `.icon-backup/`，随时可以复制回 `res/` 回滚。

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
   `启动脚本出错：…` / `初始化失败：…` / `IndexedDB 无响应（可能被系统/隐私空间禁用）…` /
   `初始化卡住了（8 秒未完成）… | WebView 120 | https://localhost/index.html`。
   看到红字直接截图即可。另外打包时开屏大字已经从 37Chat 改成「云曰」
   （Dexie 库名 `37ChatDB` 保持不动，否则等于清空用户数据）。
6. **白屏卡开屏的真凶往往是内联脚本语法错误**。2026-11-13 修掉的那次就是：
   往 `app/index.html` 里插「安卓壳适配」代码时漏了一个 `</script>`，浏览器把紧随其后的
   `<!-- 安卓壳适配 … -->` HTML 注释和第二个 `<script>` 全吞进了主脚本，
   1.4MB 主脚本报 `SyntaxError: Invalid or unexpected token`（全角括号），
   一行 JS 都没执行 —— 所以永远停在开屏，且看起来「什么错都没有」。
   这类错误浏览器只吐一句 `SyntaxError`，肉眼极难发现，所以加了一道硬检查：

   ```bash
   node tools/check-html-syntax.mjs   # 用 V8 把每段内联 <script> 都编译一遍
   ```

   它已经接进 CI（`校验内联脚本语法` 步骤）：语法不过就直接红叉，不会再产出白屏包。
   手动改完 `app/index.html` 后建议先跑一遍。

   还有个更接近真机的验证（本地跑，需要 Node 22+ 与本机的 Chrome/Edge）：

   ```bash
   node tools/prepare-apk-assets.mjs
   node tools/smoke-test-page.mjs
   ```

   它用 headless Chrome/Edge 真打开打包后的页面，等 9 秒再检查
   「开屏关掉了 / 进了首页 / 没有未捕获异常」，逐条输出 `[PASS]` / `[FAIL]`。
   `Invalid or unexpected token` 那类问题在这里会直接 FAIL。

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



- **装不上 / 提示「已存在同签名应用冲突」**：debug 签名与正式签名不能共存，
  先卸载旧包（数据会丢，先在 App 里导出备份）。
- **网页更新了但 APK 里还是老内容**：APK 里的网页是打包时快照，
  改完 `app/` 要重新跑一次 workflow（或本地重新 `assembleDebug`）。
- **想在手机上调试网页**：连电脑后打开 Chrome `chrome://inspect`，
  WebView 已开启调试（`setWebContentsDebuggingEnabled(true)`）。
- **导出失败**：先看 Toast 提示的路径；若 Android 7~9 拒绝了存储权限，
  文件会写到 App 私有目录（`Android/data/com.yunyue.app/files/Download/`）。

## 八、换了新包，图标 / 顶部还是老样子？

先分清是「包没换」还是「系统缓存」——下面三条按顺序确认，基本能一次定位。

### 1. 确认装上的确实是新包

```bash
adb shell dumpsys package com.yunyue.app | findstr versionName
adb shell dumpsys package com.yunyue.app | findstr lastUpdateTime
```

`lastUpdateTime` 不是刚刚，就说明系统根本没装新包（多半是签名不一致被静默拦下了，
详见第七节的「应用未安装」）。没 adb 就看「设置 → 应用 → 云曰」里的版本/安装时间。

### 2. 图标没变：桌面缓存，不是包的问题

Android 8.0+ 的桌面**只读自适应图标**（`mipmap-anydpi-v26/ic_launcher.xml`），
而且会把渲染结果缓存进 launcher 的数据库。换包后图标不动，按这个顺序试：

1. **完全卸载再装**（不是覆盖安装）—— 缓存跟着包一起清掉；
2. 国产桌面（MIUI / EMUI / ColorOS / OriginOS）还有一层自己的图标缓存：
   「设置 → 应用管理 → 找到「桌面」→ 清除缓存」，
   或者长按图标 →「编辑 / 更换图标」→ 恢复默认；
3. 换个主题再换回来，能强制桌面重绘图标；
4. 装 `yunyue-debug.apk` 验证：它是**另一个包名**（`com.yunyue.app.debug`），
   桌面上会多一个全新图标，不受旧缓存影响 —— 如果 debug 包的图标是新的，
   那就 100% 是旧包的缓存问题，而不是打包问题。

> 自查方法：`mipmap-anydpi-v26/ic_launcher.xml` 里 `background` 指向的是
> `@mipmap/ic_launcher_background`（一张磨砂玻璃 PNG），不是 `@color/...`。
> 只要还是 `@color`，那就是没打上这次的新图标。

### 3. 顶部还是一条白条：看页面有没有拿到 `android-shell`

壳里系统状态栏是隐藏的，顶部那条是**页面自己画的模拟状态栏**。
要让它变透明，必须满足两个条件，缺一不可：

1. Java 侧注入成功：`html` 元素上有 `android-shell` 这个 class；
2. 页面 CSS 里有 `html.android-shell .status-bar { background: transparent; ... }`。

用 `chrome://inspect` 连上设备后，在 Console 里敲：

```js
document.documentElement.className            // 应该包含 android-shell
getComputedStyle(document.querySelector('.status-bar')).backgroundColor
// 必须是 rgba(0, 0, 0, 0)，如果是 rgb(255, 255, 255) 就是 CSS 没进包
```

- 没有 `android-shell`：说明 WebView 里跑的还是旧网页（重新打包），
  或 `onPageFinished` 没触发（换页后不消失是正常的，class 在 `html` 上，切页不会掉）。
- 有 class 但背景仍是白色：**CSS 优先级被页面后面的规则盖掉了**，
  把 `html.android-shell .status-bar` 这段往后挪，或加 `!important` 排查。

