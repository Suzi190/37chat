# 37Chat 本地可运行版

## 为什么线上链接打不开

线上站 `https://woowmmsmwmdmmummwmwddmwmdmwmuqmmmdwmd.netlify.app` 本身没坏，是它 `<head>` 里
**两个同步阻塞的第三方脚本**在你这台机器上取不到：

| 依赖 | 实测结果 |
| --- | --- |
| `cdn.jsdelivr.net/.../markdown-it.min.js` | `ERR_CONNECTION_RESET`（连接被重置，直接不可用） |
| `unpkg.com/dexie/dist/dexie.js` | 首次 8.1 秒，之后直接 40 秒超时 |
| `cdnjs.cloudflare.com/.../font-awesome` | 可用，约 5 秒 |

因为它们是 `<head>` 里的普通 `<script src>`（没有 `defer`/`async`），浏览器会**阻塞解析**，
所以 `<body>` 里的开屏画面都出不来，表现为白屏或一直转圈。

更致命的是：内联主脚本第 12873 行就是

```js
const md = window.markdownit();
```

只要 markdown-it 没加载成功，这一行抛 `TypeError`，后面 27,000 行（包含 `DOMContentLoaded`
监听和 `init()`）**全部不执行**，开屏遮罩 `#app-splash-screen` 永远不会被移除。

## 这个目录里是什么

- `app/index.html` —— 单文件应用。基于线上原版，把 3 个 CDN 地址换成本地 `vendor/` 相对路径，
  并叠加了下面「线下模式改版」一节的改动
- `37chat-deployed.html` —— 同一份代码，仅把 3 个 CDN 地址换回线上地址。**不要手工编辑**：
  改完 `app/index.html` 后运行 `node sync-deploy.mjs` 自动重新生成（脚本会校验 3 处替换各命中一次）
- `sync-deploy.mjs` —— 上面这条同步动作的实现，无第三方依赖
- `app/index.bak.html` —— 改版前的原始副本，确认新版没问题后可以删掉
- `app/vendor/markdown-it.min.js` —— markdown-it 14.0.0（走 npmmirror 镜像取得）
- `app/vendor/dexie.min.js` —— Dexie 4.4.7
- `app/vendor/fontawesome/` —— Font Awesome 6.5.1 的 CSS + webfonts，离线可用
- `server.mjs` —— 20 多行的本地静态服务器（Node，无任何依赖）
- `start-local.cmd` —— 双击启动：起本地服务并自动打开浏览器

## 怎么用

双击 `start-local.cmd`，浏览器会打开 `http://127.0.0.1:5180/`。

> **必须走 http，不能双击 index.html。**
> `file://` 协议下浏览器会禁用 IndexedDB，而本应用所有数据（角色、聊天记录、设定集）
> 都存在 IndexedDB 里，用 `file://` 打开会加载失败。

命令行等价做法：

```powershell
cd d:\37chat
node server.mjs 5180
# 然后浏览器打开 http://127.0.0.1:5180/
```

## 验证结果（无头 Edge + CDP 实测，加载 9 秒后）

本地版：

```json
{"splashStillThere":false,"markdownitGlobal":"function","mdInstance":"object",
 "dexieGlobal":"function","dexieVersion":"4.4.7","stateCharacters":0,
 "stateUserPersonas":1,"visiblePage":"page-home"}
```

线上原版（同一台机器）：

```json
{"splashStillThere":false,"markdownitGlobal":"undefined","dexieGlobal":"undefined",
 "stateCharacters":-1,"visiblePage":null}
```

唯一残留的报错是 `favicon.ico` 404，无害。

## 角色卡导入（SillyTavern）

「角色与身份」页 → 右下角 `+` → **导入角色卡 (SillyTavern)**，支持一次选中多个文件：

| 文件 | 说明 |
| --- | --- |
| `.png` 角色卡 | 读取 PNG 里的 `chara` / `ccv3` 数据块（tEXt 与 iTXt、含 deflate 压缩的都支持），图片本身转成 256px 头像 |
| `.json` 角色卡 | `chara_card_v1`（扁平结构）与 `chara_card_v2` / `v3`（`spec` + `data` 包装）都支持 |
| `.json` 世界书 | SillyTavern 导出的 `world info`（`{ entries: { uid: {...} } }`），只建「设定集」，不建角色 |

字段映射：

