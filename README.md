# Free Doodle

Draw and annotate directly on your Obsidian notes — ink lives on a separate layer above the text and follows it as your note evolves.

English | [中文](#中文说明)

## Features

- **In-note doodling** — press `Ctrl+D` or click the highlighter ribbon icon to draw right on top of note content; works in editing and reading views
- **Text anchoring** — every stroke remembers the paragraph/line it was drawn on; add/remove properties, paragraphs or resize panes and ink follows the anchored text
- **Tools** — pen, translucent highlighter, rectangle box, pixel eraser, whole-stroke eraser
- **Handwriting beautify** — write a line of Chinese characters, English letters, or digits, recognize it, and replace it with editable neat text (PP-OCRv5; model downloaded once ~28 MB, then offline; HanziLookupJS as fallback)
- **Custom beautify font** — import a local `.ttf`, `.otf`, `.woff`, or `.woff2` font in settings; it is cached locally and used for newly recognized handwriting
- **Opacity slider** — 10%–100%, applies per stroke
- **Reading mode & embeds** — ink overlays reading view automatically (and you can annotate there); doodles also render inside embeds and hover previews
- **Clean storage** — strokes are saved as base64 in a `free-doodle` frontmatter property inside the note itself; the property removes itself automatically when empty
- **Standalone board** — a full-screen scratch pad sharing all tools, exportable as PNG into your note

## Install

### Manual

1. Download `main.js` and `manifest.json` from the latest release
2. Put them into `<vault>/.obsidian/plugins/free-doodle/`
3. Enable **Free Doodle** in Settings → Community plugins

### Via BRAT

Add this repository: `T-T2333/obsidian-free-doodle`

## Usage

| Action | How |
| --- | --- |
| Start / stop annotating | highlighter ribbon icon / `Ctrl+D` / command palette |
| Finish & save | floating toolbar "done" button / `Esc` |
| Undo | `Ctrl+Z` |
| Recognize handwriting | enable the handwriting tool, write a line (leave small gaps between characters), then pause for auto-replace or use the sparkle icon to edit the result |
| Clear ink of current note | command "Clear doodle data of current note" |
| Clean empty data vault-wide | command "Remove empty doodle properties across vault" |
| Open standalone board | plugin settings button / command palette |

## Privacy & data access disclosure

- The plugin makes **no network requests** during normal drawing; the handwriting tool downloads recognition assets **once** on first use and caches them in the plugin folder — PP-OCRv5 model + ONNX Runtime Web runtime (~28 MB total; multi-mirror, offline afterwards). If that fails, it may fall back to HanziLookupJS data (~0.8 MB, Make Me a Hanzi)
- Imported beautify fonts stay local: the selected file is copied to the plugin folder and never uploaded
- Ink data is stored locally inside your own notes
- The *"Remove empty doodle properties across vault"* command enumerates markdown files in your vault solely to find empty `free-doodle` properties left by earlier versions
- The standalone board writes exported PNGs to your clipboard when you click *Save PNG*

## Credits

- Handwriting recognition: [PP-OCRv5](https://github.com/PaddlePaddle/PaddleOCR) (Apache-2.0) via [ibus-qikai](https://github.com/kekxv/ibus-qikai) model assets, running with [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT)
- Fallback stroke matcher: [HanziLookupJS](https://github.com/gugray/HanziLookupJS) (GPL-3.0), stroke data from [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) / Arphic PL

## Notes & limitations

- Anchors reference the text block they were drawn on; if that text itself is deleted or heavily rewritten, affected strokes fall back to absolute positioning
- Source text and rendered text can differ (Markdown symbols), so cross-view matching may occasionally fall back

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build (with type check)
npx eslint main.ts
```

## License

[MIT](LICENSE)

---

## 中文说明

一个 Obsidian 插件：在笔记上直接涂鸦、划线、圈注。墨迹作为独立图层叠加在文字上方，并随笔记内容变化自动跟随移动。

[English](#free-doodle) | 中文

## 功能特性

- **笔记内涂鸦**：`Ctrl+D` 或点击左侧荧光笔图标，直接在正文上方标注；编辑 / 阅读模式均支持
- **文字锚点跟随**：每一笔自动锚定所在段落或行——增删属性、段落或拖动侧边栏导致文字移动时，墨迹跟着走
- **多种工具**：钢笔、荧光笔（半透明）、矩形框选、像素橡皮擦、整笔擦除
- **手写美化**：手绘一行中文、英文或数字，停顿后自动识别并替换为可编辑的美化文字（PP-OCRv5；首次使用下载约 28MB 模型后离线；失败时回退 HanziLookupJS）
- **自定义美化字体**：在设置中导入本地 `.ttf`、`.otf`、`.woff` 或 `.woff2` 字体，之后新识别的手写文字会使用该字体
- **不透明度滑杆**：10%–100%，逐笔生效
- **阅读模式与嵌入**：阅读视图自动叠加显示墨迹（也可直接涂鸦）；嵌入引用与悬浮预览同样渲染
- **干净存储**：墨迹以 base64 存入笔记自身 frontmatter 的 `free-doodle` 属性，清空后自动删除，不留痕迹
- **独立画板**：全屏画板共享全部工具，可导出 PNG 并插入笔记

## 安装

### 手动安装

1. 下载最新 Release 中的 `main.js` 与 `manifest.json`
2. 放到你的库：`<vault>/.obsidian/plugins/free-doodle/`
3. 设置 → 第三方插件 → 启用 **Free Doodle**

### 通过 BRAT 安装

1. 安装并启用 BRAT 插件
2. 命令面板 → `BRAT: Add a beta plugin for testing`
3. 输入仓库地址：`T-T2333/obsidian-free-doodle`

## 使用方法

| 操作 | 方式 |
| --- | --- |
| 进入/退出涂鸦模式 | 左侧荧光笔图标 / `Ctrl+D` / 命令面板 |
| 完成并保存 | 浮动工具栏"完成"按钮 / `Esc` |
| 撤销 | `Ctrl+Z` |
| 手写识别 | 选择「手写识别」工具 → 写一行中文/英文/数字（字符间留一点空隙）→ 停顿约 1.2 秒自动替换整行（✨ 可手动编辑识别结果） |
| 清空当前笔记墨迹 | 命令面板"清除当前笔记的涂鸦数据" |
| 批量清理空数据 | 命令面板"清理全库" |
| 打开独立画板 | 设置页按钮 / 命令面板 |

## 隐私与数据访问说明

- 正常涂鸦**不发任何网络请求**；「手写识别」首次使用会下载一次识别资源并缓存到插件目录（PP-OCRv5 模型 + ONNX Runtime Web，合计约 28MB，多镜像、之后离线）；若失败则回退下载 HanziLookupJS 数据（约 0.8MB，Make Me a Hanzi）
- 导入的美化字体只保存在本地插件目录，不会上传；新识别的文字会使用该字体
- 墨迹数据仅保存在你自己的笔记内
- "清理全库"命令会枚举库内 Markdown 文件，目的仅为查找历史版本遗留的空涂鸦属性
- 独立画板点击"保存 PNG"时会写入系统剪贴板

## 致谢

- 手写识别：[PP-OCRv5](https://github.com/PaddlePaddle/PaddleOCR)（Apache-2.0），模型资源来自 [ibus-qikai](https://github.com/kekxv/ibus-qikai)，推理使用 [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（MIT）
- 回退笔画匹配：[HanziLookupJS](https://github.com/gugray/HanziLookupJS)（GPL-3.0），笔画数据来自 [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) / Arphic PL

## 注意事项

- 锚定引用的是绘制时的文字块：若该段文字本身被删除或大幅改写，受影响笔画回退为绝对定位
- 源文本与渲染文本存在差异（如 Markdown 符号），跨视图匹配极少数情况会回退

## 开发

```bash
npm install
npm run dev     # watch 模式
npm run build   # 生产构建（含类型检查）
npx eslint main.ts
```

## 许可证

[MIT](LICENSE)
