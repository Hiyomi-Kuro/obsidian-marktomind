"use strict";

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  Menu,
  Modal,
  TFile,
  TFolder,
  MarkdownRenderer,
  MarkdownView,
  requestUrl,
  normalizePath,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "marktomind-view";

const DEFAULT_SETTINGS = {
  defaultMode: "mindmap",
  defaultLayout: "mindmap",
  defaultTheme: "normal",
  uiLanguage: "zh-CN",
  useCustomShortcuts: false,
  historyLimit: 30,
  attachmentFolder: "MarkToMind Assets",
  handDrawn: false,
  allowFreeNodeGesture: true,
  mobileScaleSpeed: 0.12,
  canvasBackground: "transparent",
  autoEmbed: true,
  aiEndpoint: "https://api.openai.com/v1/chat/completions",
  aiModel: "gpt-4.1-mini",
  aiApiKey: "",
  annotationTemplate: "Page: {{page}}\n> {{text}}\n[Open PDF]({{link}})",
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const THEME_NAMES = ["normal", "light", "dark", "card", "handdrawn", "black", "white", "warm", "cold", "relax"];

const LAYOUT_ALIASES = {
  mindmap: "mindmap",
  bilateral: "mindmap",
  right: "right",
  left: "left",
  up: "up",
  down: "down",
  tree: "tree",
  ltree: "tree",
  vertical: "vertical",
  fishright: "fish-right",
  "fish-right": "fish-right",
  fishleft: "fish-left",
  "fish-left": "fish-left",
};

function canonicalLayout(value) {
  const raw = String(value || "mindmap").trim().toLowerCase();
  if (LAYOUT_ALIASES[raw]) return LAYOUT_ALIASES[raw];
  if (raw.includes("fish") && raw.includes("left")) return "fish-left";
  if (raw.includes("fish") && raw.includes("right")) return "fish-right";
  if (raw.includes("logic.left")) return "left";
  if (raw.includes("logic.right")) return "right";
  if (raw.includes("org.xmind.ui.tree") || raw.includes("tree")) return "tree";
  if (raw.includes("vertical")) return "vertical";
  if (raw.includes("up")) return "up";
  if (raw.includes("down")) return "down";
  if (raw.includes("map") || raw.includes("clockwise") || raw.includes("unbalanced")) return "mindmap";
  return "mindmap";
}

function markmindLayoutName(value) {
  const layout = canonicalLayout(value);
  if (layout === "fish-right") return "fishRight";
  if (layout === "fish-left") return "fishLeft";
  if (layout === "tree") return "lTree";
  return layout;
}

function xmindStructureClass(value) {
  const layout = canonicalLayout(value);
  if (layout === "right") return "org.xmind.ui.logic.right";
  if (layout === "left") return "org.xmind.ui.logic.left";
  if (layout === "tree") return "org.xmind.ui.tree.right";
  if (layout === "fish-right") return "org.xmind.ui.fishbone.rightHeaded";
  if (layout === "fish-left") return "org.xmind.ui.fishbone.leftHeaded";
  return "org.xmind.ui.map.clockwise";
}

function ui(plugin, zh, en = zh) {
  return plugin?.settings?.uiLanguage === "zh-CN" ? zh : en;
}

function makeId() {
  return `mtm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return escapeHtml(value);
}

function sanitizeFileName(value) {
  return String(value || "MindMap").replace(/[\\/:*?"<>|]/g, "-").trim() || "MindMap";
}

function splitFrontmatter(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: "", body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: "", body: normalized };
  return {
    frontmatter: normalized.slice(4, end),
    body: normalized.slice(end + 5),
  };
}

function readFrontmatterValue(frontmatter, key) {
  const rx = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*?)\\s*$`, "im");
  const match = String(frontmatter || "").match(rx);
  if (!match) return "";
  return match[1].replace(/^['"]|['"]$/g, "").trim();
}

function mergeFrontmatter(frontmatter, updates) {
  const lines = String(frontmatter || "").split("\n").filter((line, index, arr) => !(arr.length === 1 && line === ""));
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "i").test(line));
    const nextLine = `${key}: ${value}`;
    if (index >= 0) lines[index] = nextLine;
    else lines.push(nextLine);
  }
  return lines.join("\n").trim();
}

function nodeTextAndId(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^(.*?)(?:\s+\^(mtm-[A-Za-z0-9_-]+))\s*$/);
  if (match) return { text: match[1].trim(), id: match[2] };
  return { text, id: makeId() };
}

function parseMindmapMarkdown(markdown, fallbackTitle = "Main Topic") {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const entries = [];
  let currentHeadingLevel = 0;
  let inFence = false;
  let noteLines = [];

  const flushNote = () => {
    if (!entries.length || !noteLines.length) {
      noteLines = [];
      return;
    }
    while (noteLines.length && !noteLines[0].trim()) noteLines.shift();
    while (noteLines.length && !noteLines[noteLines.length - 1].trim()) noteLines.pop();
    if (noteLines.length) entries[entries.length - 1].note = noteLines.join("\n");
    noteLines = [];
  };

  for (const sourceLine of body.split("\n")) {
    const line = sourceLine.replace(/\t/g, "  ");
    if (/^\s*```/.test(line)) {
      if (entries.length) noteLines.push(sourceLine);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (entries.length) noteLines.push(sourceLine);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      flushNote();
      currentHeadingLevel = heading[1].length - 1;
      const parsed = nodeTextAndId(heading[2]);
      entries.push({ level: currentHeadingLevel, ...parsed });
      continue;
    }

    const list = line.match(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (list) {
      flushNote();
      const indentLevel = Math.floor(list[1].length / 2);
      const parsed = nodeTextAndId(list[2]);
      entries.push({ level: currentHeadingLevel + 1 + indentLevel, ...parsed });
      continue;
    }

    if (entries.length === 0) {
      if (!line.trim()) continue;
      const parsed = nodeTextAndId(line.trim());
      entries.push({ level: 0, ...parsed });
    } else {
      noteLines.push(sourceLine);
    }
  }
  flushNote();

  if (entries.length === 0) {
    entries.push({ level: 0, text: fallbackTitle || "Main Topic", id: makeId() });
  }

  const minLevel = Math.min(...entries.map((entry) => entry.level));
  for (const entry of entries) entry.level -= minLevel;

  const roots = [];
  const stack = [];
  for (const entry of entries) {
    const node = { id: entry.id, text: entry.text, children: [], collapsed: false };
    if (entry.note) node.note = entry.note;
    while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ level: entry.level, node });
  }

  const root = roots.length === 1
    ? roots[0]
    : { id: makeId(), text: fallbackTitle || "Main Topic", children: roots, collapsed: false, synthetic: true };

  return {
    root,
    frontmatter,
    declaredMode: readFrontmatterValue(frontmatter, "mindmap-plugin") || "basic",
    declaredDisplay: readFrontmatterValue(frontmatter, "display-mode") || "",
    declaredLayout: readFrontmatterValue(frontmatter, "mindmap-layout") || "mindmap",
    annotateTarget: readFrontmatterValue(frontmatter, "annotate-target") || "",
  };
}

function serializeTree(root, depth = 0) {
  if (!root) return "# Main Topic\n";
  const lines = [`# ${root.text || "Main Topic"} ^${root.id}`];
  if (root.note) lines.push(root.note);
  const walk = (node, level) => {
    lines.push(`${"  ".repeat(level)}- ${node.text || "Untitled"} ^${node.id}`);
    if (node.note) lines.push(node.note);
    for (const child of node.children || []) walk(child, level + 1);
  };
  for (const child of root.children || []) walk(child, depth);
  return `${lines.join("\n")}\n`;
}

function flattenTree(root) {
  const list = [];
  const walk = (node, depth, parent = null) => {
    list.push({ node, depth, parent });
    for (const child of node.children || []) walk(child, depth + 1, node);
  };
  if (root) walk(root, 0, null);
  return list;
}

function findNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findParent(root, id, parent = null) {
  if (!root) return null;
  if (root.id === id) return parent;
  for (const child of root.children || []) {
    const found = findParent(child, id, root);
    if (found) return found;
  }
  return null;
}

function treeContains(node, id) {
  return !!findNode(node, id);
}

function nodeDepth(root, id) {
  const hit = flattenTree(root).find(({ node }) => node.id === id);
  return hit?.depth || 0;
}

function visibleSubtreeIds(node) {
  const ids = [];
  const walk = (item) => {
    ids.push(item.id);
    if (!item.collapsed) for (const child of item.children || []) walk(child);
  };
  walk(node);
  return ids;
}

function regenerateIds(node) {
  const copy = deepClone(node);
  const walk = (item) => {
    item.id = makeId();
    item.collapsed = false;
    for (const child of item.children || []) walk(child);
  };
  walk(copy);
  return copy;
}

function plainTextToSubtrees(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const rows = source.split("\n").filter((line) => line.trim());
  if (!rows.length) return [];

  const parsed = rows.map((raw) => {
    const indentMatch = raw.match(/^[\t ]*/)?.[0] || "";
    const tabs = (indentMatch.match(/\t/g) || []).length;
    const spaces = indentMatch.replace(/\t/g, "").length;
    const indent = tabs + Math.floor(spaces / 2);
    const cleaned = raw.trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^#{1,6}\s+/, "")
      .trim();
    return { indent, text: cleaned };
  }).filter((row) => row.text);

  if (!parsed.length) return [];
  const baseIndent = Math.min(...parsed.map((row) => row.indent));
  const roots = [];
  const stack = [];
  for (const row of parsed) {
    const level = Math.max(0, row.indent - baseIndent);
    const node = { id: makeId(), text: row.text, children: [], collapsed: false };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ level, node });
  }
  return roots;
}

function removeNode(root, id) {
  if (!root) return null;
  const parent = findParent(root, id);
  if (!parent) return null;
  const index = parent.children.findIndex((child) => child.id === id);
  if (index < 0) return null;
  return parent.children.splice(index, 1)[0] || null;
}

function markdownFromTree(root) {
  const lines = [`# ${root.text || "Main Topic"}`];
  const walk = (node, depth) => {
    lines.push(`${"  ".repeat(depth)}- ${node.text || "Untitled"}`);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  for (const child of root.children || []) walk(child, 0);
  return `${lines.join("\n")}\n`;
}

function tableMarkdownFromTree(root) {
  const rows = flattenTree(root);
  const out = ["| Level | Node | Children |", "| ---: | --- | ---: |"]; 
  for (const { node, depth } of rows) {
    out.push(`| ${depth} | ${String(node.text || "").replaceAll("|", "\\|")} | ${(node.children || []).length} |`);
  }
  return `${out.join("\n")}\n`;
}

function opmlFromTree(root, title) {
  const nodeXml = (node) => {
    const children = (node.children || []).map(nodeXml).join("");
    return `<outline text="${escapeXml(node.text || "Untitled")}">${children}</outline>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${escapeXml(title)}</title></head><body>${nodeXml(root)}</body></opml>`;
}

function xmindTopic(node, meta = {}) {
  const style = meta.nodeStyles?.[node.id] || {};
  const topic = { id: node.id || makeId(), class: "topic", title: node.text || "Untitled" };
  if (node.children && node.children.length) topic.children = { attached: node.children.map((child) => xmindTopic(child, meta)) };
  const note = Object.prototype.hasOwnProperty.call(style, "note") ? style.note : node.note;
  if (note) topic.notes = { plain: { content: note } };
  if (Array.isArray(style.labels) && style.labels.length) topic.labels = style.labels.slice();
  if (Array.isArray(style.markers) && style.markers.length) topic.markers = style.markers.map((markerId) => ({ markerId }));
  if (style.link) topic.href = style.link;
  if (style.summary) topic.marktomindSummary = { title: style.summary, stroke: style.summaryStroke || "" };
  if (style.boundary) topic.marktomindBoundary = {
    title: style.boundaryLabel || "",
    fill: style.boundaryFill || "",
    stroke: style.boundaryStroke || style.stroke || "",
  };
  if (style.callout) topic.marktomindCallout = { text: style.callout, fill: style.calloutFill || "", stroke: style.calloutStroke || "" };
  if (style.shape) topic.marktomindShape = style.shape;
  if (style.icon) topic.marktomindIcon = style.icon;
  return topic;
}

function xmindFiles(root, title, meta = {}, layout = "mindmap", theme = "normal") {
  const relationships = (meta.relations || []).map((relation) => ({
    id: relation.id || makeId(),
    end1Id: relation.from,
    end2Id: relation.to,
    title: relation.label || "",
    marktomindStyle: {
      stroke: relation.stroke || "",
      strokeWidth: relation.strokeWidth || 2,
      strokeStyle: relation.strokeStyle || "dashed",
      startMarker: relation.startMarker || "none",
      endMarker: relation.endMarker || "arrow",
    },
  }));
  const structureClass = xmindStructureClass(layout);
  const rootTopic = xmindTopic(root, meta);
  rootTopic.structureClass = structureClass;
  rootTopic.titleUnedited = true;
  const sheetId = makeId();
  const sheet = {
    id: sheetId,
    class: "sheet",
    title,
    rootTopic,
    relationships,
    extensions: [{
      provider: "org.xmind.ui.skeleton.structure.style",
      content: { centralTopic: structureClass },
    }],
    marktomind: {
      layout: markmindLayoutName(layout),
      theme,
      freeNodes: meta.freeNodes || [],
    },
  };
  return {
    "content.json": JSON.stringify([sheet]),
    "metadata.json": JSON.stringify({
      dataStructureVersion: "2",
      layoutEngineVersion: "3",
      creator: { name: "MarkToMind", version: "0.2.0" },
      activeSheetId: sheetId,
    }),
    "manifest.json": JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } }),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return Uint8Array.of(value & 255, (value >>> 8) & 255);
}

function u32(value) {
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createStoreZip(entries) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = content instanceof Uint8Array ? content : encoder.encode(String(content));
    const crc = crc32(data);
    const localHeader = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    local.push(localHeader, data);

    const centralHeader = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]);
    central.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const localBytes = concatBytes(local);
  const centralBytes = concatBytes(central);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(Object.keys(entries).length),
    u16(Object.keys(entries).length), u32(centralBytes.length), u32(localBytes.length), u16(0),
  ]);
  return concatBytes([localBytes, centralBytes, end]);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      // Fall through to the desktop Node runtime when available.
    }
  }
  try {
    const zlib = require("zlib");
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
  } catch (error) {
    throw new Error(`Cannot decompress ZIP entry: ${error.message || error}`);
  }
}