| SillyTavern | 37Chat |
| --- | --- |
| `name` + PNG 图 | 角色名 + 头像 |
| `description` / `personality` / `scenario` / `mes_example` | 合并成「设定 (Prompt / Persona)」 |
| `system_prompt` / `post_history_instructions` | 「线上聊天规则」 |
| `first_mes` | 预置为聊天里的第一条 AI 消息（`{{char}}`→角色名，`{{user}}`→你） |
| `character_book.entries` | 自动生成「设定集」并绑定到该角色，分类为 `角色卡导入` |
| `tags` / 描述里的性别线索 | 启发式推断「性别」 |
| `creator` / `tags` / `alternate_greetings` 等 | 存入 `cardMeta` 备查（应用不读取，不影响运行） |

说明：

- 世界书里被禁用的条目（`enabled: false` / `disable: true`）不会导入；条目注释和触发词会写进每个条目的标题，
  因为 37Chat 的设定集是整本常驻注入，没有关键词触发机制。
- `prompt` / `chatRules` / 设定集正文里的 `{{char}}`、`{{user}}` 会保留，应用拼提示词时会自动替换成角色名和人设名。
- 导入后的角色默认未锁定身份，点击角色右侧的「锁」图标绑定你的身份即可开始聊天。
- 单个文件出错不会中断整批导入，结束后会汇总提示成功与失败项。

## 线下模式改版

### 线下时间线

进入线下模式后，聊天区不再只显示「这一次」的对话，而是把这个角色（或群聊）的**所有**线下剧情
按时间顺序排成一列：

- 每段前有一条 `线下 · 10月24日 20:45 · 12 条` 的分隔条；正在进行的这段会多显示 `· 进行中`
- 点分隔条 → 打开这一段完整记录（弹窗），单聊/群聊都支持
- 默认只渲染最近 5 段，更早的收在顶部「查看更早的 N 段线下记录」里，点一下全部展开
- **只有当前这一段**可以长按编辑、可以勾选删除；历史段的气泡不带 `data-message-index`，
  长按不会弹编辑框（避免改错会话），要编辑就在弹窗里长按

### 12 小时续接

- 距上次线下结束**不到 12 小时**、且那段不到 60 条消息时，再次进入线下会**接着那一段**继续，
  不再新开一个空白会话
- 续接时会先移除线上那条「线下聊天记录」入口，退出时再重新生成，所以不会出现重复卡片
- 超过 12 小时或超过 60 条 → 开新的一段，旧段变成只读历史

### 线上摘要卡片

退出线下后，线上聊天里原来只有一行「点击查看线下聊天记录」的占位，现在换成摘要卡片：

- 标题 + 时间 + 条数（`线下聊天记录 / 20:45 · 2 条`）
- 最后 2 条消息预览（说话人 + 内容，超过 40 字截断）
- 底部「查看完整记录 ›」，点卡片或这行字都能打开完整记录
- 群聊同样可用（原来只查 `state.characters`，群聊点不开）

### 顺带修掉的 5 个 bug

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | 群聊里发的线下消息被写进角色表（写错对象），刷新后丢失 | 新增 `getOfflineChatTarget()`，按 `activeChatContext` 取角色/群聊对象及对应的表 |
| 2 | 删除单条 / 批量删除后不落库，刷新就还原 | 删除后 `await table.put(obj)` |
| 3 | 「清空全部记录」只清当前一段 | 清空该角色/群聊的所有线下段，并同步删掉线上对应的 `offline_log` 入口，最后留一个空会话继续聊 |
| 4 | 线下消息长按编辑后不落库，刷新还原 | 编辑保存后立即 `table.put` |
| 5 | 群聊点「线下聊天记录」卡片没反应 | 打开逻辑改为 `showOfflineSessionLog(sessionId)`，单聊/群聊通用，找不到时提示 |

### 验证

无头 Edge + CDP 端到端跑过 12 项检查：建角色 → 进线下 → 发消息 → 退出看卡片 → 12h 内续接 →
把时间改到 13h → 开新段 → 长按（历史只读 / 当前可编辑）→ 折叠展开 → 删除落库 → 群聊写群聊表 →
清空全部 → 刷新后持久化。全部 PASS，控制台无报错。

## 桌面（分页 / 拖拽 / 小组件）

原来首页是固定的 8 个图标 + 一张资料卡，现在是一个真正的手机桌面：

