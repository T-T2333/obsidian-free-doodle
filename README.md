# Free Doodle

一个 Obsidian 插件：在笔记上直接涂鸦、划线、圈注，墨迹作为独立图层叠加在文字上方，并随文字位置自动跟随。

![demo](https://img.shields.io/badge/Obsidian-插件-blue)

## 功能特性

- **笔记内涂鸦**：`Ctrl+D` 或点击左侧荧光笔图标，直接在正文上划线标注
- **文字锚点跟随**：每一笔自动锚定所在段落/行，增删属性、段落或调整窗口宽度导致文字移动时，墨迹跟着走
- **阅读模式支持**：阅读视图自动叠加显示墨迹，也可直接在阅读模式下涂鸦
- **完整工具**：调色板 + 自定义颜色、笔刷粗细（1–40）、橡皮擦、撤销（Ctrl+Z）、清空
- **干净存储**：墨迹数据以 base64 存入笔记的 `free-doodle` frontmatter 属性，不占正文；无墨迹时属性自动移除
- **独立画板**：附赠全屏涂鸦画板，可导出 PNG 并插入笔记（同时复制到剪贴板）
- **嵌入渲染**：笔记被嵌入引用或悬浮预览时，墨迹同样显示

## 安装

### 手动安装

1. 下载最新 Release 中的 `main.js`、`manifest.json`、`versions.json`
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
| 完成并保存 | 浮动工具栏“完成”按钮 / `Esc` |
| 撤销 | `Ctrl+Z` |
| 清空当前笔记墨迹 | 命令面板“清除当前笔记的涂鸦数据” |
| 批量清理空数据 | 命令面板“清理全库” |

## 注意事项

- 墨迹锚定文字块：若被圈注的文字本身被删除或大幅修改，该笔回退为绝对定位（停在原地）
- 编辑视图与阅读视图的渲染文本存在差异（如 Markdown 符号），极少数情况下跨模式匹配会回退

## 开发

```bash
npm install
npm run dev     # watch 模式
npm run build   # 生产构建（含类型检查）
```

## License

[MIT](LICENSE)
