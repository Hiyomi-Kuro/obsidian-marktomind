# MarkToMind

MarkToMind 是一个独立实现的 Obsidian 思维导图 / 大纲 / 表格插件。默认界面语言为简体中文，并以 Markmind 3.5.8 的公开、可观察交互行为作为兼容目标；实现不复制参考插件的打包源码、私有资源或授权逻辑。

## 已实现的兼容功能

- 支持公开 `mindmap-plugin: basic|markdown|rich` YAML 约定，以及思维导图、大纲、表格三种视图。
- 支持双向、向右、向左、向上、向下、树状、垂直、右鱼骨、左鱼骨布局；鱼骨采用上下交替肋骨结构。
- 节点新增、编辑、删除、折叠、键盘导航、撤销/重做、搜索、同级移动，以及拖拽到目标节点前/后/内部的精细落点。
- Rich 节点属性：填充/边框/文字颜色、边框宽度/样式、对齐、形状、标签、marker、笔记、链接、summary、boundary、callout。
- 关系线支持曲线、标签、线宽/线型、箭头元数据；boundary 与 summary 按可见子树范围绘制。
- Rich 模式支持双击空白处创建自由节点；触屏支持长按空白 2 秒创建自由节点和长按节点拖拽。
- 支持双指缩放、Ctrl/Cmd + 滚轮缩放、拖拽接近边缘自动滚动画布，以及移动端大触控目标。
- 主题系统包含默认、明亮、深色、卡片、手绘、黑色、白色、暖色、冷色、舒缓主题，并支持每文件主题。
- Markdown rendering inside nodes, Obsidian links, pasted images and PDF++ annotation-link paste workflow.
- OPML、HTML、SVG、PNG、XMind 导出；XMind Zen `content.json` 与旧版 `content.xml` 导入；支持多工作表、图片资源、notes、labels、markers、relationships、detached/free topics 等兼容信息。
- Markdown/table copy, presentation mode and embedded static mind-map rendering.
- Per-file recovery history.
- Basic↔rich compatibility conversion.
- Zoom/fit, expand-to-level commands, subtree copy/paste, insert-parent, delete-only/promote-children and sibling reordering.
- Configurable OpenAI-compatible/custom AI endpoint for outline generation and node translation.
- PDF companion annotation-note creation and opening of `annotate-target` links.

## Markmind 兼容快捷键

当焦点位于 MarkToMind 画布时，内置快捷键按 Markmind 3.5.8 的行为语义处理：

| 快捷键 | 操作 |
| --- | --- |
| `Tab` / `Insert` | 添加子节点 |
| `Enter` | 添加同级节点 |
| `Space` / 双击 | 编辑选中节点 |
| `Delete` / `Backspace` | 删除选中节点及后代 |
| 方向键 | 按画面方向选择最近节点 |
| `Ctrl/Cmd + Up/Down` | 在同级节点中移动 |
| `Ctrl/Cmd + C` | 复制节点文字 |
| `Ctrl/Cmd + V` | 将文本/大纲粘贴为子节点；PDF/Obsidian 链接追加到节点 |
| `Ctrl/Cmd + Z` | 撤销 |
| `Ctrl/Cmd + Y` | 重做 |
| `Ctrl/Cmd + /` | 折叠/展开节点 |
| `Ctrl/Cmd + F` | 节点搜索 |
| `Ctrl/Cmd + E` | 根节点居中 |
| `Ctrl/Cmd + R/L/U/D/M/J/K/Q/T` | 右 / 左 / 上 / 下 / 双向 / 树状 / 垂直 / 右鱼骨 / 左鱼骨 |

在 MarkToMind 设置中开启“使用自定义快捷键”后，会关闭内置的新增、编辑、删除、撤销、重做按键，可在 Obsidian“设置 → 快捷键”中自行绑定，对应 Markmind 的自定义快捷键工作流。

## 兼容说明

MarkToMind 识别公开的 `mindmap-plugin: basic|rich|markdown`、`display-mode`、`mindmap-layout`、`annotate-target` 等 frontmatter 约定。Rich 扩展数据独立存储在 MarkToMind 自身元数据中，从而不依赖其他插件的私有序列化格式。

旧版内嵌 PDF.js 标注引擎不会打包进本插件；在当前 Obsidian 中使用 PDF++ 或 Obsidian PDF 视图，将标注链接粘贴到节点即可。

兼容目标是公开可观察的功能、交互语义和文件互操作行为。参考插件的私有激活/授权机制、私有资源和不可公开验证的内部序列化实现不属于兼容范围。