- **4 列网格 + 多页**：底部圆点就是页码，点圆点直接跳页；左右滑动翻页（`scroll-snap`，一格一页）
- **长按任意图标/空白处进入编辑模式**：图标开始抖动，底部出现 `＋页面 / ＋小组件 / 完成`
- **拖拽换位**：编辑模式下按住图标即可拖动，松手位置就是新位置；拖到屏幕左右边缘停约 0.5 秒会自动翻到上一页/下一页，可以把图标拖到别的页
- **页面管理**：`＋页面` 新建空页；编辑模式下空页的圆点上方出现 `×`，可删掉该页（第 1 页固定为资料卡所在页，不能删）
- **资料卡仍是原来那一块**：昵称/签名可点着改，头像、背景图、图标自定义、隐藏图标文字等原有功能全部照旧（DOM 结构和 ID 都没动，只是被放进了第 1 页的第一格）

布局存在 `state.ui.homeLayout`，跟着 `db.appState{id:'main'}` 一起存 —— **没有新增表、没有升 Dexie 版本**，老数据直接兼容：

```js
state.ui.homeLayout = {
  version: 1,
  activeIndex: 0,                                  // 当前停在第几页
  pages: [
    { id: 'home_p1', items: [
      { kind: 'app', key: 'chat' },                // 应用图标（key 见 HOME_APP_DEFS）
      { kind: 'widget', id: 'w_xxx', type: 'example-clock', size: '2x2', data: {} }
    ] }
  ]
}
```

读取时会做一次自愈（`normalizeHomeLayout`）：未知 `type`、越界 `activeIndex` 都会被修正；万一某个应用图标丢了，会自动补回最后一页，不会出现「入口消失」。

### 内置小组件

`＋小组件` 面板里默认有七个可选组件（都只是**选项**，点面板里的尺寸按钮才会加到桌面，不会自动摆上去）：

| 组件 | 尺寸 | 说明 |
| --- | --- | --- |
| `polaroid-duo` 拍立得 · 叠影 | 2×2 | 两张倾斜叠放的拍立得 |
| `polaroid-trio` 拍立得 · 三联 | 4×2 | 三张并排，中间那张带手写体短句 |
| `photo-single` 照片 · 单张 | 2×2 | 一整张铺满卡片的照片 + 右上角日期小牌，空位有「点一下放照片」提示 |
| `note-chat` 小纸条 · 对话 | 4×1 | 两条铺满整行的药丸气泡，圆头像和气泡一样高、压在气泡两端（头像盖住气泡的圆头），一上一下反向歪 1°；点气泡改字，点圆圈换头像 |
| `little-joys` 小确幸 | 4×2 | 三张方图 + 一句小字，右下角圆形按钮点一下换一句 |
| `diary-calendar` 手帐日历 | 4×4 | 左侧四张植物卡片 + 右侧日历 / 时间 / 电量 / 存储 + 中间大图 |
| `example-clock` 示例·时钟 | 2×2 / 4×2 | 演示机制的最小示例，可整段删掉 |

所有图片位都是**装饰位**：非编辑模式下点一下照片就会弹出选图框，图片会按最长边 1280px 压成 JPEG dataURL 存进 `item.data[key]`（`photoA` / `photoB` / `photoC` / `photo` / `noteA` / `noteB` / `joyA` / `joyB` / `joyC` / `railA~railD` / `hero`），随布局一起持久化 —— 所以换图不需要后端，也不需要新增数据表。编辑模式下点图片不会弹选图框（那时是拖拽）。

小纸条里的两句话同理存在 `item.data.textA` / `textB`：点气泡弹出同一套玻璃风格的小输入层（`Enter` 保存 / `Esc` 或点遮罩取消），存空就是回到默认那句（`˚₊ ♡ 私たちの永遠の幸福 @Avery ♡ ₊˚` / `˚₊ ♡ I love you #Evan .♡ ♡ ₊˚`）。气泡里的字是居中的一行小字，太长会自动省略号，所以自己改长句也不会撑破卡片。

拍立得、照片、小确幸、手帐日历、小纸条的容器都是**透明的**：注册时写 `plain: true`，桌面就不给它们画白底板和阴影，卡片直接浮在壁纸上。其中小确幸 / 手帐日历 / 照片 / 小纸条共用一套**无色磨砂玻璃**（`.hw-glass`：只叠白色 alpha + `backdrop-filter` 模糊身后的壁纸，不加任何灰/蓝色调，所以浅色壁纸上也不会发脏），字色统一用深灰保证可读；拍立得则是白纸相框。

### 如何注册你自己的小组件