async function readZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP/XMind file: end record not found.");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Invalid ZIP/XMind central directory.");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Invalid ZIP/XMind local entry.");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method}.`);
    entries[name] = data;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xmindTopicToTree(topic, imagePathByResource = {}, state = null) {
  const rich = state || { idMap: {}, nodeStyles: {}, freeNodes: [] };
  let text = String(topic?.title || "Untitled").trim() || "Untitled";
  const imageSource = topic?.image?.src || topic?.image?.source || "";
  const cleanImageSource = String(imageSource).replace(/^xap:/, "").replace(/^\//, "");
  if (cleanImageSource && imagePathByResource[cleanImageSource]) text += ` ![[${imagePathByResource[cleanImageSource]}]]`;
  const children = topic?.children?.attached || topic?.children?.topics || [];
  const id = makeId();
  if (topic?.id) rich.idMap[topic.id] = id;
  const style = {};
  const note = topic?.notes?.plain?.content || topic?.notes?.html?.content || topic?.note || "";
  if (note) style.note = String(note);
  const labels = Array.isArray(topic?.labels) ? topic.labels.map((label) => typeof label === "string" ? label : (label?.value || label?.text || "")).filter(Boolean) : [];
  if (labels.length) style.labels = labels;
  const markers = Array.isArray(topic?.markers) ? topic.markers.map((marker) => marker?.markerId || marker?.id || marker).filter(Boolean) : [];
  if (markers.length) style.markers = markers;
  const link = topic?.href || topic?.hyperlink || topic?.link || "";
  if (link) style.link = String(link);
  const boundary = topic?.marktomindBoundary || (Array.isArray(topic?.boundaries) ? topic.boundaries[0] : topic?.boundary);
  if (boundary) {
    style.boundary = true;
    style.boundaryLabel = boundary.title || boundary.name || "";
    style.boundaryFill = boundary.fill || boundary.fillColor || "";
    style.boundaryStroke = boundary.stroke || boundary.lineColor || "";
  }
  const summary = topic?.marktomindSummary || (Array.isArray(topic?.summaries) ? topic.summaries[0] : topic?.summary);
  if (summary) {
    style.summary = summary.title || summary.text || summary.label || "Summary";
    style.summaryStroke = summary.stroke || summary.lineColor || "";
  }
  const callout = topic?.marktomindCallout || topic?.callout;
  if (callout) {
    style.callout = callout.text || callout.title || String(callout);
    style.calloutFill = callout.fill || "";
    style.calloutStroke = callout.stroke || "";
  }
  if (topic?.marktomindShape || topic?.shape) style.shape = topic.marktomindShape || topic.shape;
  if (topic?.marktomindIcon) style.icon = topic.marktomindIcon;
  if (Object.keys(style).length) rich.nodeStyles[id] = style;
  return {
    id,
    text,
    children: Array.isArray(children) ? children.map((child) => xmindTopicToTree(child, imagePathByResource, rich)) : [],
    collapsed: false,
  };
}

function collectXmindSheetMetadata(sheet, rich) {
  for (const relation of sheet?.relationships || []) {
    const from = rich.idMap[relation.end1Id || relation.from || relation.sourceId];
    const to = rich.idMap[relation.end2Id || relation.to || relation.targetId];
    if (!from || !to) continue;
    rich.relations.push({
      id: relation.id || makeId(),
      from,
      to,
      label: relation.title || relation.label || "",
      stroke: relation.marktomindStyle?.stroke || relation.style?.lineColor || "",
      strokeWidth: relation.marktomindStyle?.strokeWidth || 2,
      strokeStyle: relation.marktomindStyle?.strokeStyle || "dashed",
      startMarker: relation.marktomindStyle?.startMarker || "none",
      endMarker: relation.marktomindStyle?.endMarker || "arrow",
    });
  }
  const detached = sheet?.rootTopic?.children?.detached || [];
  detached.forEach((topic, index) => {
    const tree = xmindTopicToTree(topic, rich.imageMap || {}, rich);
    rich.freeNodes.push({ id: tree.id, text: tree.text, tree, x: 120 + index * 180, y: 120 + (index % 3) * 110 });
  });
}

function legacyXmindSheets(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid legacy XMind content.xml.");
  const direct = (el, name) => [...(el?.children || [])].filter((child) => child.localName === name);
  const firstDirect = (el, name) => direct(el, name)[0] || null;
  const attr = (el, name) => el?.getAttribute(name) || el?.getAttribute(`xlink:${name}`) || "";
  const topicFromXml = (el) => {
    const title = firstDirect(el, "title")?.textContent?.trim() || "Untitled";
    const topic = { id: attr(el, "id") || makeId(), class: "topic", title };
    const notes = firstDirect(el, "notes");
    if (notes) {
      const plain = [...notes.getElementsByTagName("plain")][0] || [...notes.getElementsByTagNameNS("*", "plain")][0];
      if (plain?.textContent?.trim()) topic.notes = { plain: { content: plain.textContent.trim() } };
    }
    const labels = firstDirect(el, "labels");
    if (labels) topic.labels = [...labels.children].filter((child) => child.localName === "label").map((label) => label.textContent.trim()).filter(Boolean);
    const markerRefs = firstDirect(el, "marker-refs");
    if (markerRefs) topic.markers = [...markerRefs.children].filter((child) => child.localName === "marker-ref").map((marker) => ({ markerId: attr(marker, "marker-id") })).filter((marker) => marker.markerId);
    const href = attr(el, "href");
    if (href) topic.href = href;
    const img = [...el.children].find((child) => child.localName === "img") || null;
    if (img) topic.image = { src: attr(img, "src") };
    const childrenEl = firstDirect(el, "children");
    if (childrenEl) {
      const topicsContainers = direct(childrenEl, "topics");
      const attached = [];
      const detached = [];
      for (const container of topicsContainers) {
        const target = attr(container, "type") === "detached" ? detached : attached;
        for (const child of direct(container, "topic")) target.push(topicFromXml(child));
      }
      topic.children = {};
      if (attached.length) topic.children.attached = attached;
      if (detached.length) topic.children.detached = detached;
    }
    return topic;
  };
  const sheets = [...doc.getElementsByTagNameNS("*", "sheet")];
  return sheets.map((sheet, index) => {
    const title = firstDirect(sheet, "title")?.textContent?.trim() || `Sheet ${index + 1}`;
    const rootEl = firstDirect(sheet, "topic");
    const relationships = [];
    const rels = firstDirect(sheet, "relationships");
    if (rels) {
      for (const rel of [...rels.children].filter((child) => child.localName === "relationship")) {
        relationships.push({ id: attr(rel, "id") || makeId(), end1Id: attr(rel, "end1"), end2Id: attr(rel, "end2"), title: firstDirect(rel, "title")?.textContent?.trim() || "" });
      }
    }
    return { id: attr(sheet, "id") || makeId(), class: "sheet", title, rootTopic: rootEl ? topicFromXml(rootEl) : null, relationships };
  });
}

function buildSvg(root, title = "MindMap") {
  const nodes = [];
  const edges = [];
  let leaf = 0;

  const measure = (node, depth, parentId = null) => {
    let y;
    if (!node.children || node.children.length === 0 || node.collapsed) {
      y = leaf * 82 + 55;
      leaf += 1;
    } else {
      const childYs = node.children.map((child) => measure(child, depth + 1, node.id));
      y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    }
    nodes.push({ node, x: depth * 260 + 40, y, parentId });
    if (parentId) edges.push({ from: parentId, to: node.id });
    return y;
  };
  measure(root, 0, null);
  const byId = new Map(nodes.map((item) => [item.node.id, item]));
  const width = Math.max(780, ...nodes.map((item) => item.x + 240));
  const height = Math.max(320, leaf * 82 + 70);
  const edgeSvg = edges.map((edge) => {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    return `<path d="M ${a.x + 190} ${a.y} C ${a.x + 220} ${a.y}, ${b.x - 30} ${b.y}, ${b.x} ${b.y}" fill="none" stroke="#8b8b8b" stroke-width="2"/>`;
  }).join("");
  const nodeSvg = nodes.map(({ node, x, y }) => {
    const text = escapeXml((node.text || "Untitled").replace(/\[\[|\]\]|[*_`]/g, ""));
    const fill = node === root ? "#5b6cff" : "#ffffff";
    const color = node === root ? "#ffffff" : "#222222";
    return `<g><rect x="${x}" y="${y - 22}" rx="9" ry="9" width="190" height="44" fill="${fill}" stroke="#9a9a9a"/><text x="${x + 12}" y="${y + 5}" font-family="Arial, sans-serif" font-size="14" fill="${color}">${text.slice(0, 80)}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fdfdfd"/><text x="40" y="28" font-family="Arial, sans-serif" font-size="16" fill="#666">${escapeXml(title)}</text>${edgeSvg}${nodeSvg}</svg>`;
}

class PromptModal extends Modal {
  constructor(app, { title, value = "", placeholder = "", multiline = false, submitText = "OK", cancelText = "Cancel" }) {
    super(app);
    this.titleText = title;
    this.value = value;
    this.placeholder = placeholder;
    this.multiline = multiline;
    this.submitText = submitText;
    this.cancelText = cancelText;
    this.resolve = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.titleText });
    const input = this.multiline
      ? contentEl.createEl("textarea", { cls: "mtm-prompt-input" })
      : contentEl.createEl("input", { cls: "mtm-prompt-input", type: "text" });
    input.value = this.value;
    input.placeholder = this.placeholder;
    if (this.multiline) {
      input.rows = 8;
      input.style.width = "100%";
    } else {
      input.style.width = "100%";
    }
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = row.createEl("button", { text: this.cancelText });
    const submit = row.createEl("button", { text: this.submitText, cls: "mod-cta" });
    const finish = (value) => {
      const resolver = this.resolve;
      this.resolve = null;
      this.close();
      if (resolver) resolver(value);
    };
    cancel.onclick = () => finish(null);
    submit.onclick = () => finish(input.value);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!this.multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(input.value);
      }
    });
    setTimeout(() => input.focus(), 20);
  }

  onClose() {
    if (this.resolve) {
      const resolver = this.resolve;
      this.resolve = null;
      resolver(null);
    }
    this.contentEl.empty();
  }

  wait() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}

class HistoryModal extends Modal {
  constructor(app, plugin, file, entries) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.entries = entries;
  }

  onOpen() {
    const T = (zh, en) => ui(this.plugin, zh, en);
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: `${T("MarkToMind 恢复历史", "MarkToMind recovery")} — ${this.file.basename}` });
    if (!this.entries.length) {
      this.contentEl.createEl("p", { text: T("还没有恢复快照。", "No recovery snapshots have been recorded yet.") });
      return;
    }
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const item = this.entries[index];
      const row = this.contentEl.createDiv({ cls: "setting-item" });
      const info = row.createDiv({ cls: "setting-item-info" });
      info.createDiv({ cls: "setting-item-name", text: new Date(item.time).toLocaleString() });
      info.createDiv({ cls: "setting-item-description", text: `${item.content.length.toLocaleString()} ${T("个字符", "characters")}` });
      const control = row.createDiv({ cls: "setting-item-control" });
      const button = control.createEl("button", { text: T("恢复", "Restore") });
      button.onclick = async () => {
        await this.plugin.restoreHistory(this.file, index);
        this.close();
      };
    }
  }
}

class NodeStyleModal extends Modal {
  constructor(app, view, node) {
    super(app);
    this.view = view;
    this.node = node;
    this.meta = view.plugin.fileMeta(view.file.path);
    this.style = deepClone(this.meta.nodeStyles?.[node.id] || {});
    if (!Object.prototype.hasOwnProperty.call(this.style, "note") && node.note) this.style.note = node.note;
  }

  onOpen() {
    const { contentEl } = this;
    const T = (zh, en) => ui(this.view.plugin, zh, en);
    contentEl.empty();
    contentEl.addClass("mtm-node-style-modal");
    contentEl.createEl("h3", { text: `${T("节点属性", "Node properties")} — ${this.node.text.slice(0, 60)}` });

    const noteSection = contentEl.createDiv({ cls: "mtm-node-note-section" });
    noteSection.createEl("h4", { cls: "mtm-node-note-title", text: T("节点笔记", "Node note") });
    const notePreview = noteSection.createDiv({ cls: "mtm-node-note-preview markdown-rendered" });
    const noteEditorLabel = noteSection.createDiv({ cls: "mtm-node-note-editor-label", text: T("编辑 Markdown 原文", "Edit Markdown source") });
    const noteEditor = noteSection.createEl("textarea", { cls: "mtm-node-note-editor" });
    noteEditor.value = this.style.note || "";
    noteEditor.placeholder = T("在这里输入节点笔记，支持 Markdown。", "Write the node note here. Markdown is supported.");

    const resizeNoteEditor = () => {
      noteEditor.style.height = "auto";
      noteEditor.style.height = `${noteEditor.scrollHeight}px`;
    };
    const renderNotePreview = async () => {
      notePreview.empty();
      const value = this.style.note || "";
      if (!value.trim()) {
        notePreview.createDiv({ cls: "mtm-node-note-empty", text: T("暂无笔记", "No note") });
        return;
      }
      try {
        await MarkdownRenderer.render(this.app, value, notePreview, this.view.file?.path || "", this);
      } catch (_) {
        notePreview.setText(value);
      }
    };
    noteEditor.addEventListener("input", () => {
      this.style.note = noteEditor.value;
      resizeNoteEditor();
      void renderNotePreview();
    });
    resizeNoteEditor();
    void renderNotePreview();

    const colorSetting = (name, key, fallback) => {
      new Setting(contentEl).setName(name).addColorPicker((picker) => picker
        .setValue(this.style[key] || fallback)
        .onChange((value) => { this.style[key] = value; }));
    };
    colorSetting(T("填充颜色", "Fill color"), "fill", "#ffffff");
    colorSetting(T("边框颜色", "Stroke color"), "stroke", "#6c7cff");
    colorSetting(T("文字颜色", "Text color"), "text", "#202020");

    new Setting(contentEl).setName(T("节点形状", "Node shape")).addDropdown((dropdown) => dropdown
      .addOption("round", T("圆角矩形", "Rounded rectangle"))
      .addOption("rect", T("矩形", "Rectangle"))
      .addOption("pill", T("胶囊", "Pill"))
      .addOption("underline", T("下划线", "Underline"))
      .addOption("diamond", T("菱形", "Diamond"))
      .setValue(this.style.shape || "round")
      .onChange((value) => { this.style.shape = value; }));

    new Setting(contentEl).setName(T("子树布局", "Subtree layout")).setDesc(T("与 Markmind 一致，可为当前节点单独指定后代布局。", "Assign a layout to this node's descendants, matching Markmind's per-node layout behavior.")).addDropdown((dropdown) => dropdown
      .addOption("", T("继承当前方向", "Inherit"))
      .addOption("mindmap", T("双向导图", "Mind map"))
      .addOption("right", T("向右", "Right"))
      .addOption("left", T("向左", "Left"))
      .addOption("up", T("向上", "Up"))
      .addOption("down", T("向下", "Down"))
      .addOption("tree", T("树状", "Tree"))
      .addOption("vertical", T("垂直", "Vertical"))
      .addOption("fish-right", T("右鱼骨", "Fish right"))
      .addOption("fish-left", T("左鱼骨", "Fish left"))
      .setValue(this.style.layout || "")
      .onChange((value) => { this.style.layout = value; }));

    new Setting(contentEl).setName(T("文字对齐", "Text align")).addDropdown((dropdown) => dropdown
      .addOption("left", T("左对齐", "Left"))
      .addOption("center", T("居中", "Center"))
      .addOption("right", T("右对齐", "Right"))
      .setValue(this.style.align || "left")
      .onChange((value) => { this.style.align = value; }));

    new Setting(contentEl).setName(T("边框宽度", "Stroke width")).addSlider((slider) => slider
      .setLimits(1, 6, 1)
      .setValue(Number(this.style.strokeWidth) || 1)
      .setDynamicTooltip()
      .onChange((value) => { this.style.strokeWidth = value; }));

    new Setting(contentEl).setName(T("边框样式", "Stroke style")).addDropdown((dropdown) => dropdown
      .addOption("solid", T("实线", "Solid"))
      .addOption("dashed", T("虚线", "Dashed"))
      .addOption("dotted", T("点线", "Dotted"))
      .setValue(this.style.strokeStyle || "solid")
      .onChange((value) => { this.style.strokeStyle = value; }));

    new Setting(contentEl).setName(T("边界 Boundary", "Boundary")).setDesc(T("用边界包围该节点及其可见子树。", "Draw a boundary around this node and its visible subtree.")).addToggle((toggle) => toggle
      .setValue(!!this.style.boundary)
      .onChange((value) => { this.style.boundary = value; }));

    new Setting(contentEl).setName(T("边界标题", "Boundary label")).addText((text) => text
      .setValue(this.style.boundaryLabel || "")
      .onChange((value) => { this.style.boundaryLabel = value; }));
    colorSetting(T("边界填充", "Boundary fill"), "boundaryFill", "#f6f7fb");
    colorSetting(T("边界线颜色", "Boundary stroke"), "boundaryStroke", "#7c8cff");

    new Setting(contentEl).setName(T("概要 Summary", "Summary label")).setDesc(T("在该节点可见子树旁显示概要括号和文字。", "Show a summary bracket and label beside the visible subtree.")).addText((text) => text
      .setValue(this.style.summary || "")
      .onChange((value) => { this.style.summary = value; }));
    colorSetting(T("概要线颜色", "Summary stroke"), "summaryStroke", "#7c8cff");

    new Setting(contentEl).setName(T("标注 Callout", "Callout")).setDesc(T("显示连接到节点的浮动标注。", "Show a connected floating callout.")).addTextArea((text) => text
      .setValue(this.style.callout || "")
      .onChange((value) => { this.style.callout = value; }));
    colorSetting(T("标注填充", "Callout fill"), "calloutFill", "#fff7d6");
    colorSetting(T("标注边框", "Callout stroke"), "calloutStroke", "#d8a900");

    new Setting(contentEl).setName(T("标签", "Labels")).setDesc(T("多个标签用逗号分隔。", "Separate multiple labels with commas.")).addText((text) => text
      .setValue((this.style.labels || []).join(", "))
      .onChange((value) => { this.style.labels = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean); }));
    new Setting(contentEl).setName(T("标记 Marker", "Markers")).setDesc(T("兼容 XMind marker-id，多个用逗号分隔。", "XMind marker ids, separated by commas.")).addText((text) => text
      .setValue((this.style.markers || []).join(", "))
      .onChange((value) => { this.style.markers = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean); }));
    new Setting(contentEl).setName(T("节点链接", "Node link")).addText((text) => text
      .setValue(this.style.link || "")
      .onChange((value) => { this.style.link = value.trim(); }));
    new Setting(contentEl).setName(T("节点图标 / Emoji", "Node icon / Emoji")).addText((text) => text
      .setValue(this.style.icon || "")
      .onChange((value) => { this.style.icon = value.trim(); }));

    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const reset = row.createEl("button", { text: T("重置", "Reset") });
    const save = row.createEl("button", { text: T("保存", "Save"), cls: "mod-cta" });
    reset.onclick = async () => {
      this.view.pushUndo();
      if (this.meta.nodeStyles) delete this.meta.nodeStyles[this.node.id];
      await this.view.plugin.savePluginData();
      this.view.render();
      this.close();
    };
    save.onclick = async () => {
      this.view.pushUndo();
      this.meta.nodeStyles = this.meta.nodeStyles || {};
      this.meta.nodeStyles[this.node.id] = this.style;
      await this.view.plugin.savePluginData();
      this.view.render();
      this.close();
    };
  }
}

class RelationStyleModal extends Modal {
  constructor(app, view, relation) {
    super(app);
    this.view = view;
    this.relation = relation;
    this.draft = deepClone(relation);
  }

  onOpen() {
    const { contentEl } = this;
    const T = (zh, en) => ui(this.view.plugin, zh, en);
    contentEl.empty();
    contentEl.createEl("h3", { text: T("关系线属性", "Relationship properties") });
    new Setting(contentEl).setName(T("关系文字", "Label")).addText((text) => text.setValue(this.draft.label || "").onChange((value) => { this.draft.label = value; }));
    new Setting(contentEl).setName(T("线条颜色", "Stroke color")).addColorPicker((picker) => picker.setValue(this.draft.stroke || "#7c8cff").onChange((value) => { this.draft.stroke = value; }));
    new Setting(contentEl).setName(T("线宽", "Stroke width")).addSlider((slider) => slider.setLimits(1, 6, 1).setValue(Number(this.draft.strokeWidth) || 2).setDynamicTooltip().onChange((value) => { this.draft.strokeWidth = value; }));
    new Setting(contentEl).setName(T("线型", "Stroke style")).addDropdown((dropdown) => dropdown
      .addOption("solid", T("实线", "Solid"))
      .addOption("dashed", T("虚线", "Dashed"))
      .addOption("dotted", T("点线", "Dotted"))
      .setValue(this.draft.strokeStyle || "dashed")
      .onChange((value) => { this.draft.strokeStyle = value; }));
    new Setting(contentEl).setName(T("终点标记", "End marker")).addDropdown((dropdown) => dropdown
      .addOption("arrow", T("箭头", "Arrow"))
      .addOption("none", T("无", "None"))
      .setValue(this.draft.endMarker || "arrow")
      .onChange((value) => { this.draft.endMarker = value; }));
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const remove = buttons.createEl("button", { text: T("删除关系线", "Delete relationship") });
    const save = buttons.createEl("button", { text: T("保存", "Save"), cls: "mod-cta" });
    remove.onclick = async () => {
      this.view.pushUndo();
      const meta = this.view.plugin.fileMeta(this.view.file.path);
      meta.relations = (meta.relations || []).filter((item) => item !== this.relation && item.id !== this.relation.id);
      await this.view.plugin.savePluginData();
      this.view.render();
      this.close();
    };
    save.onclick = async () => {
      this.view.pushUndo();
      Object.assign(this.relation, this.draft);
      await this.view.plugin.savePluginData();
      this.view.render();
      this.close();
    };
  }
}