小组件是**纯机制**：上面这些组件只是「用这套机制写出来的内置样式」，你可以照抄或整段替换。
在 `app/index.html` 里搜 `内置小组件：拍立得` 就能看到它们的全部实现（注册 + CSS 在 `/* ---------- 内置小组件 */` 一段）。

```js
HomeWidgets.register({
    type: 'my-widget',            // 唯一标识，会存进布局
    name: '我的组件',              // 「＋小组件」面板里显示的名字
    desc: '一句话说明',            // 面板里的说明，可省略
    sizes: ['2x2', '4x2'],        // 支持 1x1 / 2x1 / 2x2 / 4x1 / 4x2 / 4x4
    plain: true,                 // 可选：不要桌面的白底板/阴影，内容直接浮在壁纸上
    render(el, ctx) {
        // el 是已清空的内容容器（外层圆角/尺寸/背景由桌面负责，plain: true 时没有背景）
        el.innerHTML = '<div class="hw-center"><div class="hw-h1">你好</div></div>';

        const timer = setInterval(() => { /* ... */ }, 1000);
        ctx.onDestroy(() => clearInterval(timer));   // 重渲染/删除前调用，务必清定时器、解绑事件
    }
});
```

`ctx` 提供的东西：

| 成员 | 作用 |
| --- | --- |
| `ctx.item` | 该小组件实例（`{ id, type, size, data }`） |
| `ctx.data` | 持久化对象，重渲染/刷新后仍在 |
| `ctx.setData({...})` | 合并进 `ctx.data` 并立即保存 |
| `ctx.save()` | 手动保存（改完 `ctx.data` 后调用） |
| `ctx.refresh()` | 重新渲染自己 |
| `ctx.onDestroy(fn)` | 注册清理函数 |
| `ctx.navigateTo(pageId)` | 跳到其它页面，如 `ctx.navigateTo('page-settings')` |

其它 API：`HomeWidgets.list()`（面板会列出全部已注册组件）、`HomeWidgets.get(type)`、`HomeWidgets.refresh(type?)`（数据变了让组件重画）、`HomeWidgets.unregister(type)`。`window.HomeWidgets` 也挂了一份，方便你在控制台里试。

样式请自己写（`el` 内部随便用什么结构）。桌面只提供几个中性工具类：`.hw-center`（居中纵向排列）、`.hw-h1`（大号数字/标题）、`.hw-caption`（小字说明）——不用也行。

> 尺寸与外观是分开的：`size` 决定占 1/2/4 列、1/2/4 行，圆角、阴影、内边距由 `.home-widget` 统一给，内容区就按实际像素写 CSS 即可。320px 宽的小屏也是 4 列，横向不会溢出。

### 验证

无头 Edge + CDP 端到端 47 项：默认单页 8 图标 / 资料卡在第 1 页 / 长按进编辑 / 拖到任意行列并吸附 / 其它图标让位 / 拖到屏幕边缘翻页跨页放置 / 刷新后坐标与小组件都还在 / 320px 无横向溢出 / 六个内置组件只出现在「＋小组件」面板（2×2、4×2、4×2、4×4、2×2、4×1 尺寸与内容都对，拍立得卡片高宽比 ≥ 1.3 且旋转后不出容器，拍立得 / 照片 / 小确幸 / 手帐日历 / 小纸条外层算出来的背景是 `rgba(0, 0, 0, 0)` 且无阴影，小确幸 / 手帐日历 / 照片 / 小纸条四张卡解析出来的渐变只有 `rgba(255, 255, 255, ·)` 没有任何色偏、带 `blur(20px)`、字色亮度 < 130，小确幸第一格点阵 + 右下角按钮点一下换一句，照片组件图片位铺满卡片、右上角日期为 `M/D 周X`，小纸条两个圆头像（30px、`border-radius: 50%`）压在气泡两端、气泡本身是整行的药丸（圆角半径 ≥ 高度一半）且两行都落在组件盒子里，点气泡弹出玻璃改字层预填当前字、确定后写回布局并重渲染、Esc 取消不写入）/ 图片位写入 dataURL 后渲染成图并留在布局里、照片组件换图后空态提示自动隐藏 / 控制台无报错 —— 全部 PASS（`node .tmp_check/verify-v4.mjs`，结果见 `.tmp_check/verify-v4-result.txt`）。

## 想继续用线上链接的话

把 `app/index.html` 第 12–13 行的写法照搬到部署配置里，或把这两个库传到自己的目录后改成相对路径。
如果那个 Netlify 站点是你自己的，直接重新部署这份 `app/` 目录即可。