class MarkToMindView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.tree = null;
    this.frontmatter = "";
    this.mode = plugin.settings.defaultMode;
    this.layout = plugin.settings.defaultLayout;
    this.annotateTarget = "";
    this.selectedNodeId = null;
    this.searchTerm = "";
    this.zoom = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.toolbarEl = null;
    this.canvasWrapEl = null;
    this.canvasEl = null;
    this.statusEl = null;
    this.searchEl = null;
    this.searchVisible = false;
    this.presentationEl = null;
    this.pointerMap = new Map();
    this.pinchStart = null;
    this.touchNodeDrag = null;
    this.blankLongPressTimer = null;
    this.draggedNodeId = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file ? `MarkToMind: ${this.file.basename}` : "MarkToMind";
  }

  getIcon() {
    return "git-fork";
  }

  getState() {
    return {
      file: this.file ? this.file.path : "",
      mode: this.mode,
      layout: this.layout,
    };
  }

  async setState(state) {
    if (state?.file) {
      const abstract = this.app.vault.getAbstractFileByPath(state.file);
      this.file = abstract instanceof TFile ? abstract : null;
    }
    if (state?.mode) this.mode = state.mode;
    if (state?.layout) this.layout = state.layout;
    await this.loadFile();
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("marktomind-view");
    this.contentEl.tabIndex = 0;
    this.buildToolbar();
    this.canvasWrapEl = this.contentEl.createDiv({ cls: "mtm-canvas-wrap" });
    this.canvasEl = this.canvasWrapEl.createDiv({ cls: "mtm-canvas" });
    this.canvasWrapEl.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.files?.length || this.draggedNodeId) event.preventDefault();
      this.autoScrollDuringDrag(event.clientX, event.clientY);
    });
    this.canvasWrapEl.addEventListener("drop", (event) => this.handleExternalDrop(event));
    this.canvasWrapEl.addEventListener("dblclick", (event) => this.handleBlankDoubleClick(event));
    this.canvasWrapEl.addEventListener("pointerdown", (event) => this.handleCanvasPointerDown(event));
    this.canvasWrapEl.addEventListener("pointermove", (event) => this.handleCanvasPointerMove(event));
    this.canvasWrapEl.addEventListener("pointerup", (event) => this.handleCanvasPointerUp(event));
    this.canvasWrapEl.addEventListener("pointercancel", (event) => this.handleCanvasPointerUp(event));
    this.canvasWrapEl.addEventListener("wheel", (event) => this.handleCanvasWheel(event), { passive: false });
    this.contentEl.addEventListener("keydown", (event) => this.handleKeyDown(event));
    this.contentEl.addEventListener("paste", (event) => this.handlePaste(event));
    if (this.file) await this.loadFile();
  }

  async onClose() {
    this.closePresentation();
  }

  buildToolbar() {
    const T = (zh, en) => ui(this.plugin, zh, en);
    this.toolbarEl = this.contentEl.createDiv({ cls: "mtm-toolbar" });

    const button = (icon, title, handler) => {
      const el = this.toolbarEl.createEl("button", { attr: { "aria-label": title, title } });
      setIcon(el, icon);
      el.onclick = (event) => handler(event);
      return el;
    };

    button("plus-circle", T("添加子节点", "Add child node"), () => this.addChild());
    button("corner-down-right", T("添加同级节点", "Add sibling node"), () => this.addSibling());
    button("pencil", T("编辑节点", "Edit selected node"), () => this.editSelected());
    button("trash-2", T("删除节点", "Delete selected node"), () => this.deleteSelected());
    button("undo-2", T("撤销", "Undo"), () => this.undo());
    button("redo-2", T("重做", "Redo"), () => this.redo());
    button("zoom-out", T("缩小", "Zoom out"), () => this.setZoom(this.zoom - 0.1));
    button("zoom-in", T("放大", "Zoom in"), () => this.setZoom(this.zoom + 0.1));
    button("maximize", T("适应窗口", "Fit to view"), () => this.fitToView());

    const mode = this.toolbarEl.createEl("select", { attr: { "aria-label": T("视图模式", "View mode"), title: T("视图模式", "View mode") } });
    [["mindmap", T("思维导图", "Mind map")], ["outline", T("大纲", "Outline")], ["table", T("表格", "Table")]].forEach(([value, text]) => mode.createEl("option", { text, value }));
    mode.value = this.mode;
    mode.onchange = () => {
      this.mode = mode.value;
      this.render();
    };
    this.modeSelectEl = mode;

    const layout = this.toolbarEl.createEl("select", { attr: { "aria-label": T("布局", "Layout"), title: T("布局", "Layout") } });
    [
      ["mindmap", T("双向导图", "Bilateral")], ["right", T("向右", "Right")], ["left", T("向左", "Left")],
      ["up", T("向上", "Up")], ["down", T("向下", "Down")], ["tree", T("树状", "Tree")],
      ["vertical", T("垂直", "Vertical")], ["fish-right", T("右鱼骨", "Fish right")], ["fish-left", T("左鱼骨", "Fish left")],
    ].forEach(([value, text]) => layout.createEl("option", { text, value }));
    layout.value = this.layout;
    layout.onchange = async () => this.applySelectedLayout(layout.value);
    this.layoutSelectEl = layout;

    const theme = this.toolbarEl.createEl("select", { attr: { "aria-label": T("主题", "Theme"), title: T("主题", "Theme") } });
    const themeLabels = {
      normal: T("默认", "Normal"), light: T("明亮", "Light"), dark: T("深色", "Dark"), card: T("卡片", "Card"),
      handdrawn: T("手绘", "Hand drawn"), black: T("黑色", "Black"), white: T("白色", "White"), warm: T("暖色", "Warm"),
      cold: T("冷色", "Cold"), relax: T("舒缓", "Relax"),
    };
    for (const item of THEME_NAMES) theme.createEl("option", { text: themeLabels[item] || item, value: item });
    theme.value = this.plugin.settings.defaultTheme;
    theme.onchange = async () => {
      if (!this.file) return;
      const meta = this.plugin.fileMeta(this.file.path);
      meta.theme = theme.value;
      await this.plugin.savePluginData();
      this.render();
    };
    this.themeSelectEl = theme;

    button("network", T("创建关系线", "Create relation from selected node"), () => this.createRelation());
    button("move", T("创建自由节点", "Create free node"), () => this.createFreeNode());
    button("presentation", T("演示模式", "Presentation mode"), () => this.openPresentation());
    button("download", T("导出", "Export menu"), (event) => this.showExportMenu(event));
    button("history", T("恢复历史", "Recovery history"), () => this.plugin.showHistory(this.file));
    button("search", T("搜索节点 (Ctrl/Cmd+F)", "Toggle search box (Ctrl/Cmd+F)"), () => this.toggleSearchBox());

    this.searchEl = this.toolbarEl.createEl("input", {
      type: "search",
      placeholder: T("搜索节点…", "Search nodes…"),
      attr: { "aria-label": T("搜索节点", "Search nodes") },
    });
    this.searchEl.oninput = () => {
      this.searchTerm = this.searchEl.value.trim().toLowerCase();
      this.render();
    };
    this.searchEl.style.display = this.searchVisible ? "" : "none";

    this.statusEl = this.toolbarEl.createDiv({ cls: "mtm-status" });
  }

  async loadFile() {
    if (!this.canvasEl || !this.file) {
      if (this.canvasEl) {
        this.canvasEl.empty();
        this.canvasEl.createDiv({ cls: "mtm-empty", text: ui(this.plugin, "请用 MarkToMind 打开一个 Markdown 文件。", "Open a Markdown file with MarkToMind.") });
      }
      return;
    }
    const content = await this.app.vault.read(this.file);
    const parsed = parseMindmapMarkdown(content, this.file.basename);
    this.tree = parsed.root;
    this.frontmatter = parsed.frontmatter;
    this.annotateTarget = parsed.annotateTarget;
    const meta = this.plugin.fileMeta(this.file.path);
    this.layout = canonicalLayout(meta.layout || parsed.declaredLayout || this.layout || this.plugin.settings.defaultLayout);
    if (!meta.layout && parsed.declaredLayout) meta.layout = parsed.declaredLayout;
    for (const { node } of flattenTree(this.tree)) {
      if (meta.collapsed?.[node.id]) node.collapsed = true;
    }
    if (!this.selectedNodeId || !findNode(this.tree, this.selectedNodeId)) this.selectedNodeId = this.tree.id;
    if (this.modeSelectEl) this.modeSelectEl.value = this.mode;
    if (this.layoutSelectEl) this.layoutSelectEl.value = this.layout;
    if (this.themeSelectEl) this.themeSelectEl.value = meta.theme || this.plugin.settings.defaultTheme;
    this.render();
  }

  render() {
    if (!this.canvasEl) return;
    this.canvasEl.empty();
    this.applyZoom();
    const meta = this.plugin.fileMeta(this.file?.path || "");
    const theme = meta.theme || this.plugin.settings.defaultTheme || "normal";
    if (this.canvasWrapEl) {
      for (const name of THEME_NAMES) this.canvasWrapEl.removeClass(`mtm-theme-${name}`);
      this.canvasWrapEl.addClass(`mtm-theme-${theme}`);
      this.canvasWrapEl.toggleClass("mtm-handdrawn", !!this.plugin.settings.handDrawn || theme === "handdrawn");
      this.canvasWrapEl.style.background = meta.background || this.plugin.settings.canvasBackground || "transparent";
    }

    if (!this.tree) {
      this.canvasEl.createDiv({ cls: "mtm-empty", text: ui(this.plugin, "没有可用的思维导图数据。", "No mind-map data.") });
      return;
    }

    if (this.mode === "outline") this.renderOutline();
    else if (this.mode === "table") this.renderTable();
    else this.renderMindmap();

    this.renderFreeNodes();
    requestAnimationFrame(() => this.drawConnections());
    this.syncLayoutSelector();
    const count = flattenTree(this.tree).length;
    const hits = this.searchTerm ? flattenTree(this.tree).filter(({ node }) => node.text.toLowerCase().includes(this.searchTerm)).length : 0;
    if (this.statusEl) this.statusEl.setText(this.searchTerm ? `${hits}/${count} ${ui(this.plugin, "个节点", "nodes")}` : `${count} ${ui(this.plugin, "个节点", "nodes")}`);
  }

  renderMindmap() {
    if (["fish-right", "fish-left"].includes(this.layout)) {
      this.renderFishbone(this.layout === "fish-left" ? "left" : "right");
      return;
    }
    if (["up", "down", "tree", "vertical"].includes(this.layout)) {
      const list = this.canvasEl.createEl("ul", { cls: `mtm-tree-list mtm-layout-${this.layout}` });
      this.renderTreeListNode(this.tree, list, true);
      return;
    }

    const board = this.canvasEl.createDiv({ cls: "mtm-mindmap" });
    const left = board.createDiv({ cls: "mtm-mindmap-side left" });
    const center = board.createDiv({ cls: "mtm-mindmap-center" });
    const right = board.createDiv({ cls: "mtm-mindmap-side right" });
    center.appendChild(this.createNodeEl(this.tree, true));

    const children = this.tree.collapsed ? [] : (this.tree.children || []);
    let leftChildren = [];
    let rightChildren = [];
    if (this.layout === "left") leftChildren = children;
    else if (this.layout === "right") rightChildren = children;
    else {
      children.forEach((child, index) => (index % 2 === 0 ? rightChildren : leftChildren).push(child));
    }
    for (const child of leftChildren) left.appendChild(this.renderBranch(child, "left"));
    for (const child of rightChildren) right.appendChild(this.renderBranch(child, "right"));
  }

  renderFishbone(direction = "right") {
    const bone = this.canvasEl.createDiv({ cls: `mtm-fishbone is-${direction}` });
    const rootSlot = bone.createDiv({ cls: "mtm-fish-root" });
    rootSlot.appendChild(this.createNodeEl(this.tree, true));
    const spine = bone.createDiv({ cls: "mtm-fish-spine" });
    const children = this.tree.collapsed ? [] : (this.tree.children || []);
    children.forEach((child, index) => {
      const rib = spine.createDiv({ cls: `mtm-fish-rib ${index % 2 === 0 ? "is-top" : "is-bottom"}` });
      const branch = rib.createDiv({ cls: "mtm-fish-branch" });
      branch.appendChild(this.createNodeEl(child, false));
      if (!child.collapsed && child.children?.length) {
        const descendants = branch.createEl("ul", { cls: "mtm-fish-descendants mtm-tree-list" });
        for (const grandchild of child.children) this.renderTreeListNode(grandchild, descendants, false);
      }
    });
  }

  renderBranch(node, side, inheritedLayout = null) {
    const branch = document.createElement("div");
    const nodeLayout = canonicalLayout(this.plugin.fileMeta(this.file?.path || "").nodeStyles?.[node.id]?.layout || inheritedLayout || side);
    branch.className = `mtm-branch ${side} mtm-subtree-layout-${nodeLayout}`;
    const nodeEl = this.createNodeEl(node, false);
    branch.appendChild(nodeEl);
    if (!node.collapsed && node.children?.length) {
      const children = document.createElement("div");
      children.className = `mtm-branch-children mtm-children-layout-${nodeLayout}`;
      if (nodeLayout === "mindmap") {
        const left = document.createElement("div");
        const right = document.createElement("div");
        left.className = "mtm-local-mindmap-side left";
        right.className = "mtm-local-mindmap-side right";
        node.children.forEach((child, index) => {
          const localSide = index % 2 ? "left" : "right";
          (index % 2 ? left : right).appendChild(this.renderBranch(child, localSide, localSide));
        });
        children.append(left, right);
      } else {
        const childSide = nodeLayout === "left" || nodeLayout === "fish-left" ? "left" : nodeLayout === "right" || nodeLayout === "fish-right" ? "right" : side;
        for (const child of node.children) children.appendChild(this.renderBranch(child, childSide, nodeLayout));
      }
      branch.appendChild(children);
    }
    return branch;
  }

  renderTreeListNode(node, list, isRoot = false) {
    const li = list.createEl("li");
    li.appendChild(this.createNodeEl(node, isRoot));
    if (!node.collapsed && node.children?.length) {
      const explicitLayout = this.plugin.fileMeta(this.file?.path || "").nodeStyles?.[node.id]?.layout;
      if (explicitLayout && !["tree", "vertical"].includes(canonicalLayout(explicitLayout))) {
        const localLayout = canonicalLayout(explicitLayout);
        const host = li.createDiv({ cls: `mtm-tree-local-subtree mtm-children-layout-${localLayout}` });
        if (localLayout === "mindmap") {
          const left = host.createDiv({ cls: "mtm-local-mindmap-side left" });
          const right = host.createDiv({ cls: "mtm-local-mindmap-side right" });
          node.children.forEach((child, index) => {
            const side = index % 2 ? "left" : "right";
            (index % 2 ? left : right).appendChild(this.renderBranch(child, side, side));
          });
        } else {
          const side = localLayout === "left" || localLayout === "fish-left" ? "left" : "right";
          for (const child of node.children) host.appendChild(this.renderBranch(child, side, localLayout));
        }
      } else {
        const ul = li.createEl("ul");
        for (const child of node.children) this.renderTreeListNode(child, ul, false);
      }
    }
  }

  renderOutline() {
    const root = this.canvasEl.createDiv({ cls: "mtm-outline" });
    const draw = (node, depth) => {
      const row = root.createDiv({ cls: "mtm-outline-row" });
      row.style.paddingLeft = `${depth * 24}px`;
      row.appendChild(this.createNodeEl(node, depth === 0));
      if (!node.collapsed) for (const child of node.children || []) draw(child, depth + 1);
    };
    draw(this.tree, 0);
  }

  renderTable() {
    const table = this.canvasEl.createEl("table", { cls: "mtm-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const title of [ui(this.plugin, "层级", "Level"), ui(this.plugin, "节点", "Node"), ui(this.plugin, "子节点数", "Children"), ui(this.plugin, "块链接", "Block link")]) head.createEl("th", { text: title });
    const body = table.createEl("tbody");
    for (const { node, depth } of flattenTree(this.tree)) {
      const row = body.createEl("tr");
      row.createEl("td", { text: String(depth) });
      const nodeCell = row.createEl("td");
      nodeCell.appendChild(this.createNodeEl(node, depth === 0));
      row.createEl("td", { text: String((node.children || []).length) });
      const link = `[[${this.file?.path || ""}#^${node.id}]]`;
      const linkCell = row.createEl("td");
      const code = linkCell.createEl("code", { text: link });
      code.onclick = async () => navigator.clipboard?.writeText(link);
    }
  }

  createNodeEl(node, isRoot = false) {
    const el = document.createElement("div");
    el.className = `mtm-node${isRoot ? " is-root" : ""}`;
    el.dataset.nodeId = node.id;
    const depth = nodeDepth(this.tree, node.id);
    el.dataset.depth = String(depth);
    el.classList.add(`mtm-level-${Math.min(depth, 6)}`);
    el.draggable = !isRoot;
    if (node.id === this.selectedNodeId) el.classList.add("is-selected");
    if (this.searchTerm && node.text.toLowerCase().includes(this.searchTerm)) el.classList.add("is-search-hit");

    const style = this.plugin.fileMeta(this.file?.path || "").nodeStyles?.[node.id];
    if (style) {
      if (style.color && !style.stroke) style.stroke = style.color;
      if (style.stroke) el.style.borderColor = style.stroke;
      if (style.fill) el.style.backgroundColor = style.fill;
      if (style.text) el.style.color = style.text;
      if (style.align) el.style.textAlign = style.align;
      if (style.strokeWidth) el.style.borderWidth = `${style.strokeWidth}px`;
      if (style.strokeStyle) el.style.borderStyle = style.strokeStyle;
      if (style.boundary) el.classList.add("has-boundary");
      if (style.shape) el.classList.add(`mtm-shape-${style.shape}`);
    }

    if (node.children?.length) {
      const collapse = document.createElement("button");
      collapse.className = "mtm-collapse";
      collapse.textContent = node.collapsed ? "+" : "−";
      collapse.title = node.collapsed ? "Expand" : "Collapse";
      collapse.onclick = (event) => {
        event.stopPropagation();
        this.toggleCollapse(node);
      };
      el.appendChild(collapse);
    }

    const content = document.createElement("div");
    content.className = "mtm-node-content";
    el.appendChild(content);
    if (style?.icon) {
      const icon = document.createElement("span");
      icon.className = "mtm-node-custom-icon";
      icon.textContent = style.icon;
      el.insertBefore(icon, content);
    }
    const markdown = document.createElement("div");
    content.appendChild(markdown);
    if (this.file) {
      MarkdownRenderer.render(this.app, node.text || "Untitled", markdown, this.file.path, this).catch(() => {
        markdown.textContent = node.text || "Untitled";
      });
    } else markdown.textContent = node.text || "Untitled";

    if (style?.labels?.length || style?.markers?.length) {
      const badges = document.createElement("div");
      badges.className = "mtm-node-badges";
      for (const label of style.labels || []) badges.appendChild(Object.assign(document.createElement("span"), { className: "mtm-node-label", textContent: label }));
      for (const marker of style.markers || []) badges.appendChild(Object.assign(document.createElement("span"), { className: "mtm-node-marker", textContent: String(marker).replace(/^priority-/, "P") }));
      content.appendChild(badges);
    }
    const nodeNote = style && Object.prototype.hasOwnProperty.call(style, "note") ? style.note : node.note;
    if (nodeNote) {
      const note = document.createElement("button");
      note.className = "mtm-note-indicator";
      note.textContent = "📝";
      note.title = nodeNote;
      note.onclick = (event) => {
        event.stopPropagation();
        new NodeStyleModal(this.app, this, node).open();
      };
      el.appendChild(note);
    }
    if (style?.link) {
      const link = document.createElement("button");
      link.className = "mtm-link-indicator";
      link.textContent = "↗";
      link.title = style.link;
      link.onclick = async (event) => {
        event.stopPropagation();
        if (/^https?:\/\//i.test(style.link)) window.open(style.link, "_blank", "noopener,noreferrer");
        else if (this.file) await this.app.workspace.openLinkText(style.link, this.file.path, true);
      };
      el.appendChild(link);
    }
    if (style?.callout) {
      const callout = document.createElement("div");
      callout.className = "mtm-callout";
      callout.textContent = style.callout;
      if (style.calloutFill) callout.style.backgroundColor = style.calloutFill;
      if (style.calloutStroke) callout.style.borderColor = style.calloutStroke;
      el.appendChild(callout);
    }

    el.onclick = (event) => {
      event.stopPropagation();
      this.selectedNodeId = node.id;
      this.render();
      this.contentEl.focus();
    };
    el.ondblclick = (event) => {
      event.stopPropagation();
      this.selectedNodeId = node.id;
      this.editSelected();
    };
    el.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectedNodeId = node.id;
      this.showNodeMenu(event, node);
    };
    el.ondragstart = (event) => {
      event.dataTransfer?.setData("application/x-marktomind-node", node.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      this.draggedNodeId = node.id;
      el.classList.add("is-dragging");
    };
    el.ondragover = (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (this.draggedNodeId && this.draggedNodeId !== node.id) this.setDropIndicator(el, this.dropModeForEvent(event, el));
    };
    el.ondragleave = (event) => {
      if (!el.contains(event.relatedTarget)) this.clearDropIndicators();
    };
    el.ondrop = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dragged = event.dataTransfer?.getData("application/x-marktomind-node");
      const mode = this.dropModeForEvent(event, el);
      this.clearDropIndicators();
      this.draggedNodeId = null;
      if (dragged) await this.moveNodeByDrop(dragged, node.id, mode);
    };
    el.ondragend = () => {
      this.draggedNodeId = null;
      el.classList.remove("is-dragging");
      this.clearDropIndicators();
    };
    this.bindTouchNodeDrag(el, node, isRoot);
    return el;
  }

  dropModeForEvent(event, el) {
    const rect = el.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    if (ratio < 0.28) return "before";
    if (ratio > 0.72) return "after";
    return "inside";
  }

  clearDropIndicators() {
    for (const item of this.canvasEl?.querySelectorAll(".is-drop-before,.is-drop-after,.is-drop-inside") || []) {
      item.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
    }
  }

  setDropIndicator(el, mode) {
    this.clearDropIndicators();
    if (el) el.classList.add(`is-drop-${mode}`);
  }

  async moveNodeByDrop(draggedId, targetId, mode = "inside") {
    if (!draggedId || draggedId === targetId || draggedId === this.tree.id) return;
    const dragged = findNode(this.tree, draggedId);
    const target = findNode(this.tree, targetId);
    if (!dragged || !target || treeContains(dragged, targetId)) return;
    if ((mode === "before" || mode === "after") && target.id === this.tree.id) mode = "inside";
    const targetParent = mode === "inside" ? null : findParent(this.tree, targetId);
    if (mode !== "inside" && !targetParent) mode = "inside";
    this.pushUndo();
    const detached = removeNode(this.tree, draggedId);
    if (!detached) return;
    if (mode === "inside") {
      target.children = target.children || [];
      target.children.push(detached);
      target.collapsed = false;
    } else {
      const parent = findParent(this.tree, targetId) || targetParent;
      const index = parent.children.findIndex((child) => child.id === targetId);
      parent.children.splice(index + (mode === "after" ? 1 : 0), 0, detached);
    }
    this.selectedNodeId = draggedId;
    await this.commitTree();
  }

  bindTouchNodeDrag(el, node, isRoot) {
    if (isRoot) return;
    let timer = null;
    let active = false;
    let targetId = null;
    let targetMode = "inside";
    const clear = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
      this.clearDropIndicators();
    };
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      event.stopPropagation();
      timer = window.setTimeout(() => {
        active = true;
        this.touchNodeDrag = node.id;
        el.classList.add("is-dragging");
        el.setPointerCapture?.(event.pointerId);
      }, 420);
    });
    el.addEventListener("pointermove", (event) => {
      if (!active) return;
      event.preventDefault();
      this.autoScrollDuringDrag(event.clientX, event.clientY);
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".mtm-node[data-node-id]");
      if (!hit || hit.dataset.nodeId === node.id) return;
      targetId = hit.dataset.nodeId;
      targetMode = this.dropModeForEvent(event, hit);
      this.setDropIndicator(hit, targetMode);
    });
    const finish = async (event) => {
      if (timer) window.clearTimeout(timer);
      timer = null;
      if (active) {
        event.preventDefault();
        active = false;
        el.classList.remove("is-dragging");
        this.touchNodeDrag = null;
        this.clearDropIndicators();
        if (targetId) await this.moveNodeByDrop(node.id, targetId, targetMode);
      }
      targetId = null;
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("lostpointercapture", clear);
  }

  showNodeMenu(event, node) {
    const T = (zh, en) => ui(this.plugin, zh, en);
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(T("编辑节点", "Edit node")).setIcon("pencil").onClick(() => this.editNode(node)));
    menu.addItem((item) => item.setTitle(T("添加子节点", "Add child")).setIcon("plus-circle").onClick(() => this.addChild(node.id)));
    if (node.id !== this.tree.id) menu.addItem((item) => item.setTitle(T("添加同级节点", "Add sibling")).setIcon("corner-down-right").onClick(() => this.addSibling(node.id)));
    menu.addItem((item) => item.setTitle(T("插入父节点", "Insert parent node")).setIcon("git-branch-plus").onClick(() => this.insertParent(node.id)));
    if (node.id !== this.tree.id) menu.addItem((item) => item.setTitle(T("删除节点及子节点", "Delete node")).setIcon("trash-2").onClick(() => this.deleteNode(node.id)));
    if (node.id !== this.tree.id) menu.addItem((item) => item.setTitle(T("仅删除当前节点并提升子节点", "Delete node only; promote children")).setIcon("ungroup").onClick(() => this.deleteNodeOnly(node.id)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(node.collapsed ? T("展开", "Expand") : T("折叠", "Collapse")).setIcon("chevrons-up-down").onClick(() => this.toggleCollapse(node)));
    menu.addItem((item) => item.setTitle(T("节点属性", "Node properties")).setIcon("palette").onClick(() => new NodeStyleModal(this.app, this, node).open()));
    menu.addItem((item) => item.setTitle(T("添加概要 Summary", "Add summary")).setIcon("brackets").onClick(async () => {
      const value = await this.plugin.prompt(T("概要文字", "Summary text"), this.plugin.fileMeta(this.file.path).nodeStyles?.[node.id]?.summary || "");
      if (value === null) return;
      this.pushUndo();
      const meta = this.plugin.fileMeta(this.file.path);
      meta.nodeStyles[node.id] = { ...(meta.nodeStyles[node.id] || {}), summary: value.trim() };
      await this.plugin.savePluginData();
      this.render();
    }));
    menu.addItem((item) => item.setTitle(T("添加/移除边界 Boundary", "Toggle boundary")).setIcon("square-dashed").onClick(async () => {
      this.pushUndo();
      const meta = this.plugin.fileMeta(this.file.path);
      const style = meta.nodeStyles[node.id] || (meta.nodeStyles[node.id] = {});
      style.boundary = !style.boundary;
      await this.plugin.savePluginData();
      this.render();
    }));
    menu.addItem((item) => item.setTitle(T("添加标注 Callout", "Add callout")).setIcon("message-square-text").onClick(async () => {
      const value = await this.plugin.prompt(T("标注文字", "Callout text"), this.plugin.fileMeta(this.file.path).nodeStyles?.[node.id]?.callout || "", true);
      if (value === null) return;
      this.pushUndo();
      const meta = this.plugin.fileMeta(this.file.path);
      meta.nodeStyles[node.id] = { ...(meta.nodeStyles[node.id] || {}), callout: value.trim() };
      await this.plugin.savePluginData();
      this.render();
    }));
    menu.addItem((item) => item.setTitle(T("创建关系线", "Create relation")).setIcon("network").onClick(() => this.createRelation(node.id)));
    const meta = this.plugin.fileMeta(this.file.path);
    const nodeRelations = (meta.relations || []).filter((relation) => relation.from === node.id || relation.to === node.id);
    for (const relation of nodeRelations.slice(0, 6)) {
      const otherId = relation.from === node.id ? relation.to : relation.from;
      const other = findNode(this.tree, otherId);
      const label = other?.text?.replace(/\s+/g, " ").slice(0, 24) || T("关系线", "Relationship");
      menu.addItem((item) => item.setTitle(`${T("编辑关系线", "Edit relationship")} → ${label}`).setIcon("git-compare-arrows").onClick(() => new RelationStyleModal(this.app, this, relation).open()));
    }
    menu.addItem((item) => item.setTitle(T("移除该节点关系线", "Remove node relations")).setIcon("unlink").onClick(() => this.removeNodeRelations(node.id)));
    if (this.isRichMode() && node.id !== this.tree.id) menu.addItem((item) => item.setTitle(T("转换为自由节点", "Convert to free node")).setIcon("move").onClick(() => this.convertNodeToFree(node.id)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(T("复制节点文字", "Copy node text")).setIcon("copy").onClick(() => navigator.clipboard?.writeText(node.text || "")));
    menu.addItem((item) => item.setTitle(T("复制节点块链接", "Copy block link")).setIcon("link").onClick(() => navigator.clipboard?.writeText(`[[${this.file.path}#^${node.id}]]`)));
    menu.addItem((item) => item.setTitle(T("复制节点子树", "Copy node subtree")).setIcon("copy-plus").onClick(() => { this.plugin.treeClipboard = deepClone(node); new Notice(T("节点子树已复制。", "Node subtree copied.")); }));
    if (this.plugin.treeClipboard) menu.addItem((item) => item.setTitle(T("粘贴子树为子节点", "Paste subtree as child")).setIcon("clipboard-paste").onClick(() => this.pasteSubtree(node.id)));
    menu.showAtMouseEvent(event);
  }

  pushUndo() {
    if (!this.tree) return;
    const meta = this.file ? deepClone(this.plugin.fileMeta(this.file.path)) : null;
    this.undoStack.push(JSON.stringify({ tree: this.tree, meta }));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  snapshotState() {
    return JSON.stringify({
      tree: this.tree,
      meta: this.file ? deepClone(this.plugin.fileMeta(this.file.path)) : null,
    });
  }

  restoreSnapshot(serialized) {
    const parsed = JSON.parse(serialized);
    if (parsed?.tree) {
      this.tree = parsed.tree;
      if (this.file && parsed.meta) this.plugin.fileMetaStore[this.file.path] = parsed.meta;
    } else {
      this.tree = parsed;
    }
  }

  async commitTree() {
    if (!this.file || !this.tree) return;
    const oldContent = await this.app.vault.read(this.file);
    this.plugin.recordHistory(this.file.path, oldContent);
    const mode = readFrontmatterValue(this.frontmatter, "mindmap-plugin") || "basic";
    const merged = mergeFrontmatter(this.frontmatter, {
      "mindmap-plugin": mode,
      "marktomind": "true",
      "mindmap-layout": markmindLayoutName(this.layout),
    });
    const next = `---\n${merged}\n---\n${serializeTree(this.tree)}`;
    if (next !== oldContent.replace(/\r\n/g, "\n")) await this.app.vault.modify(this.file, next);
    this.frontmatter = merged;
    await this.plugin.savePluginData();
    this.render();
  }

  async addChild(id = this.selectedNodeId) {
    const node = findNode(this.tree, id) || this.tree;
    const value = await this.plugin.prompt(ui(this.plugin, "新建子节点", "New child node"), ui(this.plugin, "新节点", "New node"));
    if (value === null) return;
    this.pushUndo();
    const child = { id: makeId(), text: value.trim() || ui(this.plugin, "新节点", "New node"), children: [], collapsed: false };
    node.children = node.children || [];
    node.children.push(child);
    node.collapsed = false;
    this.selectedNodeId = child.id;
    await this.commitTree();
  }

  async addSibling(id = this.selectedNodeId) {
    const node = findNode(this.tree, id);
    if (!node || node.id === this.tree.id) return this.addChild(this.tree.id);
    const parent = findParent(this.tree, node.id);
    if (!parent) return;
    const value = await this.plugin.prompt(ui(this.plugin, "新建同级节点", "New sibling node"), ui(this.plugin, "新节点", "New node"));
    if (value === null) return;
    this.pushUndo();
    const sibling = { id: makeId(), text: value.trim() || ui(this.plugin, "新节点", "New node"), children: [], collapsed: false };
    const index = parent.children.findIndex((child) => child.id === node.id);
    parent.children.splice(index + 1, 0, sibling);
    this.selectedNodeId = sibling.id;
    await this.commitTree();
  }

  async editSelected() {
    const node = findNode(this.tree, this.selectedNodeId);
    if (node) await this.editNode(node);
  }

  async editNode(node) {
    const value = await this.plugin.prompt(ui(this.plugin, "编辑节点", "Edit node"), node.text || "", true);
    if (value === null || value === node.text) return;
    this.pushUndo();
    node.text = value.trim().replace(/\r?\n/g, "<br>") || ui(this.plugin, "未命名", "Untitled");
    await this.commitTree();
  }

  async insertParent(id = this.selectedNodeId) {
    const node = findNode(this.tree, id);
    if (!node) return;
    const value = await this.plugin.prompt(ui(this.plugin, "插入父节点", "Insert parent node"), ui(this.plugin, "父节点", "Parent"));
    if (value === null) return;
    this.pushUndo();
    const wrapper = { id: makeId(), text: value.trim() || ui(this.plugin, "父节点", "Parent"), children: [node], collapsed: false };
    if (node.id === this.tree.id) {
      this.tree = wrapper;
    } else {
      const parent = findParent(this.tree, node.id);
      const index = parent.children.findIndex((child) => child.id === node.id);
      parent.children.splice(index, 1, wrapper);
    }
    this.selectedNodeId = wrapper.id;
    await this.commitTree();
  }

  async deleteSelected() {
    if (this.selectedNodeId) await this.deleteNode(this.selectedNodeId);
  }

  async deleteNode(id) {
    if (!this.tree || id === this.tree.id) {
      new Notice(ui(this.plugin, "根节点不能删除。", "The root node cannot be deleted."));
      return;
    }
    const parent = findParent(this.tree, id);
    if (!parent) return;
    this.pushUndo();
    removeNode(this.tree, id);
    this.selectedNodeId = parent.id;
    const meta = this.plugin.fileMeta(this.file.path);
    if (meta.nodeStyles) delete meta.nodeStyles[id];
    meta.relations = (meta.relations || []).filter((relation) => relation.from !== id && relation.to !== id);
    await this.commitTree();
  }

  async deleteNodeOnly(id) {
    if (!this.tree || id === this.tree.id) return;
    const node = findNode(this.tree, id);
    const parent = findParent(this.tree, id);
    if (!node || !parent) return;
    this.pushUndo();
    const index = parent.children.findIndex((child) => child.id === id);
    parent.children.splice(index, 1, ...(node.children || []));
    this.selectedNodeId = parent.id;
    const meta = this.plugin.fileMeta(this.file.path);
    if (meta.nodeStyles) delete meta.nodeStyles[id];
    meta.relations = (meta.relations || []).filter((relation) => relation.from !== id && relation.to !== id);
    await this.commitTree();
  }

  async pasteSubtree(parentId = this.selectedNodeId) {
    if (!this.plugin.treeClipboard) return;
    const parent = findNode(this.tree, parentId);
    if (!parent) return;
    this.pushUndo();
    const subtree = regenerateIds(this.plugin.treeClipboard);
    parent.children = parent.children || [];
    parent.children.push(subtree);
    parent.collapsed = false;
    this.selectedNodeId = subtree.id;
    await this.commitTree();
  }

  async moveSibling(id, delta) {
    if (!id || id === this.tree.id) return;
    const parent = findParent(this.tree, id);
    if (!parent) return;
    const index = parent.children.findIndex((child) => child.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= parent.children.length) return;
    this.pushUndo();
    const [node] = parent.children.splice(index, 1);
    parent.children.splice(target, 0, node);
    await this.commitTree();
  }

  async reparentNode(draggedId, targetId) {
    if (!draggedId || draggedId === targetId || draggedId === this.tree.id) return;
    const dragged = findNode(this.tree, draggedId);
    const target = findNode(this.tree, targetId);
    if (!dragged || !target || treeContains(dragged, targetId)) return;
    this.pushUndo();
    const detached = removeNode(this.tree, draggedId);
    if (!detached) return;
    target.children = target.children || [];
    target.children.push(detached);
    target.collapsed = false;
    this.selectedNodeId = draggedId;
    await this.commitTree();
  }

  async toggleCollapse(node) {
    node.collapsed = !node.collapsed;
    const meta = this.plugin.fileMeta(this.file.path);
    meta.collapsed = meta.collapsed || {};
    if (node.collapsed) meta.collapsed[node.id] = true;
    else delete meta.collapsed[node.id];
    await this.plugin.savePluginData();
    this.render();
  }

  async undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshotState());
    this.restoreSnapshot(this.undoStack.pop());
    if (!findNode(this.tree, this.selectedNodeId)) this.selectedNodeId = this.tree.id;
    await this.commitTree();
  }

  async redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshotState());
    this.restoreSnapshot(this.redoStack.pop());
    if (!findNode(this.tree, this.selectedNodeId)) this.selectedNodeId = this.tree.id;
    await this.commitTree();
  }

  async createRelation(fromId = this.selectedNodeId) {
    const from = findNode(this.tree, fromId);
    if (!from) return;
    const query = await this.plugin.prompt(ui(this.plugin, "连接到节点", "Relate to node"), "", false, ui(this.plugin, "输入目标节点的部分文字", "Type part of the target node text"));
    if (query === null || !query.trim()) return;
    const lower = query.trim().toLowerCase();
    const target = flattenTree(this.tree).map((item) => item.node).find((node) => node.id !== from.id && node.text.toLowerCase().includes(lower));
    if (!target) {
      new Notice(ui(this.plugin, "没有找到匹配的目标节点。", "No matching target node found."));
      return;
    }
    const label = await this.plugin.prompt(ui(this.plugin, "关系线文字（可留空）", "Relationship label (optional)"), "");
    if (label === null) return;
    const meta = this.plugin.fileMeta(this.file.path);
    meta.relations = meta.relations || [];
    if (!meta.relations.some((relation) => relation.from === from.id && relation.to === target.id)) {
      this.pushUndo();
      meta.relations.push({
        id: makeId(),
        from: from.id,
        to: target.id,
        label: label.trim(),
        stroke: "",
        strokeWidth: 2,
        strokeStyle: "dashed",
        startMarker: "none",
        endMarker: "arrow",
      });
      await this.plugin.savePluginData();
    }
    this.render();
  }

  async removeNodeRelations(id) {
    this.pushUndo();
    const meta = this.plugin.fileMeta(this.file.path);
    meta.relations = (meta.relations || []).filter((relation) => relation.from !== id && relation.to !== id);
    await this.plugin.savePluginData();
    this.render();
  }

  async createFreeNode() {
    if (!this.file) return;
    await this.createFreeNodeAt(80 + this.canvasWrapEl.scrollLeft, 80 + this.canvasWrapEl.scrollTop);
  }

  async createFreeNodeAt(x, y) {
    if (!this.file) return;
    const T = (zh, en) => ui(this.plugin, zh, en);
    const value = await this.plugin.prompt(T("自由节点", "Free node"), T("自由节点", "Free node"));
    if (value === null) return;
    this.pushUndo();
    const meta = this.plugin.fileMeta(this.file.path);
    meta.freeNodes = meta.freeNodes || [];
    meta.freeNodes.push({ id: makeId(), text: value.trim() || T("自由节点", "Free node"), x: Math.max(0, x), y: Math.max(0, y) });
    await this.plugin.savePluginData();
    this.render();
  }

  async convertNodeToFree(id) {
    if (!this.file || !this.isRichMode() || id === this.tree?.id) return;
    const node = findNode(this.tree, id);
    const parent = findParent(this.tree, id);
    if (!node || !parent) return;
    this.pushUndo();
    const detached = removeNode(this.tree, id);
    if (!detached) return;
    const meta = this.plugin.fileMeta(this.file.path);
    meta.freeNodes = meta.freeNodes || [];
    meta.freeNodes.push({
      id: detached.id,
      text: detached.text,
      tree: deepClone(detached),
      x: Math.max(20, 80 + this.canvasWrapEl.scrollLeft / this.zoom),
      y: Math.max(20, 80 + this.canvasWrapEl.scrollTop / this.zoom),
    });
    this.selectedNodeId = parent.id;
    await this.commitTree();
  }

  async convertFreeToNode(item) {
    if (!this.file || !this.tree) return;
    const parent = findNode(this.tree, this.selectedNodeId) || this.tree;
    this.pushUndo();
    const subtree = item.tree ? deepClone(item.tree) : { id: item.id || makeId(), text: item.text || ui(this.plugin, "自由节点", "Free node"), children: [], collapsed: false };
    parent.children = parent.children || [];
    parent.children.push(subtree);
    parent.collapsed = false;
    const meta = this.plugin.fileMeta(this.file.path);
    meta.freeNodes = (meta.freeNodes || []).filter((free) => free !== item && free.id !== item.id);
    this.selectedNodeId = subtree.id;
    await this.commitTree();
  }

  isRichMode() {
    return (readFrontmatterValue(this.frontmatter, "mindmap-plugin") || "basic").toLowerCase() === "rich";
  }

  isBlankCanvasTarget(target) {
    return target === this.canvasWrapEl || target === this.canvasEl || target?.classList?.contains("mtm-mindmap") || target?.classList?.contains("mtm-fishbone");
  }

  canvasPoint(clientX, clientY) {
    const rect = this.canvasWrapEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left + this.canvasWrapEl.scrollLeft) / this.zoom,
      y: (clientY - rect.top + this.canvasWrapEl.scrollTop) / this.zoom,
    };
  }

  handleBlankDoubleClick(event) {
    if (!this.plugin.settings.allowFreeNodeGesture || !this.isRichMode() || !this.isBlankCanvasTarget(event.target)) return;
    event.preventDefault();
    const point = this.canvasPoint(event.clientX, event.clientY);
    void this.createFreeNodeAt(point.x, point.y);
  }

  handleCanvasPointerDown(event) {
    if (event.pointerType !== "mouse") this.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointerMap.size === 2) {
      const points = [...this.pointerMap.values()];
      this.pinchStart = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), zoom: this.zoom };
      if (this.blankLongPressTimer) window.clearTimeout(this.blankLongPressTimer);
      this.blankLongPressTimer = null;
      return;
    }
    if (event.pointerType === "mouse" || !this.plugin.settings.allowFreeNodeGesture || !this.isRichMode() || !this.isBlankCanvasTarget(event.target)) return;
    const point = this.canvasPoint(event.clientX, event.clientY);
    this._blankPress = { clientX: event.clientX, clientY: event.clientY, point };
    this.blankLongPressTimer = window.setTimeout(() => {
      this.blankLongPressTimer = null;
      if (this._blankPress) void this.createFreeNodeAt(this._blankPress.point.x, this._blankPress.point.y);
      this._blankPress = null;
    }, 2000);
  }

  handleCanvasPointerMove(event) {
    if (this.pointerMap.has(event.pointerId)) this.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this._blankPress && Math.hypot(event.clientX - this._blankPress.clientX, event.clientY - this._blankPress.clientY) > 12) {
      if (this.blankLongPressTimer) window.clearTimeout(this.blankLongPressTimer);
      this.blankLongPressTimer = null;
      this._blankPress = null;
    }
    if (this.pointerMap.size === 2 && this.pinchStart?.distance) {
      const points = [...this.pointerMap.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const ratio = distance / this.pinchStart.distance;
      this.setZoom(this.pinchStart.zoom * ratio);
      event.preventDefault();
    }
  }

  handleCanvasPointerUp(event) {
    this.pointerMap.delete(event.pointerId);
    if (this.pointerMap.size < 2) this.pinchStart = null;
    if (this.blankLongPressTimer) window.clearTimeout(this.blankLongPressTimer);
    this.blankLongPressTimer = null;
    this._blankPress = null;
  }

  handleCanvasWheel(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const speed = Math.max(0.02, Math.min(0.4, Number(this.plugin.settings.mobileScaleSpeed) || 0.12));
    this.setZoom(this.zoom + (event.deltaY < 0 ? speed : -speed));
  }

  autoScrollDuringDrag(clientX, clientY) {
    if (!this.canvasWrapEl) return;
    const rect = this.canvasWrapEl.getBoundingClientRect();
    const margin = 48;
    const step = 18;
    if (clientX < rect.left + margin) this.canvasWrapEl.scrollLeft -= step;
    else if (clientX > rect.right - margin) this.canvasWrapEl.scrollLeft += step;
    if (clientY < rect.top + margin) this.canvasWrapEl.scrollTop -= step;
    else if (clientY > rect.bottom - margin) this.canvasWrapEl.scrollTop += step;
  }

  renderFreeNodes() {
    if (!this.file || this.mode === "table") return;
    const meta = this.plugin.fileMeta(this.file.path);
    for (const item of meta.freeNodes || []) {
      const el = this.canvasEl.createDiv({ cls: "mtm-free-node" });
      const style = meta.nodeStyles?.[item.id] || {};
      if (style.fill) el.style.backgroundColor = style.fill;
      if (style.stroke) el.style.borderColor = style.stroke;
      if (style.text) el.style.color = style.text;
      if (style.strokeWidth) el.style.borderWidth = `${style.strokeWidth}px`;
      if (style.strokeStyle) el.style.borderStyle = style.strokeStyle;
      if (style.shape) el.classList.add(`mtm-shape-${style.shape}`);
      const head = el.createDiv({ cls: "mtm-free-node-head" });
      if (style.icon) head.createSpan({ cls: "mtm-node-custom-icon", text: style.icon });
      const textEl = head.createDiv({ cls: "mtm-free-node-text" });
      MarkdownRenderer.render(this.app, item.text || ui(this.plugin, "自由节点", "Free node"), textEl, this.file.path, this).catch(() => textEl.setText(item.text || ui(this.plugin, "自由节点", "Free node")));
      if (item.tree?.children?.length) {
        const branchCount = flattenTree(item.tree).length - 1;
        el.createDiv({ cls: "mtm-free-node-subtree-count", text: ui(this.plugin, `子树 ${branchCount} 个节点`, `${branchCount} subtree nodes`) });
      }
      el.style.left = `${item.x || 0}px`;
      el.style.top = `${item.y || 0}px`;
      el.ondblclick = async () => {
        const value = await this.plugin.prompt(ui(this.plugin, "编辑自由节点", "Edit free node"), item.text || "", true);
        if (value !== null) {
          this.pushUndo();
          item.text = value.trim() || ui(this.plugin, "自由节点", "Free node");
          if (item.tree) item.tree.text = item.text;
          await this.plugin.savePluginData();
          this.render();
        }
      };
      el.oncontextmenu = (event) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((menuItem) => menuItem.setTitle(ui(this.plugin, "自由节点属性", "Free node properties")).setIcon("palette").onClick(() => {
          const proxyNode = item.tree || { id: item.id, text: item.text || "", children: [] };
          new NodeStyleModal(this.app, this, proxyNode).open();
        }));
        menu.addItem((menuItem) => menuItem.setTitle(ui(this.plugin, "转换为普通节点（添加到当前选中节点下）", "Convert to regular node under current selection")).setIcon("git-branch-plus").onClick(() => this.convertFreeToNode(item)));
        menu.addItem((menuItem) => menuItem.setTitle(ui(this.plugin, "删除自由节点", "Delete free node")).setIcon("trash-2").onClick(async () => {
          this.pushUndo();
          meta.freeNodes = (meta.freeNodes || []).filter((free) => free.id !== item.id);
          await this.plugin.savePluginData();
          this.render();
        }));
        menu.showAtMouseEvent(event);
      };

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let originX = 0;
      let originY = 0;
      let dragSnapshotTaken = false;
      el.onpointerdown = (event) => {
        if (event.button !== 0) return;
        dragging = true;
        dragSnapshotTaken = false;
        startX = event.clientX;
        startY = event.clientY;
        originX = item.x || 0;
        originY = item.y || 0;
        el.setPointerCapture?.(event.pointerId);
      };
      el.onpointermove = (event) => {
        if (!dragging) return;
        if (!dragSnapshotTaken && Math.hypot(event.clientX - startX, event.clientY - startY) > 2) {
          this.pushUndo();
          dragSnapshotTaken = true;
        }
        item.x = Math.max(0, originX + event.clientX - startX);
        item.y = Math.max(0, originY + event.clientY - startY);
        el.style.left = `${item.x}px`;
        el.style.top = `${item.y}px`;
      };
      el.onpointerup = async () => {
        if (!dragging) return;
        dragging = false;
        await this.plugin.savePluginData();
      };
    }
  }

  drawConnections() {
    if (!this.canvasEl || !this.tree) return;
    this.canvasEl.querySelector(".mtm-relations")?.remove();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mtm-relations");
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const scale = this.zoom || 1;
    const nodeEl = (id) => this.canvasEl.querySelector(`.mtm-node[data-node-id="${CSS.escape(id)}"]`);
    const relRect = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: (rect.left - canvasRect.left) / scale,
        top: (rect.top - canvasRect.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
        right: (rect.right - canvasRect.left) / scale,
        bottom: (rect.bottom - canvasRect.top) / scale,
      };
    };
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    arrow.setAttribute("id", "mtm-arrow-end");
    arrow.setAttribute("viewBox", "0 0 10 10");
    arrow.setAttribute("refX", "9");
    arrow.setAttribute("refY", "5");
    arrow.setAttribute("markerWidth", "7");
    arrow.setAttribute("markerHeight", "7");
    arrow.setAttribute("orient", "auto-start-reverse");
    const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrowPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrowPath.setAttribute("class", "mtm-arrow-marker");
    arrow.appendChild(arrowPath);
    defs.appendChild(arrow);
    svg.appendChild(defs);

    const addLine = (fromId, toId, kind, relation = null) => {
      const from = nodeEl(fromId);
      const to = nodeEl(toId);
      if (!from || !to) return;
      const a = relRect(from);
      const b = relRect(to);
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const curve = kind === "mtm-relation" ? Math.max(40, Math.abs(bx - ax) * 0.35 + Math.abs(by - ay) * 0.12) : Math.max(24, Math.abs(bx - ax) * 0.3);
      const direction = bx >= ax ? 1 : -1;
      path.setAttribute("d", `M ${ax} ${ay} C ${ax + curve * direction} ${ay}, ${bx - curve * direction} ${by}, ${bx} ${by}`);
      path.setAttribute("class", kind);
      if (relation?.stroke) path.setAttribute("stroke", relation.stroke);
      if (relation?.strokeWidth) path.setAttribute("stroke-width", String(relation.strokeWidth));
      if (relation?.strokeStyle === "dotted") path.setAttribute("stroke-dasharray", "2 5");
      else if (relation?.strokeStyle === "dashed") path.setAttribute("stroke-dasharray", "7 5");
      if ((relation?.endMarker || "arrow") !== "none" && kind === "mtm-relation") path.setAttribute("marker-end", "url(#mtm-arrow-end)");
      svg.appendChild(path);
      if (relation?.label) {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", String((ax + bx) / 2));
        text.setAttribute("y", String((ay + by) / 2 - 6));
        text.setAttribute("class", "mtm-relation-label");
        text.textContent = relation.label;
        svg.appendChild(text);
      }
    };

    for (const { node } of flattenTree(this.tree)) {
      if (node.collapsed) continue;
      for (const child of node.children || []) addLine(node.id, child.id, "mtm-edge");
    }
    const meta = this.plugin.fileMeta(this.file?.path || "");
    for (const relation of meta.relations || []) addLine(relation.from, relation.to, "mtm-relation", relation);

    const subtreeBounds = (node) => {
      const rects = visibleSubtreeIds(node).map((id) => nodeEl(id)).filter(Boolean).map(relRect);
      if (!rects.length) return null;
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      };
    };

    for (const { node } of flattenTree(this.tree)) {
      const style = meta.nodeStyles?.[node.id] || {};
      if (!style.boundary && !style.summary) continue;
      const bounds = subtreeBounds(node);
      if (!bounds) continue;
      if (style.boundary) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String(bounds.left - 12));
        rect.setAttribute("y", String(bounds.top - 12));
        rect.setAttribute("width", String(bounds.right - bounds.left + 24));
        rect.setAttribute("height", String(bounds.bottom - bounds.top + 24));
        rect.setAttribute("rx", "14");
        rect.setAttribute("class", "mtm-boundary-shape");
        if (style.boundaryStroke) rect.setAttribute("stroke", style.boundaryStroke);
        if (style.boundaryFill) rect.setAttribute("fill", style.boundaryFill);
        svg.insertBefore(rect, svg.firstChild?.nextSibling || null);
        if (style.boundaryLabel) {
          const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
          label.setAttribute("x", String(bounds.left - 4));
          label.setAttribute("y", String(bounds.top - 18));
          label.setAttribute("class", "mtm-boundary-label");
          label.textContent = style.boundaryLabel;
          svg.appendChild(label);
        }
      }
      if (style.summary) {
        const leftSide = this.layout === "left" || this.layout === "fish-left";
        const x = leftSide ? bounds.left - 24 : bounds.right + 24;
        const hook = leftSide ? 9 : -9;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${x + hook} ${bounds.top} Q ${x} ${bounds.top} ${x} ${bounds.top + 10} L ${x} ${bounds.bottom - 10} Q ${x} ${bounds.bottom} ${x + hook} ${bounds.bottom}`);
        path.setAttribute("class", "mtm-summary-bracket");
        if (style.summaryStroke) path.setAttribute("stroke", style.summaryStroke);
        svg.appendChild(path);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String(leftSide ? x - 8 : x + 8));
        label.setAttribute("y", String((bounds.top + bounds.bottom) / 2));
        label.setAttribute("text-anchor", leftSide ? "end" : "start");
        label.setAttribute("class", "mtm-summary-label");
        label.textContent = style.summary;
        svg.appendChild(label);
      }
    }
    this.canvasEl.prepend(svg);
  }

  toggleSearchBox() {
    if (!this.searchEl) return;
    this.searchVisible = !this.searchVisible;
    this.searchEl.style.display = this.searchVisible ? "" : "none";
    if (this.searchVisible) {
      this.searchEl.focus();
      this.searchEl.select();
    } else {
      this.searchEl.value = "";
      this.searchTerm = "";
      this.render();
      this.contentEl.focus();
    }
  }

  centerMindmap() {
    if (!this.canvasWrapEl || !this.canvasEl || !this.tree) return;
    const rootEl = [...this.canvasEl.querySelectorAll("[data-node-id]")]
      .find((el) => el.dataset.nodeId === this.tree.id);
    if (!rootEl) {
      this.fitToView();
      return;
    }
    const wrapRect = this.canvasWrapEl.getBoundingClientRect();
    const nodeRect = rootEl.getBoundingClientRect();
    this.canvasWrapEl.scrollLeft += nodeRect.left - wrapRect.left - (wrapRect.width - nodeRect.width) / 2;
    this.canvasWrapEl.scrollTop += nodeRect.top - wrapRect.top - (wrapRect.height - nodeRect.height) / 2;
  }

  syncLayoutSelector() {
    if (!this.layoutSelectEl || !this.tree) return;
    const selected = findNode(this.tree, this.selectedNodeId) || this.tree;
    if (selected.id === this.tree.id) {
      this.layoutSelectEl.value = this.layout;
      return;
    }
    const local = this.plugin.fileMeta(this.file?.path || "").nodeStyles?.[selected.id]?.layout;
    this.layoutSelectEl.value = local ? canonicalLayout(local) : this.layout;
  }

  async applySelectedLayout(nextLayout) {
    if (!this.file || !this.tree) return false;
    const next = canonicalLayout(nextLayout);
    const selected = findNode(this.tree, this.selectedNodeId) || this.tree;
    const meta = this.plugin.fileMeta(this.file.path);
    this.pushUndo();
    if (selected.id === this.tree.id) {
      this.layout = next;
      meta.layout = next;
    } else {
      meta.nodeStyles = meta.nodeStyles || {};
      meta.nodeStyles[selected.id] = { ...(meta.nodeStyles[selected.id] || {}), layout: next };
    }
    await this.plugin.savePluginData();
    this.render();
    return true;
  }

  setShortcutLayout(key) {
    const layoutMap = {
      r: "right",
      l: "left",
      u: "up",
      d: "down",
      m: "mindmap",
      j: "tree",
      k: "vertical",
      q: "fish-right",
      t: "fish-left",
    };
    const next = layoutMap[String(key || "").toLowerCase()];
    if (!next || !this.file) return false;
    void this.applySelectedLayout(next);
    return true;
  }

  selectDirectional(key) {
    if (!this.tree || !this.selectedNodeId) return;
    const direction = key.replace("Arrow", "").toLowerCase();
    const nodeEls = [...(this.canvasEl?.querySelectorAll("[data-node-id]") || [])];
    const selectedEl = nodeEls.find((el) => el.dataset.nodeId === this.selectedNodeId);

    if (selectedEl && nodeEls.length > 1) {
      const source = selectedEl.getBoundingClientRect();
      const sx = source.left + source.width / 2;
      const sy = source.top + source.height / 2;
      let best = null;
      for (const el of nodeEls) {
        if (el === selectedEl) continue;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const dx = x - sx;
        const dy = y - sy;
        const eligible = direction === "right" ? dx > 4
          : direction === "left" ? dx < -4
            : direction === "up" ? dy < -4
              : dy > 4;
        if (!eligible) continue;
        const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
        const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
        const score = primary + secondary * 0.45;
        if (!best || score < best.score) best = { id: el.dataset.nodeId, score };
      }
      if (best?.id) {
        this.selectedNodeId = best.id;
        this.render();
        return;
      }
    }

    const rows = flattenTree(this.tree).map(({ node }) => node);
    const index = rows.findIndex((node) => node.id === this.selectedNodeId);
    if (index < 0) return;
    if (direction === "up") this.selectedNodeId = rows[Math.max(0, index - 1)].id;
    else if (direction === "down") this.selectedNodeId = rows[Math.min(rows.length - 1, index + 1)].id;
    else if (direction === "left") {
      const parent = findParent(this.tree, this.selectedNodeId);
      if (parent) this.selectedNodeId = parent.id;
    } else {
      const current = rows[index];
      if (current.children?.length) this.selectedNodeId = current.children[0].id;
    }
    this.render();
  }

  async editSelectedFromTypedKey(key) {
    const node = findNode(this.tree, this.selectedNodeId);
    if (!node) return;
    const value = await this.plugin.prompt(ui(this.plugin, "编辑节点", "Edit node"), key, true);
    if (value === null) return;
    this.pushUndo();
    node.text = value.trim().replace(/\r?\n/g, "<br>") || "Untitled";
    await this.commitTree();
  }

  async copySelectedNodeText() {
    const node = findNode(this.tree, this.selectedNodeId);
    if (node?.text) await navigator.clipboard?.writeText(node.text);
  }

  async pastePlainTextAsChildren(text, parentNode) {
    const nodes = plainTextToSubtrees(text);
    if (!nodes.length || !parentNode) return false;
    this.pushUndo();
    parentNode.children = parentNode.children || [];
    parentNode.children.push(...nodes);
    parentNode.collapsed = false;
    this.selectedNodeId = nodes[0].id;
    await this.commitTree();
    return true;
  }

  handleKeyDown(event) {
    const tag = event.target?.tagName?.toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || event.target?.isContentEditable) return;
    const mod = event.ctrlKey || event.metaKey;
    const lower = String(event.key || "").toLowerCase();
    const custom = !!this.plugin.settings.useCustomShortcuts;

    if (mod && event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSibling(this.selectedNodeId, -1);
      return;
    }
    if (mod && event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSibling(this.selectedNodeId, 1);
      return;
    }

    if (mod && !event.shiftKey && ["r", "l", "u", "d", "m", "j", "k", "q", "t"].includes(lower)) {
      event.preventDefault();
      this.setShortcutLayout(lower);
      return;
    }

    if (mod && !event.shiftKey && lower === "e") {
      event.preventDefault();
      this.centerMindmap();
      return;
    }
    if (mod && !event.shiftKey && lower === "f") {
      event.preventDefault();
      this.toggleSearchBox();
      return;
    }
    if (mod && !event.shiftKey && lower === "c") {
      event.preventDefault();
      void this.copySelectedNodeText();
      return;
    }
    if (mod && !event.shiftKey && lower === "v") {
      return;
    }
    if (mod && !event.shiftKey && lower === "z" && !custom) {
      event.preventDefault();
      this.undo();
      return;
    }
    if (mod && !event.shiftKey && lower === "y" && !custom) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && !event.shiftKey && event.key === "/") {
      const node = findNode(this.tree, this.selectedNodeId);
      if (node) {
        event.preventDefault();
        this.toggleCollapse(node);
      }
      return;
    }

    if (!custom && (event.key === "Tab" || event.key === "Insert")) {
      event.preventDefault();
      this.addChild();
      return;
    }
    if (!custom && event.key === "Enter") {
      event.preventDefault();
      if (this.selectedNodeId && this.selectedNodeId !== this.tree?.id) this.addSibling();
      return;
    }
    if (!custom && event.key === " " && !mod) {
      event.preventDefault();
      this.editSelected();
      return;
    }
    if (!custom && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      this.selectDirectional(event.key);
      return;
    }

    if (!custom && !mod && !event.altKey && !event.shiftKey && event.key?.length === 1 && event.key !== "[") {
      event.preventDefault();
      void this.editSelectedFromTypedKey(event.key);
    }
  }

  async handlePaste(event) {
    if (!this.file || !this.selectedNodeId) return;
    const node = findNode(this.tree, this.selectedNodeId);
    if (!node) return;
    const items = [...(event.clipboardData?.items || [])];
    const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      const attachment = await this.plugin.saveAttachment(file);
      if (!attachment) return;
      this.pushUndo();
      node.text = `${node.text} ![[${attachment}]]`.trim();
      await this.commitTree();
      return;
    }
    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (!text) return;
    if (/\[\[.*\]\]|obsidian:\/\/|\.pdf(?:#|\?|$)/i.test(text)) {
      event.preventDefault();
      this.pushUndo();
      node.text = `${node.text} ${text}`.trim();
      await this.commitTree();
      new Notice(ui(this.plugin, "标注/链接已粘贴到选中节点。", "Annotation/link pasted into the selected node."));
      return;
    }
    event.preventDefault();
    await this.pastePlainTextAsChildren(text, node);
  }

  async handleExternalDrop(event) {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    const xmind = files.find((file) => file.name.toLowerCase().endsWith(".xmind"));
    if (xmind) {
      event.preventDefault();
      event.stopPropagation();
      await this.plugin.importXmindFile(xmind);
      return;
    }
    const image = files.find((file) => file.type?.startsWith("image/"));
    if (!image || !this.file || !this.selectedNodeId) return;
    event.preventDefault();
    event.stopPropagation();
    const node = findNode(this.tree, this.selectedNodeId);
    if (!node) return;
    const attachment = await this.plugin.saveAttachment(image);
    if (!attachment) return;
    this.pushUndo();
    node.text = `${node.text} ![[${attachment}]]`.trim();
    await this.commitTree();
  }

  setZoom(value) {
    this.zoom = Math.min(2.5, Math.max(0.3, Math.round(value * 10) / 10));
    this.applyZoom();
    if (this.statusEl) this.statusEl.setText(`${this.tree ? flattenTree(this.tree).length : 0} nodes · ${Math.round(this.zoom * 100)}%`);
  }

  applyZoom() {
    if (!this.canvasEl) return;
    this.canvasEl.style.transformOrigin = "top left";
    this.canvasEl.style.transform = `scale(${this.zoom})`;
  }

  fitToView() {
    if (!this.canvasWrapEl || !this.canvasEl) return;
    this.canvasEl.style.transform = "none";
    const width = Math.max(1, this.canvasEl.scrollWidth);
    const height = Math.max(1, this.canvasEl.scrollHeight);
    const scale = Math.min((this.canvasWrapEl.clientWidth - 30) / width, (this.canvasWrapEl.clientHeight - 30) / height, 1.5);
    this.setZoom(Number.isFinite(scale) ? scale : 1);
  }

  async expandToLevel(level) {
    if (!this.tree || !this.file) return;
    const meta = this.plugin.fileMeta(this.file.path);
    meta.collapsed = {};
    for (const { node, depth } of flattenTree(this.tree)) {
      node.collapsed = Number.isFinite(level) && depth >= level && !!node.children?.length;
      if (node.collapsed) meta.collapsed[node.id] = true;
    }
    await this.plugin.savePluginData();
    this.render();
  }

  async showExportMenu(event) {
    const T = (zh, en) => ui(this.plugin, zh, en);
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(T("导出 PNG", "Export PNG")).setIcon("image").onClick(() => this.exportPng()));
    menu.addItem((item) => item.setTitle(T("导出 SVG", "Export SVG")).setIcon("image").onClick(() => this.exportSvg()));
    menu.addItem((item) => item.setTitle(T("导出 OPML", "Export OPML")).setIcon("file-code").onClick(() => this.exportOpml()));
    menu.addItem((item) => item.setTitle(T("导出 XMind", "Export XMind")).setIcon("package").onClick(() => this.exportXmind()));
    menu.addItem((item) => item.setTitle(T("导出 HTML", "Export HTML")).setIcon("globe").onClick(() => this.exportHtml()));
    menu.addItem((item) => item.setTitle(T("打印 / 另存为 PDF", "Print / Save as PDF")).setIcon("printer").onClick(() => this.printPdf()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(T("复制为 Markdown", "Copy as Markdown")).setIcon("copy").onClick(() => navigator.clipboard?.writeText(markdownFromTree(this.tree))));
    menu.addItem((item) => item.setTitle(T("复制表格 Markdown", "Copy table Markdown")).setIcon("table").onClick(() => navigator.clipboard?.writeText(tableMarkdownFromTree(this.tree))));
    menu.addItem((item) => item.setTitle(T("复制表格 HTML", "Copy table HTML")).setIcon("code-2").onClick(() => navigator.clipboard?.writeText(this.tableHtml())));
    const mouse = event instanceof MouseEvent ? event : null;
    if (mouse) menu.showAtMouseEvent(mouse);
    else menu.showAtPosition({ x: 100, y: 100 });
  }

  async exportSvg() {
    const svg = buildSvg(this.tree, this.file.basename);
    const path = await this.plugin.writeAdjacentText(this.file, "marktomind", "svg", svg);
    new Notice(`${ui(this.plugin, "已导出", "Exported")} ${path}`);
  }

  async exportPng() {
    const svg = buildSvg(this.tree, this.file.basename);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, image.naturalWidth || image.width);
      canvas.height = Math.max(1, image.naturalHeight || image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const bytes = new Uint8Array(await png.arrayBuffer());
      const path = await this.plugin.writeAdjacentBinary(this.file, "marktomind", "png", bytes);
      new Notice(`${ui(this.plugin, "已导出", "Exported")} ${path}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async exportOpml() {
    const path = await this.plugin.writeAdjacentText(this.file, "marktomind", "opml", opmlFromTree(this.tree, this.file.basename));
    new Notice(`${ui(this.plugin, "已导出", "Exported")} ${path}`);
  }

  async exportXmind() {
    const meta = this.plugin.fileMeta(this.file.path);
    const bytes = createStoreZip(xmindFiles(this.tree, this.file.basename, meta, this.layout, meta.theme || this.plugin.settings.defaultTheme));
    const path = await this.plugin.writeAdjacentBinary(this.file, "", "xmind", bytes, { overwrite: true });
    new Notice(`${ui(this.plugin, "已导出", "Exported")} ${path}`);
  }

  async exportHtml() {
    const svg = buildSvg(this.tree, this.file.basename);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(this.file.basename)}</title><style>body{font-family:system-ui;margin:0;padding:24px;background:#f5f5f5}main{background:#fff;padding:16px;border-radius:12px;overflow:auto}</style></head><body><main>${svg}</main></body></html>`;
    const path = await this.plugin.writeAdjacentText(this.file, "marktomind", "html", html);
    new Notice(`${ui(this.plugin, "已导出", "Exported")} ${path}`);
  }

  tableHtml() {
    const rows = flattenTree(this.tree).map(({ node, depth }) => `<tr><td>${depth}</td><td>${escapeHtml(node.text || "")}</td><td>${(node.children || []).length}</td></tr>`).join("");
    return `<table><thead><tr><th>Level</th><th>Node</th><th>Children</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  printPdf() {
    const svg = buildSvg(this.tree, this.file.basename);
    const win = window.open("", "_blank", "popup=yes");
    if (!win) {
      new Notice(ui(this.plugin, "弹窗被阻止。请允许弹窗后再打印/另存为 PDF。", "Popup blocked. Allow popups to print/save as PDF."));
      return;
    }
    try { win.opener = null; } catch (_) { /* no-op */ }
    win.document.write(`<!doctype html><html><head><title>${escapeHtml(this.file.basename)}</title><style>@page{size:landscape;margin:10mm}body{margin:0}svg{max-width:100%;height:auto}</style></head><body>${svg}<script>window.onload=()=>setTimeout(()=>window.print(),100)</script></body></html>`);
    win.document.close();
  }

  openPresentation() {
    if (!this.tree || this.presentationEl) return;
    const nodes = flattenTree(this.tree).map(({ node }) => node);
    let index = 0;
    const overlay = document.body.createDiv({ cls: "mtm-presentation" });
    this.presentationEl = overlay;
    const card = overlay.createDiv({ cls: "mtm-presentation-card" });
    const controls = overlay.createDiv({ cls: "mtm-presentation-controls" });
    const prev = controls.createEl("button", { text: ui(this.plugin, "上一页", "Previous") });
    const next = controls.createEl("button", { text: ui(this.plugin, "下一页", "Next") });
    const close = controls.createEl("button", { text: ui(this.plugin, "关闭", "Close") });
    const draw = () => {
      card.empty();
      MarkdownRenderer.render(this.app, nodes[index]?.text || "", card, this.file.path, this).catch(() => card.setText(nodes[index]?.text || ""));
      next.setText(index === nodes.length - 1 ? ui(this.plugin, "结束", "Finish") : ui(this.plugin, "下一页", "Next"));
    };
    prev.onclick = () => { index = Math.max(0, index - 1); draw(); };
    next.onclick = () => { if (index >= nodes.length - 1) this.closePresentation(); else { index += 1; draw(); } };
    close.onclick = () => this.closePresentation();
    overlay.tabIndex = 0;
    overlay.onkeydown = (event) => {
      if (event.key === "Escape") this.closePresentation();
      if (event.key === "ArrowRight" || event.key === " ") next.click();
      if (event.key === "ArrowLeft") prev.click();
    };
    draw();
    overlay.focus();
  }

  closePresentation() {
    this.presentationEl?.remove();
    this.presentationEl = null;
  }
}

class MarkToMindSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const T = (zh, en) => ui(this.plugin, zh, en);
    containerEl.empty();
    containerEl.createEl("h2", { text: "MarkToMind" });

    new Setting(containerEl)
      .setName(T("界面语言", "Interface language"))
      .setDesc(T("默认使用简体中文。", "Simplified Chinese is the default."))
      .addDropdown((dropdown) => dropdown
        .addOption("zh-CN", "简体中文")
        .addOption("en", "English")
        .setValue(this.plugin.settings.uiLanguage || "zh-CN")
        .onChange(async (value) => {
          this.plugin.settings.uiLanguage = value;
          await this.plugin.savePluginData();
          this.plugin.refreshViews();
          this.display();
        }));

    new Setting(containerEl)
      .setName(T("默认视图", "Default view"))
      .setDesc(T("使用 MarkToMind 打开笔记时采用的视图。", "View used when opening a note in MarkToMind."))
      .addDropdown((dropdown) => dropdown
        .addOption("mindmap", T("思维导图", "Mind map"))
        .addOption("outline", T("大纲", "Outline"))
        .addOption("table", T("表格", "Table"))
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async (value) => { this.plugin.settings.defaultMode = value; await this.plugin.savePluginData(); }));

    new Setting(containerEl)
      .setName(T("默认布局", "Default layout"))
      .setDesc(T("新建思维导图的初始布局。", "Initial mind-map layout."))
      .addDropdown((dropdown) => dropdown
        .addOption("mindmap", T("双向导图", "Bilateral"))
        .addOption("right", T("向右", "Right"))
        .addOption("left", T("向左", "Left"))
        .addOption("up", T("向上", "Up"))
        .addOption("down", T("向下", "Down"))
        .addOption("tree", T("树状", "Tree"))
        .addOption("vertical", T("垂直", "Vertical"))
        .addOption("fish-right", T("右鱼骨", "Fish right"))
        .addOption("fish-left", T("左鱼骨", "Fish left"))
        .setValue(this.plugin.settings.defaultLayout)
        .onChange(async (value) => { this.plugin.settings.defaultLayout = value; await this.plugin.savePluginData(); }));

    new Setting(containerEl)
      .setName(T("默认主题", "Default theme"))
      .setDesc(T("主题集合与 Markmind 的常用主题语义保持对应。", "Theme set mirrors the common Markmind theme semantics."))
      .addDropdown((dropdown) => {
        const labels = { normal: T("默认", "Normal"), light: T("明亮", "Light"), dark: T("深色", "Dark"), card: T("卡片", "Card"), handdrawn: T("手绘", "Hand drawn"), black: T("黑色", "Black"), white: T("白色", "White"), warm: T("暖色", "Warm"), cold: T("冷色", "Cold"), relax: T("舒缓", "Relax") };
        for (const item of THEME_NAMES) dropdown.addOption(item, labels[item]);
        dropdown.setValue(this.plugin.settings.defaultTheme || "normal").onChange(async (value) => {
          this.plugin.settings.defaultTheme = value;
          await this.plugin.savePluginData();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName(T("使用自定义快捷键", "Use custom shortcuts"))
      .setDesc(T("与 Markmind 一致：关闭内置的新增、编辑、删除、撤销、重做快捷键，改由 Obsidian → 快捷键设置绑定。", "Match Markmind's custom-shortcut mode: disable built-in node add/edit/delete/undo/redo keys so these actions can be bound in Obsidian Settings → Hotkeys."))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useCustomShortcuts).onChange(async (value) => {
        this.plugin.settings.useCustomShortcuts = value;
        await this.plugin.savePluginData();
      }));

    new Setting(containerEl)
      .setName(T("强制手绘效果", "Hand-drawn theme"))
      .setDesc(T("在当前主题基础上叠加手绘节点外观。", "Give nodes a loose hand-drawn appearance."))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.handDrawn).onChange(async (value) => {
        this.plugin.settings.handDrawn = value;
        await this.plugin.savePluginData();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName(T("Rich 模式空白处创建自由节点", "Create free nodes from blank canvas"))
      .setDesc(T("双击空白处，或移动端长按空白处 2 秒创建自由节点。", "Double-click blank canvas, or long-press it for 2 seconds on touch devices."))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.allowFreeNodeGesture !== false).onChange(async (value) => {
        this.plugin.settings.allowFreeNodeGesture = value;
        await this.plugin.savePluginData();
      }));

    new Setting(containerEl)
      .setName(T("移动端缩放速度", "Mobile scale speed"))
      .setDesc(T("控制双指缩放和 Ctrl/Cmd + 滚轮缩放步长。", "Controls pinch and Ctrl/Cmd + wheel zoom sensitivity."))
      .addSlider((slider) => slider.setLimits(0.04, 0.3, 0.02).setValue(Number(this.plugin.settings.mobileScaleSpeed) || 0.12).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.mobileScaleSpeed = value;
        await this.plugin.savePluginData();
      }));

    new Setting(containerEl)
      .setName(T("画布背景", "Canvas background"))
      .setDesc(T("支持 transparent、CSS 颜色值或主题变量。", "Accepts transparent, CSS colors, or theme variables."))
      .addText((text) => text.setValue(this.plugin.settings.canvasBackground || "transparent").onChange(async (value) => {
        this.plugin.settings.canvasBackground = value.trim() || "transparent";
        await this.plugin.savePluginData();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName(T("恢复历史数量", "Recovery history limit"))
      .setDesc(T("每个思维导图文件保留的最大历史快照数。", "Maximum snapshots kept per mind-map file."))
      .addSlider((slider) => slider.setLimits(5, 100, 5).setValue(this.plugin.settings.historyLimit).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.historyLimit = value;
        await this.plugin.savePluginData();
      }));

    new Setting(containerEl)
      .setName(T("图片附件文件夹", "Image attachment folder"))
      .setDesc(T("粘贴到节点中的图片保存位置，相对于仓库根目录。", "Vault-relative folder for pasted node images."))
      .addText((text) => text.setValue(this.plugin.settings.attachmentFolder).onChange(async (value) => {
        this.plugin.settings.attachmentFolder = value.trim() || "MarkToMind Assets";
        await this.plugin.savePluginData();
      }));

    new Setting(containerEl)
      .setName(T("渲染嵌入的 MarkToMind 笔记", "Render embedded MarkToMind notes"))
      .setDesc(T("在可能时把兼容的内部嵌入渲染为紧凑的静态导图。", "Replace compatible internal embeds with a compact static tree when possible."))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoEmbed).onChange(async (value) => {
        this.plugin.settings.autoEmbed = value;
        await this.plugin.savePluginData();
      }));

    containerEl.createEl("h3", { text: T("AI / 自定义接口", "AI / custom endpoint") });
    new Setting(containerEl)
      .setName(T("接口地址", "Endpoint"))
      .setDesc(T("OpenAI 兼容的 chat-completions 接口。", "OpenAI-compatible chat-completions endpoint."))
      .addText((text) => text.setValue(this.plugin.settings.aiEndpoint).onChange(async (value) => {
        this.plugin.settings.aiEndpoint = value.trim();
        await this.plugin.savePluginData();
      }));
    new Setting(containerEl)
      .setName(T("模型", "Model"))
      .addText((text) => text.setValue(this.plugin.settings.aiModel).onChange(async (value) => {
        this.plugin.settings.aiModel = value.trim();
        await this.plugin.savePluginData();
      }));
    new Setting(containerEl)
      .setName("API key")
      .setDesc(T("仅保存在本插件的 data.json 中。", "Stored locally in this plugin's data.json."))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.aiApiKey).onChange(async (value) => {
          this.plugin.settings.aiApiKey = value.trim();
          await this.plugin.savePluginData();
        });
      });

    containerEl.createEl("h3", { text: T("PDF 标注链接工作流", "PDF annotation-link workflow") });
    new Setting(containerEl)
      .setName(T("标注模板", "Annotation template"))
      .setDesc(T("PDF 链接工作流使用的模板。变量：{{page}}、{{text}}、{{link}}。", "Template retained for PDF-link workflows. Variables: {{page}}, {{text}}, {{link}}."))
      .addTextArea((text) => text.setValue(this.plugin.settings.annotationTemplate).onChange(async (value) => {
        this.plugin.settings.annotationTemplate = value;
        await this.plugin.savePluginData();
      }));
  }
}

class MarkToMindPlugin extends Plugin {
  async onload() {
    const stored = (await this.loadData()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    this.fileMetaStore = stored.fileMeta || {};
    this.historyStore = stored.history || {};
    this.treeClipboard = null;
    this.activePrompt = null;

    this.registerView(VIEW_TYPE, (leaf) => new MarkToMindView(leaf, this));
    this.addSettingTab(new MarkToMindSettingTab(this.app, this));

    this.addRibbonIcon("git-fork", ui(this, "在 MarkToMind 中打开当前笔记", "Open active note in MarkToMind"), () => this.openActive("mindmap"));
    this.registerCommands();
    this.registerMenus();
    this.registerEmbedding();

    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (this.fileMetaStore[oldPath]) {
        this.fileMetaStore[file.path] = this.fileMetaStore[oldPath];
        delete this.fileMetaStore[oldPath];
      }
      if (this.historyStore[oldPath]) {
        this.historyStore[file.path] = this.historyStore[oldPath];
        delete this.historyStore[oldPath];
      }
      await this.savePluginData();
    }));

    this.registerEvent(this.app.vault.on("delete", async (file) => {
      if (!(file instanceof TFile)) return;
      delete this.fileMetaStore[file.path];
      delete this.historyStore[file.path];
      await this.savePluginData();
    }));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile)) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof MarkToMindView && view.file?.path === file.path) {
          window.clearTimeout(view._reloadTimer);
          view._reloadTimer = window.setTimeout(() => view.loadFile(), 150);
        }
      }
    }));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async savePluginData() {
    await this.saveData({
      settings: this.settings,
      fileMeta: this.fileMetaStore,
      history: this.historyStore,
    });
  }

  fileMeta(path) {
    if (!path) return { collapsed: {}, relations: [], freeNodes: [], nodeStyles: {}, theme: this.settings?.defaultTheme || "normal" };
    this.fileMetaStore[path] = this.fileMetaStore[path] || {};
    const meta = this.fileMetaStore[path];
    meta.collapsed = meta.collapsed || {};
    meta.relations = meta.relations || [];
    meta.freeNodes = meta.freeNodes || [];
    meta.nodeStyles = meta.nodeStyles || {};
    meta.theme = meta.theme || this.settings.defaultTheme || "normal";
    return meta;
  }

  recordHistory(path, content) {
    if (!path || typeof content !== "string") return;
    const history = this.historyStore[path] || (this.historyStore[path] = []);
    const last = history[history.length - 1];
    if (last?.content === content) return;
    history.push({ time: Date.now(), content });
    const limit = Math.max(5, Number(this.settings.historyLimit) || 30);
    if (history.length > limit) history.splice(0, history.length - limit);
  }

  showHistory(file) {
    if (!(file instanceof TFile)) {
      new Notice(ui(this, "请先打开一个 MarkToMind 文件。", "Open a MarkToMind file first."));
      return;
    }
    new HistoryModal(this.app, this, file, this.historyStore[file.path] || []).open();
  }

  async restoreHistory(file, index) {
    const entry = this.historyStore[file.path]?.[index];
    if (!entry) return;
    const current = await this.app.vault.read(file);
    this.recordHistory(file.path, current);
    await this.app.vault.modify(file, entry.content);
    await this.savePluginData();
    await this.refreshViews(file.path);
    new Notice(ui(this, "恢复快照已还原。", "Recovery snapshot restored."));
  }

  async prompt(title, value = "", multiline = false, placeholder = "") {
    const modal = new PromptModal(this.app, {
      title,
      value,
      multiline,
      placeholder,
      submitText: ui(this, "确定", "OK"),
      cancelText: ui(this, "取消", "Cancel"),
    });
    this.activePrompt = modal;
    try {
      return await modal.wait();
    } finally {
      if (this.activePrompt === modal) this.activePrompt = null;
    }
  }

  cancelActivePrompt() {
    this.activePrompt?.close();
  }

  activeFile() {
    return this.app.workspace.getActiveFile();
  }

  async openActive(mode = "mindmap") {
    const file = this.activeFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice(ui(this, "请先打开一个 Markdown 笔记。", "Open a Markdown note first."));
      return;
    }
    await this.openFile(file, mode);
  }

  async openFile(file, mode = "mindmap") {
    const leaf = this.app.workspace.getLeaf(true);
    const content = await this.app.vault.read(file);
    const parsed = parseMindmapMarkdown(content, file.basename);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: {
        file: file.path,
        mode,
        layout: canonicalLayout(this.fileMeta(file.path).layout || parsed.declaredLayout || this.settings.defaultLayout),
      },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async createMindmap(mode = "basic", folder = null) {
    const parent = folder instanceof TFolder
      ? folder
      : (this.activeFile()?.parent || this.app.vault.getRoot());
    const prefix = this.settings.uiLanguage === "zh-CN"
      ? (mode === "rich" ? "Rich 思维导图" : mode === "markdown" ? "Markdown 思维导图" : "思维导图")
      : (mode === "rich" ? "Rich MindMap" : mode === "markdown" ? "Markdown MindMap" : "MindMap");
    const path = await this.uniqueVaultPath(parent.path, prefix, "md");
    const root = this.settings.uiLanguage === "zh-CN" ? "主主题" : "Main Topic";
    const branch = this.settings.uiLanguage === "zh-CN" ? "分支" : "Branch";
    const body = `---\nmindmap-plugin: ${mode}\nmarktomind: true\nmindmap-layout: ${markmindLayoutName(this.settings.defaultLayout)}\n---\n# ${root} ^${makeId()}\n- ${branch} 1 ^${makeId()}\n- ${branch} 2 ^${makeId()}\n`;
    const file = await this.app.vault.create(path, body);
    await this.openFile(file, "mindmap");
    return file;
  }

  async convertActive(mode) {
    const file = this.activeFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice(ui(this, "请先打开一个 Markdown 笔记。", "Open a Markdown note first."));
      return;
    }
    const original = await this.app.vault.read(file);
    this.recordHistory(file.path, original);
    const parsed = splitFrontmatter(original);
    const frontmatter = mergeFrontmatter(parsed.frontmatter, { "mindmap-plugin": mode, "marktomind": "true" });
    await this.app.vault.modify(file, `---\n${frontmatter}\n---\n${parsed.body}`);
    await this.savePluginData();
    new Notice(ui(this, `已转换为 ${mode} 模式。`, `Converted to ${mode} mode.`));
  }

  registerCommands() {
    const T = (zh, en) => ui(this, zh, en);
    this.addCommand({ id: "add-child-node", name: T("添加子节点", "Add child node"), callback: () => this.activeMarkToMindView()?.addChild() });
    this.addCommand({ id: "add-sibling-node", name: T("添加同级节点", "Add sibling node"), callback: () => this.activeMarkToMindView()?.addSibling() });
    this.addCommand({ id: "edit-node", name: T("编辑节点", "Edit node"), callback: () => this.activeMarkToMindView()?.editSelected() });
    this.addCommand({ id: "cancel-edit-node", name: T("取消编辑节点", "Cancel edit node"), callback: () => this.cancelActivePrompt() });
    this.addCommand({ id: "delete-node", name: T("删除节点", "Delete node"), callback: () => this.activeMarkToMindView()?.deleteSelected() });
    this.addCommand({ id: "undo-node", name: T("撤销", "Undo"), callback: () => this.activeMarkToMindView()?.undo() });
    this.addCommand({ id: "redo-node", name: T("重做", "Redo"), callback: () => this.activeMarkToMindView()?.redo() });
    this.addCommand({ id: "toggle-search-box", name: T("切换节点搜索框", "Toggle search box"), callback: () => this.activeMarkToMindView()?.toggleSearchBox() });
    this.addCommand({ id: "center-mindmap", name: T("居中思维导图", "Set mind map to center"), callback: () => this.activeMarkToMindView()?.centerMindmap() });
    this.addCommand({ id: "layout-mindmap", name: T("布局：双向导图", "Change layout to mind map"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("m") });
    this.addCommand({ id: "layout-right", name: T("布局：向右", "Change layout to right"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("r") });
    this.addCommand({ id: "layout-left", name: T("布局：向左", "Change layout to left"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("l") });
    this.addCommand({ id: "layout-up", name: T("布局：向上", "Change layout to up"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("u") });
    this.addCommand({ id: "layout-down", name: T("布局：向下", "Change layout to down"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("d") });
    this.addCommand({ id: "layout-tree", name: T("布局：树状", "Change layout to tree"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("j") });
    this.addCommand({ id: "layout-vertical", name: T("布局：垂直", "Change layout to vertical"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("k") });
    this.addCommand({ id: "layout-fish-right", name: T("布局：右鱼骨", "Change layout to fish right"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("q") });
    this.addCommand({ id: "layout-fish-left", name: T("布局：左鱼骨", "Change layout to fish left"), callback: () => this.activeMarkToMindView()?.setShortcutLayout("t") });
    this.addCommand({ id: "open-mindmap", name: T("以思维导图打开当前笔记", "Open active note as mind map"), callback: () => this.openActive("mindmap") });
    this.addCommand({ id: "open-outline", name: T("以大纲打开当前笔记", "Open active note as outline"), callback: () => this.openActive("outline") });
    this.addCommand({ id: "open-table", name: T("以表格打开当前笔记", "Open active note as table"), callback: () => this.openActive("table") });
    this.addCommand({ id: "create-basic", name: T("新建 Basic 思维导图", "Create basic mind map"), callback: () => this.createMindmap("basic") });
    this.addCommand({ id: "create-markdown", name: T("新建 Markdown 思维导图", "Create Markdown mind map"), callback: () => this.createMindmap("markdown") });
    this.addCommand({ id: "create-rich", name: T("新建 Rich 思维导图", "Create rich mind map"), callback: () => this.createMindmap("rich") });
    this.addCommand({ id: "convert-basic", name: T("当前笔记转换为 Basic 模式", "Convert active note to basic mode"), callback: () => this.convertActive("basic") });
    this.addCommand({ id: "convert-rich", name: T("当前笔记转换为 Rich 模式", "Convert active note to rich mode"), callback: () => this.convertActive("rich") });
    this.addCommand({ id: "convert-markdown", name: T("当前笔记转换为 Markdown 思维导图模式", "Convert active note to Markdown mind-map mode"), callback: () => this.convertActive("markdown") });
    this.addCommand({ id: "create-pdf-companion", name: T("创建 PDF 标注伴随笔记", "Create PDF annotation companion note"), callback: () => this.createPdfCompanion() });
    this.addCommand({ id: "open-annotation-target", name: T("打开当前笔记的 annotate-target", "Open annotate-target of active note"), callback: () => this.openAnnotationTarget() });
    this.addCommand({ id: "import-xmind", name: T("导入 XMind 文件", "Import XMind file"), callback: () => this.pickXmindFile() });
    this.addCommand({ id: "generate-ai-mindmap", name: T("使用已配置 AI 生成思维导图", "Generate mind map with configured AI"), callback: () => this.generateAiMindmap() });
    this.addCommand({ id: "ai-inspiration", name: T("为选中节点获取 AI 灵感", "Get AI inspiration for selected node"), callback: () => this.aiInspiration() });
    this.addCommand({ id: "translate-selected-node-ai", name: T("使用 AI 翻译选中节点", "Translate selected MarkToMind node with configured AI"), callback: () => this.translateSelectedNode() });
    this.addCommand({ id: "show-recovery", name: T("显示恢复历史", "Show recovery history"), callback: () => this.showHistory(this.activeFile()) });
    this.addCommand({ id: "expand-level-1", name: T("展开到第 1 层", "Expand mind map to level 1"), callback: () => this.activeMarkToMindView()?.expandToLevel(1) });
    this.addCommand({ id: "expand-level-2", name: T("展开到第 2 层", "Expand mind map to level 2"), callback: () => this.activeMarkToMindView()?.expandToLevel(2) });
    this.addCommand({ id: "expand-level-3", name: T("展开到第 3 层", "Expand mind map to level 3"), callback: () => this.activeMarkToMindView()?.expandToLevel(3) });
    this.addCommand({ id: "expand-level-4", name: T("展开到第 4 层", "Expand mind map to level 4"), callback: () => this.activeMarkToMindView()?.expandToLevel(4) });
    this.addCommand({ id: "expand-level-5", name: T("展开到第 5 层", "Expand mind map to level 5"), callback: () => this.activeMarkToMindView()?.expandToLevel(5) });
    this.addCommand({ id: "expand-all", name: T("展开全部节点", "Expand all mind-map nodes"), callback: () => this.activeMarkToMindView()?.expandToLevel(Infinity) });
  }

  activeMarkToMindView() {
    const leaf = this.app.workspace.activeLeaf;
    return leaf?.view instanceof MarkToMindView ? leaf.view : null;
  }

  registerMenus() {
    const T = (zh, en) => ui(this, zh, en);
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFolder) {
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(T("新建 MarkToMind 思维导图", "New MarkToMind mind map")).setIcon("git-fork").onClick(() => this.createMindmap("basic", file)));
        menu.addItem((item) => item.setTitle(T("新建 MarkToMind Rich 思维导图", "New MarkToMind rich mind map")).setIcon("network").onClick(() => this.createMindmap("rich", file)));
        return;
      }
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(T("在 MarkToMind 中打开", "Open in MarkToMind")).setIcon("git-fork").onClick(() => this.openFile(file, "mindmap")));
      menu.addItem((item) => item.setTitle(T("以 MarkToMind 大纲打开", "Open as MarkToMind outline")).setIcon("list-tree").onClick(() => this.openFile(file, "outline")));
      menu.addItem((item) => item.setTitle(T("以 MarkToMind 表格打开", "Open as MarkToMind table")).setIcon("table").onClick(() => this.openFile(file, "table")));
    }));
  }

  registerEmbedding() {
    this.registerMarkdownCodeBlockProcessor("marktomind", async (source, el, ctx) => {
      const parsed = parseMindmapMarkdown(source, "MindMap");
      this.renderStaticTree(parsed.root, el, ctx.sourcePath);
    });

    this.registerMarkdownPostProcessor(async (el, ctx) => {
      if (!this.settings.autoEmbed) return;
      const embeds = [...el.querySelectorAll(".internal-embed")];
      for (const embed of embeds) {
        const src = embed.getAttribute("src") || embed.getAttribute("data-src");
        if (!src) continue;
        const link = src.split("#")[0];
        const target = this.app.metadataCache.getFirstLinkpathDest(link, ctx.sourcePath);
        if (!(target instanceof TFile) || target.extension !== "md") continue;
        const cache = this.app.metadataCache.getFileCache(target);
        if (!cache?.frontmatter?.["mindmap-plugin"] && !cache?.frontmatter?.marktomind) continue;
        try {
          const content = await this.app.vault.cachedRead(target);
          const parsed = parseMindmapMarkdown(content, target.basename);
          embed.empty();
          const wrapper = embed.createDiv({ cls: "mtm-static-embed" });
          this.renderStaticTree(parsed.root, wrapper, target.path);
        } catch (_) {
          // Leave Obsidian's default embed intact on failure.
        }
      }
    });
  }

  renderStaticTree(root, el, sourcePath) {
    const ul = el.createEl("ul", { cls: "mtm-tree-list" });
    const draw = (node, list) => {
      const li = list.createEl("li");
      const box = li.createDiv({ cls: "mtm-node" });
      const content = box.createDiv({ cls: "mtm-node-content" });
      MarkdownRenderer.render(this.app, node.text || "Untitled", content, sourcePath || "", this).catch(() => content.setText(node.text || "Untitled"));
      if (node.children?.length) {
        const childList = li.createEl("ul");
        for (const child of node.children) draw(child, childList);
      }
    };
    draw(root, ul);
  }

  async createPdfCompanion() {
    const pdf = this.activeFile();
    if (!(pdf instanceof TFile) || pdf.extension.toLowerCase() !== "pdf") {
      new Notice(ui(this, "请先打开一个 PDF 文件。", "Open a PDF file first."));
      return;
    }
    const parent = pdf.parent || this.app.vault.getRoot();
    const path = await this.uniqueVaultPath(parent.path, `${pdf.basename}-annotate`, "md");
    const content = `---\nmarktomind: true\nmindmap-plugin: markdown\nannotate-type: pdf\nannotate-target: ${pdf.path}\n---\n# ${pdf.basename} annotations ^${makeId()}\n`;
    const file = await this.app.vault.create(path, content);
    await this.openFile(file, "mindmap");
    new Notice(ui(this, "PDF 标注伴随笔记已创建。可将 PDF++ / Obsidian PDF 链接粘贴到节点中。", "Annotation companion created. Use PDF++/Obsidian PDF links and paste them into nodes."));
  }

  async pickXmindFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xmind,application/zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await this.importXmindFile(file);
    };
    input.click();
  }

  async importXmindFile(file) {
    try {
      const entries = await readZipEntries(await file.arrayBuffer());
      const contentBytes = entries["content.json"];
      const legacyBytes = entries["content.xml"];
      let sheets = [];
      if (contentBytes) {
        const content = JSON.parse(new TextDecoder("utf-8").decode(contentBytes));
        sheets = Array.isArray(content) ? content : (Array.isArray(content?.sheets) ? content.sheets : [content]);
      } else if (legacyBytes) {
        sheets = legacyXmindSheets(new TextDecoder("utf-8").decode(legacyBytes));
      } else {
        throw new Error("This XMind archive has neither content.json nor legacy content.xml.");
      }
      sheets = sheets.filter((sheet) => sheet?.rootTopic);
      if (!sheets.length) throw new Error("No root topic found in XMind file.");

      const imageMap = {};
      const imageFolder = normalizePath(`${this.settings.attachmentFolder || "MarkToMind Assets"}/XMind`);
      await this.ensureFolder(imageFolder);
      for (const [entryName, bytes] of Object.entries(entries)) {
        if (!/^resources\//i.test(entryName) || !/\.(png|jpe?g|gif|webp|svg)$/i.test(entryName)) continue;
        const extension = (entryName.match(/\.([A-Za-z0-9]+)$/)?.[1] || "png").toLowerCase();
        const base = sanitizeFileName(entryName.split("/").pop().replace(/\.[^.]+$/, ""));
        const saved = await this.uniqueVaultPath(imageFolder, base, extension);
        await this.app.vault.createBinary(saved, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        imageMap[entryName] = saved;
      }

      const parent = this.activeFile()?.parent || this.app.vault.getRoot();
      const baseName = sanitizeFileName(file.name.replace(/\.xmind$/i, "")) || "Imported XMind";
      const createdFiles = [];
      for (let index = 0; index < sheets.length; index += 1) {
        const sheet = sheets[index];
        const rich = { idMap: {}, nodeStyles: {}, freeNodes: [], relations: [], imageMap };
        const tree = xmindTopicToTree(sheet.rootTopic, imageMap, rich);
        collectXmindSheetMetadata(sheet, rich);
        const layout = canonicalLayout(sheet?.marktomind?.layout || sheet?.rootTopic?.structureClass || this.settings.defaultLayout);
        const theme = THEME_NAMES.includes(sheet?.marktomind?.theme) ? sheet.marktomind.theme : this.settings.defaultTheme;
        const sheetTitle = sanitizeFileName(sheet.title || `Sheet ${index + 1}`);
        const targetBase = sheets.length > 1 ? `${baseName} - ${sheetTitle}` : baseName;
        const path = await this.uniqueVaultPath(parent.path, targetBase, "md");
        const body = `---\nmindmap-plugin: rich\nmarktomind: true\nmindmap-layout: ${markmindLayoutName(layout)}\nxmind-image-target: ${imageFolder}\n---\n${serializeTree(tree)}`;
        const created = await this.app.vault.create(path, body);
        const meta = this.fileMeta(created.path);
        meta.nodeStyles = rich.nodeStyles;
        meta.relations = rich.relations;
        meta.freeNodes = [...rich.freeNodes, ...((sheet?.marktomind?.freeNodes || []).map((item) => ({ ...item, id: item.id || makeId() })))];
        meta.layout = layout;
        meta.theme = theme;
        createdFiles.push(created);
      }
      await this.savePluginData();
      await this.openFile(createdFiles[0], "mindmap");
      new Notice(sheets.length > 1
        ? ui(this, `已导入 ${createdFiles.length} 个 XMind 工作表。`, `Imported ${createdFiles.length} XMind sheets.`)
        : `${ui(this, "已导入 XMind", "Imported XMind")}: ${createdFiles[0].path}`);
    } catch (error) {
      console.error("MarkToMind XMind import failed", error);
      new Notice(`${ui(this, "XMind 导入失败", "XMind import failed")}: ${error.message || error}`);
    }
  }

  async openAnnotationTarget() {
    const file = this.activeFile();
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const content = await this.app.vault.read(file);
    const target = parseMindmapMarkdown(content, file.basename).annotateTarget;
    if (!target) {
      new Notice(ui(this, "frontmatter 中没有找到 annotate-target。", "No annotate-target found in frontmatter."));
      return;
    }
    if (/^https?:\/\//i.test(target)) window.open(target, "_blank", "noopener,noreferrer");
    else await this.app.workspace.openLinkText(target, file.path, true);
  }

  async generateAiMindmap() {
    if (!this.settings.aiEndpoint || !this.settings.aiModel) {
      new Notice(ui(this, "请先在 MarkToMind 设置中配置 AI 接口和模型。", "Configure the AI endpoint and model in MarkToMind settings first."));
      return;
    }
    let seed = "";
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (markdownView?.editor) seed = markdownView.editor.getSelection()?.trim() || "";
    if (!seed) seed = await this.prompt(ui(this, "生成思维导图", "Generate mind map"), "", true, ui(this, "描述主题或粘贴原始文本", "Describe the topic or paste source text"));
    if (!seed) return;
    const system = "Return only a Markdown outline suitable for a mind map. Use one # heading as the root and nested '-' list items. Keep each node concise. Do not use a code fence.";
    try {
      const result = await this.callAi(system, seed);
      const parent = this.activeFile()?.parent || this.app.vault.getRoot();
      const path = await this.uniqueVaultPath(parent.path, "AI MindMap", "md");
      const cleaned = result.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const body = /^#\s/m.test(cleaned) ? cleaned : `# Main Topic\n- ${cleaned.replace(/\n+/g, "\n- ")}`;
      const content = `---\nmindmap-plugin: basic\nmarktomind: true\nmindmap-layout: ${this.settings.defaultLayout}\n---\n${body}\n`;
      const file = await this.app.vault.create(path, content);
      await this.openFile(file, "mindmap");
    } catch (error) {
      console.error("MarkToMind AI generation failed", error);
      new Notice(`${ui(this, "AI 请求失败", "AI request failed")}: ${error.message || error}`);
    }
  }

  async aiInspiration() {
    const view = this.activeMarkToMindView();
    if (!view) {
      new Notice(ui(this, "请先打开 MarkToMind 视图并选择一个节点。", "Open a MarkToMind view and select a node first."));
      return;
    }
    const node = findNode(view.tree, view.selectedNodeId);
    if (!node) return;
    try {
      const result = await this.callAi("Suggest 3-6 concise child branches for the user's mind-map node. Return only a Markdown '-' list, one branch per line.", node.text);
      const children = result.split("\n").map((line) => line.replace(/^\s*[-*+]\s+/, "").trim()).filter(Boolean);
      if (!children.length) throw new Error("The endpoint returned no branches.");
      view.pushUndo();
      node.children = node.children || [];
      for (const text of children) node.children.push({ id: makeId(), text, children: [], collapsed: false });
      node.collapsed = false;
      await view.commitTree();
    } catch (error) {
      new Notice(`${ui(this, "AI 请求失败", "AI request failed")}: ${error.message || error}`);
    }
  }

  async translateSelectedNode() {
    const view = this.app.workspace.getActiveViewOfType(MarkToMindView);
    if (!(view instanceof MarkToMindView)) {
      new Notice(ui(this, "请先打开 MarkToMind 视图并选择一个节点。", "Open a MarkToMind view and select a node first."));
      return;
    }
    const node = findNode(view.tree, view.selectedNodeId);
    if (!node) return;
    const language = await this.prompt(ui(this, "翻译选中节点", "Translate selected node"), ui(this, "简体中文", "Chinese"), false, ui(this, "目标语言", "Target language"));
    if (!language) return;
    try {
      const translated = await this.callAi(`Translate the user's text into ${language}. Return only the translation. Preserve Markdown links.`, node.text);
      view.pushUndo();
      node.text = translated.trim();
      await view.commitTree();
    } catch (error) {
      new Notice(`${ui(this, "AI 请求失败", "AI request failed")}: ${error.message || error}`);
    }
  }

  async callAi(system, user) {
    const headers = { "Content-Type": "application/json" };
    if (this.settings.aiApiKey) headers.Authorization = `Bearer ${this.settings.aiApiKey}`;
    const response = await requestUrl({
      url: this.settings.aiEndpoint,
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.settings.aiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${response.text?.slice(0, 300) || "request failed"}`);
    const json = response.json || JSON.parse(response.text || "{}");
    const text = json.choices?.[0]?.message?.content
      || json.output_text
      || json.output?.[0]?.content?.[0]?.text
      || json.content?.[0]?.text;
    if (!text) throw new Error("The endpoint returned no text output.");
    return text;
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path || "");
    if (!normalized) return;
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  async saveAttachment(file) {
    const folder = normalizePath(this.settings.attachmentFolder || "MarkToMind Assets");
    await this.ensureFolder(folder);
    const extension = (file.name.split(".").pop() || file.type.split("/").pop() || "png").replace(/[^A-Za-z0-9]/g, "") || "png";
    const base = sanitizeFileName(file.name.replace(/\.[^.]+$/, "") || `image-${Date.now()}`);
    const path = await this.uniqueVaultPath(folder, base, extension);
    await this.app.vault.createBinary(path, await file.arrayBuffer());
    return path;
  }

  async uniqueVaultPath(folder, base, extension) {
    const normalizedFolder = normalizePath(folder || "");
    const safeBase = sanitizeFileName(base);
    let index = 0;
    while (true) {
      const suffix = index ? ` ${index + 1}` : "";
      const name = `${safeBase}${suffix}.${extension}`;
      const path = normalizePath(normalizedFolder ? `${normalizedFolder}/${name}` : name);
      if (!this.app.vault.getAbstractFileByPath(path)) return path;
      index += 1;
    }
  }

  async writeAdjacentText(file, suffix, extension, content) {
    const parent = file.parent?.path || "";
    const path = await this.uniqueVaultPath(parent, `${file.basename}-${suffix}`, extension);
    await this.app.vault.create(path, content);
    return path;
  }

  async writeAdjacentBinary(file, suffix, extension, bytes, options = {}) {
    const parent = file.parent?.path || "";
    const base = suffix ? `${file.basename}-${suffix}` : file.basename;
    const overwrite = !!options.overwrite;
    const exactPath = normalizePath(parent ? `${parent}/${base}.${extension}` : `${base}.${extension}`);
    const path = overwrite ? exactPath : await this.uniqueVaultPath(parent, base, extension);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (overwrite && existing instanceof TFile) await this.app.vault.modifyBinary(existing, arrayBuffer);
    else if (overwrite && existing) throw new Error(`Cannot overwrite non-file path: ${path}`);
    else await this.app.vault.createBinary(path, arrayBuffer);
    return path;
  }

  async refreshViews(path = null) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkToMindView && (!path || view.file?.path === path)) await view.loadFile();
    }
  }
}

module.exports = MarkToMindPlugin;
