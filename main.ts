import {
	App,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";

const VIEW_TYPE_DOODLE = "free-doodle-view";
const BLOCK_LANG = "free-doodle";
const FRONT_KEY = "free-doodle";

function toBase64(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

function fromBase64(b64: string): string {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

interface Point {
	x: number;
	y: number;
}

interface Stroke {
	color: string;
	size: number;
	erase: boolean;
	points: Point[];
	/** 形状：矩形 / 椭圆（points 为 [起点, 终点]） */
	shape?: DrawShape;
	/** 不透明度 0.1 - 1，仅非擦除笔生效 */
	alpha?: number;
	/** 文字块指纹（所在段落/行的规范化文本前 80 字符） */
	k?: string;
	/** 同名文字块的出现序号 */
	o?: number;
	/** 捕获时文字块相对画布的位置 */
	rx?: number;
	ry?: number;
}

interface StoredStroke {
	color: string;
	size: number;
	erase: boolean;
	pts: number[][];
	shape?: DrawShape;
	alpha?: number;
	k?: string;
	o?: number;
	rx?: number;
	ry?: number;
}

interface DoodleData {
	v: number;
	w: number;
	h: number;
	strokes: StoredStroke[];
}

interface FreeDoodleSettings {
	penColor: string;
	penSize: number;
	saveFolder: string;
}

const DEFAULT_SETTINGS: FreeDoodleSettings = {
	penColor: "#e03131",
	penSize: 4,
	saveFolder: "涂鸦",
};

const PALETTE = [
	"#1e1e1e",
	"#e03131",
	"#f08c00",
	"#2f9e44",
	"#1971c2",
	"#9c36b5",
];

function isVisible(el: HTMLElement): boolean {
	return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function normText(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

interface CaretHit {
	node: Node;
	offset: number;
}

// 独立接口：不与 Document 交叉，避免合并回库内已弃用的成员声明
interface CaretLegacyDoc {
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

interface CaretModernDoc {
	caretPositionFromPoint?:
		| ((x: number, y: number) => { offsetNode: Node; offset: number } | null)
		| undefined;
}

/**
 * 标准优先的命中测试：caretPositionFromPoint（现代标准），
 * 回退到旧引擎的 caretRangeFromPoint（Obsidian 1.7.x 内核）。
 */
function resolveCaretHit(
	doc: Document,
	x: number,
	y: number
): CaretHit | null {
	const modern = doc as unknown as CaretModernDoc;
	if (typeof modern.caretPositionFromPoint === "function") {
		const pos = modern.caretPositionFromPoint(x, y);
		return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
	}
	const legacy = doc as unknown as CaretLegacyDoc;
	if (!legacy.caretRangeFromPoint) return null;
	const range = legacy.caretRangeFromPoint(x, y);
	return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** 内置诊断日志：环形缓冲，设置页可查看/复制 */
class Diag {
	private static entries: string[] = [];

	static log(msg: string): void {
		const d = new Date();
		const pad = (n: number, l = 2) => String(n).padStart(l, "0");
		const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
			d.getMilliseconds(),
			3
		)}`;
		Diag.entries.push(`[${ts}] ${msg}`);
		if (Diag.entries.length > 400) Diag.entries.shift();
	}

	static dump(): string {
		return Diag.entries.join("\n");
	}

	static clear(): void {
		Diag.entries.length = 0;
	}
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, dx = 0, dy = 0): void {
	ctx.save();
	if (dx !== 0 || dy !== 0) ctx.translate(dx, dy);
	if (s.erase) {
		ctx.globalCompositeOperation = "destination-out";
	} else if (s.alpha !== undefined && s.alpha < 1) {
		ctx.globalAlpha = Math.max(0.05, Math.min(1, s.alpha));
	}
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	if (s.shape === "rect" || s.shape === "ellipse" || s.shape === "diamond") {
		const a = s.points[0];
		const b = s.points[s.points.length - 1];
		if (!a || !b) {
			ctx.restore();
			return;
		}
		ctx.lineWidth = s.size;
		ctx.beginPath();
		if (s.shape === "rect") {
			const x = Math.min(a.x, b.x);
			const y = Math.min(a.y, b.y);
			const w = Math.abs(b.x - a.x);
			const h = Math.abs(b.y - a.y);
			ctx.rect(x, y, w, h);
		} else if (s.shape === "ellipse") {
			const cx = (a.x + b.x) / 2;
			const cy = (a.y + b.y) / 2;
			const rx = Math.max(Math.abs(b.x - a.x) / 2, 0.5);
			const ry = Math.max(Math.abs(b.y - a.y) / 2, 0.5);
			ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
		} else {
			ctx.moveTo((a.x + b.x) / 2, a.y);
			ctx.lineTo(b.x, (a.y + b.y) / 2);
			ctx.lineTo((a.x + b.x) / 2, b.y);
			ctx.lineTo(a.x, (a.y + b.y) / 2);
			ctx.closePath();
		}
		if (s.erase) {
			ctx.fillStyle = "#000";
			ctx.fill();
		} else {
			ctx.strokeStyle = s.color;
			ctx.stroke();
		}
		ctx.restore();
		return;
	}

	if (s.shape === "line" || s.shape === "arrow") {
		const a = s.points[0];
		const b = s.points[s.points.length - 1];
		if (!a || !b) {
			ctx.restore();
			return;
		}
		ctx.lineWidth = s.size;
		ctx.strokeStyle = s.erase ? "#000" : s.color;
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		if (s.shape === "arrow") {
			const ang = Math.atan2(b.y - a.y, b.x - a.x);
			const head = Math.max(12, s.size * 3);
			ctx.moveTo(b.x, b.y);
			ctx.lineTo(
				b.x - head * Math.cos(ang - Math.PI / 7),
				b.y - head * Math.sin(ang - Math.PI / 7)
			);
			ctx.moveTo(b.x, b.y);
			ctx.lineTo(
				b.x - head * Math.cos(ang + Math.PI / 7),
				b.y - head * Math.sin(ang + Math.PI / 7)
			);
		}
		ctx.stroke();
		ctx.restore();
		return;
	}

	if (s.erase) {
		ctx.strokeStyle = "#000";
		ctx.fillStyle = "#000";
	} else {
		ctx.strokeStyle = s.color;
		ctx.fillStyle = s.color;
	}
	ctx.lineWidth = s.size;

	const pts = s.points;
	if (pts.length === 1) {
		ctx.beginPath();
		ctx.arc(pts[0].x, pts[0].y, Math.max(0.5, s.size / 2), 0, Math.PI * 2);
		ctx.fill();
	} else {
		ctx.beginPath();
		ctx.moveTo(pts[0].x, pts[0].y);
		for (let i = 1; i < pts.length - 1; i++) {
			const mx = (pts[i].x + pts[i + 1].x) / 2;
			const my = (pts[i].y + pts[i + 1].y) / 2;
			ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
		}
		const last = pts[pts.length - 1];
		ctx.lineTo(last.x, last.y);
		ctx.stroke();
	}
	ctx.restore();
}

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
	for (const s of strokes) drawStroke(ctx, s);
}

/* ---------- 笔迹美化（去抖 + 平滑拟合） ---------- */

function chaikinOnce(pts: Point[]): Point[] {
	if (pts.length < 3) return pts;
	const out: Point[] = [pts[0]];
	for (let i = 0; i < pts.length - 1; i++) {
		const p = pts[i];
		const q = pts[i + 1];
		out.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
		out.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
	}
	out.push(pts[pts.length - 1]);
	return out;
}

/** RDP 抽稀：去掉手抖产生的高频抖动点 */
function rdpSimplify(pts: Point[], eps: number): Point[] {
	if (pts.length < 3) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length) {
		const [s, e] = stack.pop()!;
		let maxD = -1;
		let idx = -1;
		for (let i = s + 1; i < e; i++) {
			const d = distToSeg(pts[i].x, pts[i].y, pts[s], pts[e]);
			if (d > maxD) {
				maxD = d;
				idx = i;
			}
		}
		if (maxD > eps && idx > 0) {
			keep[idx] = 1;
			stack.push([s, idx], [idx, e]);
		}
	}
	return pts.filter((_, i) => keep[i] === 1);
}

/**
 * 笔迹美化：RDP 去抖（自适应阈值）→ 两轮 Chaikin 平滑。
 * 与渲染层的中点平滑不同，这里先移除抖动再拟合，字迹明显更干净。
 */
function beautifyPoints(pts: Point[]): Point[] {
	if (pts.length < 3) return pts;
	const eps = Math.min(3, Math.max(1.2, pts.length * 0.008));
	const simplified = rdpSimplify(pts, eps);
	let cur = chaikinOnce(simplified);
	cur = chaikinOnce(cur);
	return cur;
}

/* ---------- 形状几何：轮廓采样 / 命中测试 ---------- */

function shapeOutline(s: Stroke): { pts: Point[]; closed: boolean } {
	const a = s.points[0];
	const b = s.points[s.points.length - 1];
	switch (s.shape) {
		case "rect":
			return {
				pts: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }],
				closed: true,
			};
		case "diamond":
			return {
				pts: [
					{ x: (a.x + b.x) / 2, y: a.y },
					{ x: b.x, y: (a.y + b.y) / 2 },
					{ x: (a.x + b.x) / 2, y: b.y },
					{ x: a.x, y: (a.y + b.y) / 2 },
				],
				closed: true,
			};
		case "ellipse": {
			const cx = (a.x + b.x) / 2;
			const cy = (a.y + b.y) / 2;
			const rx = Math.abs(b.x - a.x) / 2;
			const ry = Math.abs(b.y - a.y) / 2;
			const pts: Point[] = [];
			for (let i = 0; i < 24; i++) {
				const t = (i / 24) * Math.PI * 2;
				pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
			}
			return { pts, closed: true };
		}
		default:
			return { pts: [a, b], closed: false };
	}
}

function distToSeg(
	px: number,
	py: number,
	a: Point,
	b: Point
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
	const ct = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (a.x + ct * dx), py - (a.y + ct * dy));
}

function hitShapeOrPath(s: Stroke, px: number, py: number, th: number): boolean {
	if (!s.shape || s.points.length < 2) {
		for (const q of s.points) {
			if (Math.hypot(q.x - px, q.y - py) <= th) return true;
		}
		return false;
	}
	const { pts, closed } = shapeOutline(s);
	for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		if (distToSeg(px, py, a, b) <= th) return true;
	}
	if (!closed) return false;
	// 内部命中
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const xi = pts[i].x;
		const yi = pts[i].y;
		const xj = pts[j].x;
		const yj = pts[j].y;
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

function parseStrokes(data: DoodleData | null): Stroke[] {
	if (!data || !Array.isArray(data.strokes)) return [];
	return data.strokes
		.map((s): Stroke => ({
			color: typeof s.color === "string" ? s.color : "#000000",
			size: Number(s.size) > 0 ? Number(s.size) : 4,
			erase: !!s.erase,
			points: Array.isArray(s.pts)
				? s.pts
						.filter((p) => Array.isArray(p) && p.length >= 2)
						.map((p) => ({ x: p[0], y: p[1] }))
				: [],
			k: typeof s.k === "string" ? s.k : undefined,
			o: typeof s.o === "number" ? s.o : undefined,
			rx: typeof s.rx === "number" ? s.rx : undefined,
			ry: typeof s.ry === "number" ? s.ry : undefined,
			shape:
				s.shape === "rect" ||
				s.shape === "ellipse" ||
				s.shape === "line" ||
				s.shape === "arrow" ||
				s.shape === "diamond"
					? s.shape
					: undefined,
			alpha: typeof s.alpha === "number" ? Math.max(0.05, Math.min(1, s.alpha)) : undefined,
		}))
		.filter((s) => s.points.length > 0);
}

/* ------------------------------------------------------------------ */
/* 墨迹覆盖层：阅读模式自动叠加显示；涂鸦模式下可交互编辑并写回文件        */
/* ------------------------------------------------------------------ */

class InkOverlay {
	private plugin: FreeDoodlePlugin;
	view: MarkdownView;
	file: TFile;
	private interactive: boolean;
	private dirty = false;

	private scroller: HTMLElement | null = null;
	private wrap: HTMLElement | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private toolbar: HTMLElement | null = null;

	private hadStoredData = false;
	private placeholderCreated = false;

	private strokes: Stroke[] = [];
	private undoStack: Stroke[][] = [];
	private current: Stroke | null = null;
	private rect: DOMRect | null = null;

	private tool = {
		color: "#e03131",
		size: 4,
		opacity: 1,
		mode: "pen" as ToolMode,
	};

	private shapeKind: DrawShape = "rect";
	private eraseKind: EraseKind = "px";
	private previewScheduled = false;

	private swatchEls: HTMLElement[] = [];
	private colorInputEl!: HTMLInputElement;
	private sizeSliderEl!: HTMLInputElement;
	private sizeLabelEl!: HTMLElement;
	private opacitySliderEl!: HTMLInputElement;
	private opacityLabelEl!: HTMLElement;
	private toolBtnEls: Record<string, HTMLElement> = {};
	private styleBtnEl!: HTMLElement;
	private micBtnEl!: HTMLElement;
	private widthPresetEls: HTMLElement[] = [];

	private smooth = true;
	private popover: HTMLElement | null = null;
	private popCloser: ((e: MouseEvent) => void) | null = null;
	private recog: SpeechRecLike | null = null;
	private recognizing = false;

	private effSize(): number {
		return this.tool.mode === "hl" ? Math.max(this.tool.size * 4, 12) : this.tool.size;
	}

	private cw = 0;
	private ch = 0;
	private timer: number | null = null;
	private saveTimer: number | null = null;
	private escHandler: ((e: KeyboardEvent) => void) | null = null;
	private destroyed = false;

	constructor(plugin: FreeDoodlePlugin, view: MarkdownView, interactive: boolean) {
		this.plugin = plugin;
		this.view = view;
		this.file = view.file!;
		this.interactive = interactive;
		this.tool.color = plugin.settings.penColor;
		this.tool.size = plugin.settings.penSize;
	}

	async init(): Promise<void> {
		Diag.log(`init ${this.file.path} interactive=${this.interactive}`);
		await this.loadFromNote();
		if (this.destroyed) return;
		// 进入涂鸦模式时先写入属性占位，使布局在绘制前就稳定，避免保存时文本下移导致墨迹错位
		if (this.interactive && !this.hadStoredData) {
			await this.ensurePlaceholder();
			// 等待编辑器渲染属性面板、布局稳定后再挂载画布
			await new Promise((resolve) => window.setTimeout(resolve, 300));
		}
		this.mount();
		this.timer = window.setInterval(this.tick, 400);
		if (this.interactive) this.addEscListener();
	}

	setInteractive(v: boolean): void {
		if (this.interactive === v || this.destroyed) return;
		this.interactive = v;
		if (v) {
			this.addEscListener();
		} else {
			this.removeEscListener();
			this.flushSave();
			void this.cleanupPlaceholder();
		}
		this.mount();
	}

	destroy(save: boolean): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.mo?.disconnect();
		this.mo = undefined;
		this.ro?.disconnect();
		this.ro = undefined;
		this.closePopover();
		try {
			this.recog?.stop();
		} catch {
			/* 忽略停止失败 */
		}
		if (this.timer !== null) window.clearInterval(this.timer);
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.removeEscListener();
		this.unmount();
		if (save && this.dirty) void this.writeNote();
		else void this.cleanupPlaceholder();
	}

	/* ---------- DOM ---------- */

	private findScroller(): HTMLElement | null {
		const content = this.view.contentEl;
		// 根据当前模式决定优先级，避免把画布挂进隐藏容器导致墨迹不可见
		const cm = content.querySelector<HTMLElement>(".cm-scroller");
		const preview = content.querySelector<HTMLElement>(
			".markdown-reading-view .markdown-preview-view"
		);
		const wantPreview = this.view.getMode() === "preview";
		const order = wantPreview ? [preview, cm] : [cm, preview];
		for (const el of order) {
			if (el && isVisible(el)) return el;
		}
		const anyPreview = content.querySelector<HTMLElement>(".markdown-preview-view");
		if (anyPreview && isVisible(anyPreview)) return anyPreview;
		return null;
	}

	private mo?: MutationObserver;
	private ro?: ResizeObserver;

	private watchDom(): void {
		this.mo?.disconnect();
		this.mo = new MutationObserver(() => {
			if (this.destroyed) return;
			// 笔记内容变化后文字块缓存即失效，避免锚定到已分离的旧元素
			this.candCache = null;
			if (!this.canvas || !this.canvas.isConnected) {
				window.requestAnimationFrame(() => {
					if (!this.destroyed && (!this.canvas || !this.canvas.isConnected)) {
						this.mount();
					}
				});
			} else {
				this.applySize();
				this.redraw();
			}
		});
		this.mo.observe(this.view.contentEl, { childList: true, subtree: true });
	}

	private mount(): void {
		if (this.destroyed) return;
		const scroller = this.findScroller();
		if (!scroller) {
			Diag.log("mount 跳过：未找到滚动容器");
			return;
		}
		this.candCache = null;
		Diag.log(
			`mount 容器=${scroller.className.slice(0, 50)} w=${scroller.clientWidth} h=${scroller.scrollHeight} strokes=${this.strokes.length}`
		);

		const content = this.view.contentEl;
		content.addClass("free-doodle-positioned");
		scroller.addClass("free-doodle-positioned");

		if (this.wrap && this.canvas && this.ctx) {
			// 迁移已有画布节点：像素保留，避免重挂载时墨迹短暂消失
			scroller.appendChild(this.wrap);
			this.wrap.toggleClass("is-interactive", this.interactive);
			this.scroller = scroller;
		} else {
			this.unmount();
			this.scroller = scroller;
			const wrap = scroller.createDiv({ cls: "free-doodle-overlay" });
			wrap.toggleClass("is-interactive", this.interactive);
			const canvas = wrap.createEl("canvas", { cls: "free-doodle-canvas" });
			this.wrap = wrap;
			this.canvas = canvas;
			this.ctx = canvas.getContext("2d");
			this.cw = 0;
			this.ch = 0;

			canvas.addEventListener("pointerdown", this.onDown);
			canvas.addEventListener("pointermove", this.onMove);
			canvas.addEventListener("pointerup", this.onUp);
			canvas.addEventListener("pointercancel", this.onCancel);
		}

		this.applySize();
		if (this.interactive && !this.toolbar) this.buildToolbar();
		else if (!this.interactive && this.toolbar) {
			this.toolbar.remove();
			this.toolbar = null;
		}
		this.redraw();
		this.watchDom();

		// 容器尺寸变化（如拖动侧边栏）时立即重绘，保证墨迹丝滑跟随
		if (!this.ro) {
			this.ro = new ResizeObserver(() => {
				if (!this.destroyed) this.applySize();
			});
		}
		this.ro.disconnect();
		this.ro.observe(scroller);
	}

	private unmount(): void {
		this.mo?.disconnect();
		this.mo = undefined;
		this.ro?.disconnect();
		this.wrap?.remove();
		this.toolbar?.remove();
		this.wrap = null;
		this.canvas = null;
		this.ctx = null;
		this.toolbar = null;
		this.current = null;
	}

	private tick = (): void => {
		if (this.destroyed) return;
		// 视图被复用切换到其他文件时，此覆盖层作废，交由 sweep 重建
		if (this.view.file !== this.file) {
			this.plugin.dropOverlay(this);
			return;
		}
		const canvas = this.canvas;
		if (!canvas || !canvas.isConnected || !this.scroller || !isVisible(this.scroller)) {
			this.mount();
			return;
		}
		this.applySize();
	};

	private applySize(): void {
		const scroller = this.scroller;
		const canvas = this.canvas;
		const ctx = this.ctx;
		if (!scroller || !canvas || !ctx) return;
		const w = Math.max(1, scroller.clientWidth);
		const h = Math.max(1, scroller.scrollHeight, scroller.clientHeight);
		if (w === this.cw && h === this.ch) return;
		this.cw = w;
		this.ch = h;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.floor(w * dpr);
		canvas.height = Math.floor(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.redraw();
	}

	/* ---------- 工具栏 ---------- */

	private buildToolbar(): void {
		const tb = this.view.contentEl.createDiv({ cls: "free-doodle-floatbar" });
		this.toolbar = tb;

		const mkBtn = (
			icon: string,
			title: string,
			onClick: () => void,
			cls = "free-doodle-btn clickable-icon"
		): HTMLButtonElement => {
			const b = tb.createEl("button", { cls, attr: { title } });
			setIcon(b, icon);
			b.addEventListener("click", onClick);
			return b;
		};

		const tools = [
			{ id: "pen" as const, icon: "pencil", title: "钢笔" },
			{ id: "hl" as const, icon: "highlighter", title: "荧光笔（半透明）" },
			{ id: "shape" as const, icon: "shapes", title: "形状：直线/箭头/矩形/椭圆/菱形" },
			{ id: "erase" as const, icon: "eraser", title: "橡皮：点击选择 像素/整笔擦除" },
		];
		for (const t of tools) {
			const b = mkBtn(t.icon, t.title, () => this.onToolClick(t.id));
			this.toolBtnEls[t.id] = b;
		}

		tb.createDiv({ cls: "free-doodle-sep" });

		this.styleBtnEl = mkBtn("settings-2", "样式：颜色 / 粗细 / 不透明度 / 笔迹优化", () =>
			this.openStylePopover(this.styleBtnEl)
		);

		tb.createDiv({ cls: "free-doodle-sep" });

		if (SpeechCapable()) {
			this.micBtnEl = mkBtn("mic", "语音转文字（插入到当前笔记）", () =>
				this.toggleVoice()
			);
			this.toolBtnEls["mic"] = this.micBtnEl;
		}

		this.toolBtnEls["undo"] = mkBtn("undo-2", "撤销 (Ctrl+Z)", () => this.undo());
		this.toolBtnEls["trash"] = mkBtn("trash-2", "清空全部墨迹", () => this.clearAll());

		tb.createDiv({ cls: "free-doodle-sep" });

		const doneBtn = tb.createEl("button", {
			cls: "free-doodle-btn mod-cta",
			attr: { title: "完成并保存" },
		});
		setIcon(doneBtn, "check");
		doneBtn.createSpan({ text: "完成" });
		doneBtn.addEventListener("click", () => this.plugin.exitAnnotate());

		this.syncTool();
	}

	private onToolClick(
		id: ToolMode | "erase" | "style" | "mic" | "undo" | "trash"
	): void {
		switch (id) {
			case "style":
				this.openStylePopover(this.styleBtnEl);
				return;
			case "shape":
				this.openShapePopover(this.toolBtnEls["shape"] ?? this.toolbar);
				return;
			case "erase":
				this.openErasePopover(this.toolBtnEls["erase"] ?? this.toolbar);
				return;
			case "mic":
				this.toggleVoice();
				return;
			case "undo":
				this.undo();
				return;
			case "trash":
				this.clearAll();
				return;
			default:
				this.setMode(id);
		}
	}

	private closePopover(): void {
		this.popover?.remove();
		this.popover = null;
		if (this.popCloser) {
			window.removeEventListener("pointerdown", this.popCloser, true);
			this.popCloser = null;
		}
	}

	private openPopover(
		anchor: HTMLElement,
		build: (el: HTMLElement) => void
	): void {
		this.closePopover();
		const content = this.view.contentEl;
		const pop = content.createDiv({ cls: "free-doodle-popover" });
		this.popover = pop;
		build(pop);
		const aRect = anchor.getBoundingClientRect();
		const cRect = content.getBoundingClientRect();
		pop.style.left = `${Math.max(4, Math.round(aRect.left - cRect.left))}px`;
		pop.style.top = `${Math.round(aRect.bottom - cRect.top + 6)}px`;
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover && !this.popover.contains(t) && !anchor.contains(t)) {
				this.closePopover();
			}
		};
		this.popCloser = closer;
		window.setTimeout(() => window.addEventListener("pointerdown", closer, true), 0);
	}

	private openStylePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			el.addClass("free-doodle-style-pop");
			this.swatchEls = [];
			this.widthPresetEls = [];
			const colors = el.createDiv({ cls: "free-doodle-pop-row" });
			for (const c of PALETTE) {
				const b = colors.createEl("button", {
					cls: "free-doodle-swatch",
					attr: { title: c },
				});
				b.dataset.color = c;
				b.addEventListener("click", () => {
					this.tool.color = c;
					if (this.isEraseMode()) this.setMode("pen");
					else this.syncTool();
				});
				this.swatchEls.push(b);
			}
			this.colorInputEl = colors.createEl("input", {
				cls: "free-doodle-color-input",
				type: "color",
				attr: { title: "自定义颜色" },
			});
			this.colorInputEl.value = this.tool.color;
			this.colorInputEl.addEventListener("input", () => {
				this.tool.color = this.colorInputEl.value;
				if (this.isEraseMode()) this.setMode("pen");
				else this.syncTool();
			});

			const sizeRow = el.createDiv({ cls: "free-doodle-pop-row" });
			sizeRow.createSpan({ cls: "free-doodle-pop-label", text: "粗细" });
			for (const [label, val] of [
				["细", 2],
				["中", 5],
				["粗", 10],
			] as const) {
				const b = sizeRow.createEl("button", {
					cls: "free-doodle-btn free-doodle-wpreset",
					text: label,
				});
				b.dataset.size = String(val);
				b.addEventListener("click", () => {
					this.tool.size = val;
					this.syncTool();
				});
				this.widthPresetEls.push(b);
			}

			const opRow = el.createDiv({ cls: "free-doodle-pop-row" });
			opRow.createSpan({ cls: "free-doodle-pop-label", text: "不透明" });
			this.opacitySliderEl = opRow.createEl("input", {
				cls: "free-doodle-slider",
				type: "range",
				attr: { min: "10", max: "100", step: "5" },
			});
			this.opacitySliderEl.value = String(Math.round(this.tool.opacity * 100));
			this.opacityLabelEl = opRow.createSpan({
				cls: "free-doodle-size-label",
				text: `${Math.round(this.tool.opacity * 100)}%`,
			});
			this.opacitySliderEl.addEventListener("input", () => {
				this.tool.opacity = Number(this.opacitySliderEl.value) / 100;
				this.opacityLabelEl.setText(`${this.opacitySliderEl.value}%`);
			});

			const smRow = el.createDiv({ cls: "free-doodle-pop-row" });
			smRow.createSpan({ cls: "free-doodle-pop-label", text: "优化" });
			const smBtn = smRow.createEl("button", {
				cls: "free-doodle-btn clickable-icon",
				attr: { title: "笔迹平滑（去抖动）" },
			});
			setIcon(smBtn, "sparkles");
			smBtn.toggleClass("is-active", this.smooth);
			smBtn.addEventListener("click", () => {
				this.smooth = !this.smooth;
				smBtn.toggleClass("is-active", this.smooth);
			});
			this.syncTool();
		});
	}

	private openShapePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			const defs = [
				{ shape: "line" as DrawShape, icon: "minus", title: "直线" },
				{ shape: "arrow" as DrawShape, icon: "arrow-up-right", title: "箭头" },
				{ shape: "rect" as DrawShape, icon: "square", title: "矩形" },
				{ shape: "ellipse" as DrawShape, icon: "circle", title: "椭圆" },
				{ shape: "diamond" as DrawShape, icon: "diamond", title: "菱形" },
			];
			for (const d of defs) {
				const b = el.createEl("button", {
					cls: "free-doodle-btn clickable-icon free-doodle-pop-item",
					attr: { title: d.title },
				});
				setIcon(b, d.icon);
				b.toggleClass("is-active", this.tool.mode === "shape" && this.shapeKind === d.shape);
				b.addEventListener("click", () => {
					this.shapeKind = d.shape;
					this.setMode("shape");
					this.closePopover();
				});
			}
		});
	}

	private openErasePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			const defs = [
				{ kind: "px" as EraseKind, mode: "erasePx" as ToolMode, icon: "eraser", title: "像素擦除（擦掉划过的区域）" },
				{ kind: "stroke" as EraseKind, mode: "eraseStroke" as ToolMode, icon: "scissors", title: "整笔擦除（删除碰到的整笔）" },
			];
			for (const d of defs) {
				const b = el.createEl("button", {
					cls: "free-doodle-btn clickable-icon free-doodle-pop-item",
					attr: { title: d.title },
				});
				setIcon(b, d.icon);
				b.toggleClass("is-active", this.eraseKind === d.kind);
				b.addEventListener("click", () => {
					this.eraseKind = d.kind;
					this.setMode(d.mode);
					this.closePopover();
				});
			}
		});
	}

	private setMode(mode: ToolMode): void {
		this.tool.mode = mode;
		// 切到荧光笔时若不透明度过高，自动降为典型荧光笔透明度
		if (mode === "hl" && this.tool.opacity > 0.6) {
			this.tool.opacity = 0.35;
			if (this.opacitySliderEl) {
				this.opacitySliderEl.value = String(Math.round(this.tool.opacity * 100));
			}
		}
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		this.syncTool();
	}

	private isEraseMode(): boolean {
		return this.tool.mode === "erasePx" || this.tool.mode === "eraseStroke";
	}

	private syncTool(): void {
		const eraseActive = this.isEraseMode();
		this.swatchEls.forEach((el) =>
			el.toggleClass(
				"is-active",
				!eraseActive &&
					(el.dataset.color ?? "").toLowerCase() === this.tool.color.toLowerCase()
			)
		);
		this.widthPresetEls.forEach((el) =>
			el.toggleClass("is-active", Number(el.dataset.size) === this.tool.size)
		);
		const shapeBtn = this.toolBtnEls["shape"];
		if (shapeBtn) {
			setIcon(shapeBtn, "shapes");
			shapeBtn.toggleClass("is-active", this.tool.mode === "shape");
		}
		const eraseBtn = this.toolBtnEls["erase"];
		if (eraseBtn) {
			setIcon(eraseBtn, this.eraseKind === "px" ? "eraser" : "scissors");
			eraseBtn.toggleClass("is-active", eraseActive);
		}
		const penBtn = this.toolBtnEls["pen"];
		if (penBtn) penBtn.toggleClass("is-active", this.tool.mode === "pen");
		const hlBtn = this.toolBtnEls["hl"];
		if (hlBtn) hlBtn.toggleClass("is-active", this.tool.mode === "hl");
		const micBtn = this.toolBtnEls["mic"];
		if (micBtn) micBtn.toggleClass("is-active", this.recognizing);
		if (this.colorInputEl) this.colorInputEl.value = this.tool.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.tool.size);
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		if (this.opacitySliderEl)
			this.opacitySliderEl.value = String(Math.round(this.tool.opacity * 100));
		if (this.opacityLabelEl)
			this.opacityLabelEl.setText(`${Math.round(this.tool.opacity * 100)}%`);
	}

	private toggleVoice(): void {
		if (this.recognizing) {
			this.recog?.stop();
			return;
		}
		const Ctor = GetSpeechRecognitionCtor();
		if (!Ctor) {
			new Notice("当前环境不支持语音识别");
			return;
		}
		const r = new Ctor();
		r.lang = "zh-CN";
		r.continuous = true;
		r.interimResults = false;
		r.onresult = (ev: SpeechRecEvent) => {
			let txt = "";
			for (let i = ev.resultIndex; i < ev.results.length; i++) {
				const item = ev.results[i];
				if (item.isFinal && item[0]?.transcript) txt += item[0].transcript;
			}
			if (txt.trim()) this.view.editor.replaceSelection(txt + " ");
		};
		r.onerror = (ev: { error: string }) => {
			Diag.log(`voice error: ${ev.error}`);
			if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
				new Notice("语音识别权限被拒绝，请在系统设置中允许麦克风");
			} else if (ev.error === "no-speech") {
				new Notice("未检测到语音");
			} else if (ev.error !== "aborted") {
				new Notice(`语音识别出错：${ev.error}`);
			}
		};
		r.onend = () => {
			this.recognizing = false;
			this.syncTool();
		};
		try {
			r.start();
			this.recog = r;
			this.recognizing = true;
			this.syncTool();
			new Notice("语音输入中…再次点击麦克风结束");
		} catch (err) {
			Diag.log(`voice start failed: ${String(err)}`);
			new Notice("语音启动失败，详见控制台");
		}
	}

	/* ---------- 绘制 ---------- */

	private toPoint(evt: PointerEvent): Point {
		const canvas = this.canvas;
		const r = this.rect ?? canvas!.getBoundingClientRect();
		return { x: evt.clientX - r.left, y: evt.clientY - r.top };
	}

	private onDown = (evt: PointerEvent): void => {
		if (!this.interactive) return;
		const canvas = this.canvas;
		if (!canvas || !evt.isPrimary) return;
		this.rect = canvas.getBoundingClientRect();
		canvas.setPointerCapture(evt.pointerId);
		const p = this.toPoint(evt);

		if (this.tool.mode === "eraseStroke") {
			this.strokeEraseUndoArmed = true;
			this.removeStrokesNear(p);
			return;
		}

		const erase = this.tool.mode === "erasePx";
		this.current = {
			color: this.tool.color,
			size: this.effSize(),
			erase,
			alpha: erase ? undefined : this.tool.opacity,
			points: [p],
			shape: this.tool.mode === "shape" ? this.shapeKind : undefined,
		};
	};

	private strokeEraseUndoArmed = false;

	private removeStrokesNear(p: Point): number {
		const entries = this.getCandidateEntries();
		let removed = 0;
		for (let i = this.strokes.length - 1; i >= 0; i--) {
			const s = this.strokes[i];
			if (s.erase) continue;
			const { dx, dy } = this.findBlockDeltaIn(entries, s);
			const th = Math.max(10, s.size) + 6;
			const px = p.x - dx;
			const py = p.y - dy;
			let hit = false;
			if (!s.shape) {
				for (const q of s.points) {
					const ddx = q.x - px;
					const ddy = q.y - py;
					if (ddx * ddx + ddy * ddy <= th * th) {
						hit = true;
						break;
					}
				}
			} else {
				hit = hitShapeOrPath(s, px, py, th);
			}
			if (hit) {
				if (this.strokeEraseUndoArmed) {
					this.undoStack.push(this.strokes.slice());
					if (this.undoStack.length > 50) this.undoStack.shift();
					this.strokeEraseUndoArmed = false;
				}
				this.strokes.splice(i, 1);
				removed++;
			}
		}
		if (removed > 0) {
			this.redraw();
			this.scheduleSave();
		}
		return removed;
	}

	private schedulePreview(): void {
		if (this.previewScheduled) return;
		this.previewScheduled = true;
		window.requestAnimationFrame(() => {
			this.previewScheduled = false;
			const s = this.current;
			const ctx = this.ctx;
			if (!s || !ctx || this.destroyed) return;
			let draw = s;
			// 拖动中实时预览美化结果（自由笔迹 + 开启优化时）
			if (!s.erase && !s.shape && this.smooth && s.points.length > 6 && s.points.length < 4000) {
				draw = { ...s, points: beautifyPoints(s.points) };
			}
			this.redraw();
			drawStroke(ctx, draw);
		});
	}

	private onMove = (evt: PointerEvent): void => {
		const s = this.current;
		if (!evt.isPrimary) return;

		if (!s && this.interactive && this.tool.mode === "eraseStroke") {
			this.removeStrokesNear(this.toPoint(evt));
			return;
		}
		if (!s) return;

		if (s.shape) {
			s.points[1] = this.toPoint(evt);
		} else {
			s.points.push(this.toPoint(evt));
		}
		this.schedulePreview();
	};

	private onUp = (): void => {
		const s = this.current;
		if (!s) return;
		this.current = null;

		// 形状拖动距离过小则丢弃
		if (s.shape && s.points.length >= 2) {
			const a = s.points[0];
			const b = s.points[s.points.length - 1];
			if (Math.abs(b.x - a.x) < 4 && Math.abs(b.y - a.y) < 4) return;
		}

		// 笔迹优化：自由笔迹做去抖 + 平滑拟合
		let final: Stroke = s;
		if (!s.erase && !s.shape && this.smooth && s.points.length > 2) {
			final = { ...s, points: beautifyPoints(s.points) };
		}

		this.attachAnchor(final);
		this.undoStack.push(this.strokes.slice());
		if (this.undoStack.length > 50) this.undoStack.shift();
		this.strokes.push(final);
		this.redraw();
		this.scheduleSave();
	};

	private onCancel = (): void => {
		this.current = null;
	};

	private undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.strokes = prev;
		this.redraw();
		this.scheduleSave();
	}

	private clearAll(): void {
		if (!this.strokes.length) return;
		this.undoStack.push(this.strokes.slice());
		this.strokes = [];
		this.redraw();
		this.flushSave();
	}

	clearAllForRemove(): void {
		this.strokes = [];
		this.undoStack = [];
		this.redraw();
		this.dirty = true;
		this.flushSave();
		new Notice("已清除该笔记的涂鸦数据");
	}

	private redraw(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.clearRect(0, 0, this.cw, this.ch);
		if (!this.strokes.length) return;
		const entries = this.getCandidateEntries();
		for (const s of this.strokes) {
			const { dx, dy } = this.findBlockDeltaIn(entries, s);
			drawStroke(ctx, s, dx, dy);
		}
	}

	private static readonly BLOCK_SEL = ".cm-line, p, li, h1, h2, h3, h4, h5, h6";

	private static blockKey(el: HTMLElement): string {
		return normText(el.textContent ?? "").slice(0, 80);
	}

	private candCache: { el: HTMLElement; key: string }[] | null = null;

	/** 候选文字块及其 key 缓存：key 只计算一次，重绘/命中测试复用，避免频繁读取 textContent 造成卡顿 */
	private getCandidateEntries(): { el: HTMLElement; key: string }[] {
		if (this.candCache) return this.candCache;
		if (!this.scroller) return [];
		this.candCache = Array.from(
			this.scroller.querySelectorAll<HTMLElement>(InkOverlay.BLOCK_SEL)
		).map((el) => ({ el, key: InkOverlay.blockKey(el) }));
		return this.candCache;
	}

	private findBlockDeltaIn(
		candidates: { el: HTMLElement; key: string }[],
		s: Stroke
	): { dx: number; dy: number } {
		if (!s.k || !this.canvas) return { dx: 0, dy: 0 };
		const cRect = this.canvas.getBoundingClientRect();
		let occ = 0;
		for (const c of candidates) {
			if (!c.el.isConnected) continue;
			const t = c.key;
			if (!t) continue;
			const matched =
				t === s.k || (t.length > 10 && (t.includes(s.k) || s.k.includes(t)));
			if (!matched) continue;
			if (occ === (s.o ?? 0)) {
				const r = c.el.getBoundingClientRect();
				return {
					dx: r.left - cRect.left - (s.rx ?? 0),
					dy: r.top - cRect.top - (s.ry ?? 0),
				};
			}
			occ++;
		}
		return { dx: 0, dy: 0 };
	}

	/** 保存会触发视图重渲染、画布随之失效；在多个时间点强制恢复显示 */
	private scheduleRemount(): void {
		for (const delay of [120, 400, 900]) {
			window.setTimeout(() => {
				if (this.destroyed) return;
				const conn = this.canvas ? String(this.canvas.isConnected) : "null";
				Diag.log(`remount-check @${delay}ms connected=${conn}`);
				if (!this.canvas || !this.canvas.isConnected) {
					this.mount();
				} else {
					this.applySize();
					this.redraw();
				}
			}, delay);
		}
	}

	/** 落笔结束时把笔画锚定到其所在的文字块 */
	private attachAnchor(s: Stroke): void {
		try {
			const canvas = this.canvas;
			const scroller = this.scroller;
			if (!canvas || !scroller || !this.rect) return;
			const cRect = canvas.getBoundingClientRect();
			const p = s.points[0];
			// 使用画布所在文档：兼容笔记弹出到独立窗口的场景
			canvas.addClass("hit-test-off");
			let hit: CaretHit | null = null;
			try {
				hit = resolveCaretHit(
					canvas.ownerDocument,
					cRect.left + p.x,
					cRect.top + p.y
				);
			} finally {
				canvas.removeClass("hit-test-off");
			}
			if (!hit) return;
			let node: Node = hit.node;
			let offset = hit.offset;
			if (node.nodeType !== Node.TEXT_NODE) {
				node = node.childNodes[offset] ?? node;
			}
			// 跨窗口安全判断：用 nodeType 而不是 instanceof
			if (node.nodeType !== Node.TEXT_NODE) return;
			const parentEl = (node as Text).parentElement;
			if (!parentEl) return;
			const blockEl = parentEl.closest<HTMLElement>(InkOverlay.BLOCK_SEL) ?? parentEl;
			const key = InkOverlay.blockKey(blockEl);
			if (!key) return;

			const all = scroller.querySelectorAll<HTMLElement>(InkOverlay.BLOCK_SEL);
			let occ = 0;
			for (const el of Array.from(all)) {
				if (el === blockEl) break;
				if (InkOverlay.blockKey(el) === key) occ++;
			}
			const r = blockEl.getBoundingClientRect();
			s.k = key;
			s.o = occ;
			s.rx = r.left - cRect.left;
			s.ry = r.top - cRect.top;
		} catch (e) {
			Diag.log(`attachAnchor 失败: ${e instanceof Error ? e.message : String(e)}`);
			console.warn("[free-doodle] 锚定文字块失败", e);
		}
	}

	private addEscListener(): void {
		if (this.escHandler) return;
		this.escHandler = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (active === this.view) {
				e.preventDefault();
				e.stopPropagation();
				this.plugin.exitAnnotate();
			}
		};
		window.addEventListener("keydown", this.escHandler, true);
	}

	private removeEscListener(): void {
		if (this.escHandler) {
			window.removeEventListener("keydown", this.escHandler, true);
			this.escHandler = null;
		}
	}

	/* ---------- 持久化 ---------- */

	private scheduleSave(): void {
		if (!this.interactive) return;
		this.dirty = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.writeNote();
		}, 1200);
	}

	private flushSave(): void {
		if (!this.dirty) return;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.writeNote();
	}

	async writeNote(): Promise<void> {
		this.dirty = false;
		this.placeholderCreated = false;
		try {
			// 没有任何笔迹时：彻底移除属性和旧代码块，不在笔记中留下空数据
			if (this.strokes.length === 0) {
				await this.plugin.app.vault.process(this.file, (data: string) =>
					InkOverlay.removeFrontmatterKey(InkOverlay.stripBlock(data))
				);
				this.scheduleRemount();
				return;
			}
			const payload = JSON.stringify(this.serialize());
			const b64 = toBase64(payload);
			await this.plugin.app.vault.process(this.file, (data: string) => {
				// 数据写入 frontmatter，并清除旧版正文代码块，保持正文干净
				const cleaned = InkOverlay.stripBlock(data);
				return InkOverlay.upsertFrontmatter(cleaned, b64);
			});
			Diag.log(`writeNote 成功 ${this.file.path} strokes=${this.strokes.length}`);
			this.scheduleRemount();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			Diag.log(`writeNote 失败: ${msg}`);
			console.error("[free-doodle] 保存涂鸦失败", e);
			new Notice(`涂鸦保存失败：${msg}`);
		}
	}

	private async loadFromNote(): Promise<void> {
		try {
			// 优先读取 frontmatter（新版）
			const fm = this.plugin.app.metadataCache.getFileCache(this.file)?.frontmatter;
			const b64 = fm ? (fm as Record<string, unknown>)[FRONT_KEY] : undefined;
			if (typeof b64 === "string" && b64.length > 0) {
				this.strokes = parseStrokes(JSON.parse(fromBase64(b64)) as DoodleData);
				this.hadStoredData = true;
				return;
			}
			// 兼容旧版：读取正文代码块
			const raw = await this.plugin.app.vault.cachedRead(this.file);
			const payload = InkOverlay.extractPayload(raw);
			if (!payload) return;
			this.strokes = parseStrokes(JSON.parse(payload) as DoodleData);
			this.hadStoredData = true;
			// 自动迁移：写入 frontmatter 并清除正文中的旧代码块
			this.dirty = true;
			void this.writeNote();
		} catch (e) {
			console.error("[free-doodle] 读取涂鸦数据失败", e);
		}
	}

	private async ensurePlaceholder(): Promise<void> {
		try {
			const payload = JSON.stringify(this.serialize());
			const b64 = toBase64(payload);
			await this.plugin.app.vault.process(this.file, (data: string) =>
				InkOverlay.upsertFrontmatter(InkOverlay.stripBlock(data), b64)
			);
			this.placeholderCreated = true;
		} catch (e) {
			console.error("[free-doodle] 创建涂鸦属性失败", e);
		}
	}

	private async cleanupPlaceholder(): Promise<void> {
		if (!this.placeholderCreated || this.strokes.length > 0) return;
		this.placeholderCreated = false;
		try {
			await this.plugin.app.vault.process(this.file, (data: string) =>
				InkOverlay.removeFrontmatterKey(InkOverlay.stripBlock(data))
			);
		} catch (e) {
			console.error("[free-doodle] 清理空涂鸦属性失败", e);
		}
	}

	private serialize(): DoodleData {
		return {
			v: 3,
			w: this.cw,
			h: this.ch,
			strokes: this.strokes.map((s) => ({
				color: s.color,
				size: s.size,
				erase: s.erase,
				pts: s.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
				k: s.k,
				o: s.o,
				rx: s.rx !== undefined ? Math.round(s.rx) : undefined,
				ry: s.ry !== undefined ? Math.round(s.ry) : undefined,
				shape: s.shape,
				alpha: s.alpha,
			})),
		};
	}

	static stripBlock(data: string): string {
		const start = data.indexOf("```" + BLOCK_LANG);
		if (start === -1) return data;
		const close = data.indexOf("\n```", start);
		if (close === -1) return data.slice(0, start);
		const before = data.slice(0, start).replace(/\s+$/, "");
		const after = data.slice(close + 4).replace(/^\s+/, "");
		return before + (after ? "\n\n" + after : "");
	}

	static extractPayload(data: string): string | null {
		const start = data.indexOf("```" + BLOCK_LANG);
		if (start === -1) return null;
		const nl = data.indexOf("\n", start);
		if (nl === -1) return null;
		const close = data.indexOf("\n```", nl);
		if (close === -1) return null;
		return data.slice(nl + 1, close);
	}

	static upsertFrontmatter(data: string, b64: string): string {
		const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(data);
		if (m) {
			const rest = data.slice(m[0].length);
			let yaml = m[1];
			const keyRe = new RegExp(`^${FRONT_KEY}:.*$`, "m");
			if (keyRe.test(yaml)) {
				yaml = yaml.replace(keyRe, `${FRONT_KEY}: ${b64}`);
			} else {
				yaml += `\n${FRONT_KEY}: ${b64}`;
			}
			return `---\n${yaml}\n---\n${rest}`;
		}
		return `---\n${FRONT_KEY}: ${b64}\n---\n\n${data}`;
	}

	static removeFrontmatterKey(data: string): string {
		const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(data);
		if (!m) return data;
		const rest = data.slice(m[0].length);
		let yaml = m[1];
		const lineRe = new RegExp(`^[ \\t]*${FRONT_KEY}:[ \\t]*[^\\n]*(?:\\n|$)`, "m");
		yaml = yaml.replace(lineRe, "");
		if (yaml.trim().length === 0) {
			// frontmatter 已空，整体移除
			return rest.replace(/^\r?\n/, "");
		}
		return `---\n${yaml.replace(/\n+$/, "")}\n---\n${rest}`;
	}
}

/* ------------------------------------------------------------------ */
/* 独立涂鸦画板视图                                                    */
/* ------------------------------------------------------------------ */

type BoardTool = "pen" | "hl" | "shape" | "erasePx" | "eraseStroke";

type ToolMode = "pen" | "hl" | "shape" | "erasePx" | "eraseStroke";

type ShapeKind = "rect" | "ellipse";

type EraseKind = "px" | "stroke";

type DrawShape = ShapeKind | "line" | "arrow" | "diamond";

interface SpeechRecEvent {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

interface SpeechRecLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	onresult: ((ev: SpeechRecEvent) => void) | null;
	onerror: ((ev: { error: string }) => void) | null;
	onend: (() => void) | null;
}

function GetSpeechRecognitionCtor(): (new () => SpeechRecLike) | null {
	const w = window as unknown as Record<string, unknown>;
	if (typeof w.SpeechRecognition === "function") {
		return w.SpeechRecognition as new () => SpeechRecLike;
	}
	if (typeof w.webkitSpeechRecognition === "function") {
		return w.webkitSpeechRecognition as new () => SpeechRecLike;
	}
	return null;
}

function SpeechCapable(): boolean {
	return GetSpeechRecognitionCtor() !== null;
}

class DoodleView extends ItemView {
	private plugin: FreeDoodlePlugin;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;

	private strokes: Stroke[] = [];
	private undoStack: Stroke[][] = [];
	private current: Stroke | null = null;

	private color: string;
	private size: number;
	private opacity = 1;
	private mode: BoardTool = "pen";

	private smooth = true;
	private popover: HTMLElement | null = null;
	private popCloser: ((e: MouseEvent) => void) | null = null;
	private widthPresetEls: HTMLElement[] = [];

	private shapeKind: DrawShape = "rect";
	private eraseKind: EraseKind = "px";
	private previewScheduled = false;

	private rect: DOMRect | null = null;
	private cw = 0;
	private ch = 0;
	private ro?: ResizeObserver;

	private swatchEls: HTMLElement[] = [];
	private colorInputEl!: HTMLInputElement;
	private sizeSliderEl!: HTMLInputElement;
	private sizeLabelEl!: HTMLElement;
	private opacitySliderEl!: HTMLInputElement;
	private opacityLabelEl!: HTMLElement;
	private styleBtnEl!: HTMLElement;
	private toolBtnEls: Record<string, HTMLElement> = {};

	private effSize(): number {
		return this.mode === "hl" ? Math.max(this.size * 4, 12) : this.size;
	}

	constructor(leaf: WorkspaceLeaf, plugin: FreeDoodlePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.color = plugin.settings.penColor;
		this.size = plugin.settings.penSize;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_DOODLE;
	}

	getDisplayText(): string {
		return "自由涂鸦";
	}

	getIcon(): string {
		return "pen-tool";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("free-doodle-root");

		const toolbar = root.createDiv({ cls: "free-doodle-toolbar" });
		this.buildToolbar(toolbar);

		const wrap = root.createDiv({ cls: "free-doodle-canvas-wrap" });
		this.canvas = wrap.createEl("canvas", { cls: "free-doodle-canvas free-doodle-board" });
		this.ctx = this.canvas.getContext("2d")!;
		this.resizeCanvas();

		this.ro = new ResizeObserver(() => this.resizeCanvas());
		this.ro.observe(wrap);

		this.registerDomEvent(this.canvas, "pointerdown", (evt: PointerEvent) =>
			this.onDown(evt)
		);
		this.registerDomEvent(this.canvas, "pointermove", (evt: PointerEvent) =>
			this.onMove(evt)
		);
		this.registerDomEvent(this.canvas, "pointerup", () => this.onUp());
		this.registerDomEvent(this.canvas, "pointercancel", () => {
			this.current = null;
		});
		this.registerDomEvent(this.canvas, "contextmenu", (evt: MouseEvent) =>
			evt.preventDefault()
		);
		this.registerDomEvent(root, "keydown", (evt: KeyboardEvent) => {
			if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && evt.key.toLowerCase() === "z") {
				evt.preventDefault();
				this.undo();
			}
		});
	}

	async onClose(): Promise<void> {
		this.closePopover();
		this.ro?.disconnect();
		this.contentEl.empty();
	}

	private buildToolbar(toolbar: HTMLDivElement): void {
		const mkBtn = (
			icon: string,
			title: string,
			onClick: () => void
		): HTMLButtonElement => {
			const b = toolbar.createEl("button", {
				cls: "free-doodle-btn clickable-icon",
				attr: { title },
			});
			setIcon(b, icon);
			b.addEventListener("click", onClick);
			return b;
		};

		const tools = [
			{ id: "pen" as const, icon: "pencil", title: "钢笔" },
			{ id: "hl" as const, icon: "highlighter", title: "荧光笔（半透明）" },
			{ id: "shape" as const, icon: "square", title: "形状：点击切换 矩形/椭圆" },
			{ id: "erase" as const, icon: "eraser", title: "橡皮：点击切换 像素/整笔擦除" },
		];
		for (const t of tools) {
			const b = toolbar.createEl("button", {
				cls: "free-doodle-btn clickable-icon",
				attr: { title: t.title },
			});
			setIcon(b, t.icon);
			b.addEventListener("click", () => this.onBoardToolClick(t.id));
			this.toolBtnEls[t.id] = b;
		}

		toolbar.createDiv({ cls: "free-doodle-sep" });

		this.styleBtnEl = mkBtn("settings-2", "样式：颜色 / 粗细 / 不透明度 / 笔迹优化", () =>
			this.openBoardStylePopover(this.styleBtnEl)
		);

		toolbar.createDiv({ cls: "free-doodle-sep" });

		this.toolBtnEls["undo"] = mkBtn("undo-2", "撤销 (Ctrl+Z)", () => this.undo());
		this.toolBtnEls["trash"] = mkBtn("trash-2", "清空画布", () => this.clear());

		toolbar.createDiv({ cls: "free-doodle-sep" });

		const saveBtn = toolbar.createEl("button", {
			cls: "free-doodle-btn free-doodle-save mod-cta",
			attr: { title: "保存为 PNG（同时复制到剪贴板）" },
		});
		setIcon(saveBtn, "save");
		saveBtn.createSpan({ text: "保存 PNG" });
		saveBtn.addEventListener("click", () => void this.saveToVault());

		this.syncToolbar();
	}

	private onBoardToolClick(id: BoardTool | "erase"): void {
		if (id === "shape") {
			this.openBoardShapePopover(this.toolBtnEls["shape"] ?? this.styleBtnEl);
			return;
		}
		if (id === "erase") {
			this.openBoardErasePopover(this.toolBtnEls["erase"] ?? this.styleBtnEl);
			return;
		}
		this.setBoardMode(id);
	}

	private syncToolbar(): void {
		const eraseActive = this.mode === "erasePx" || this.mode === "eraseStroke";
		this.swatchEls.forEach((el) =>
			el.toggleClass(
				"is-active",
				!eraseActive && (el.dataset.color ?? "").toLowerCase() === this.color.toLowerCase()
			)
		);
		const shapeBtn = this.toolBtnEls["shape"];
		if (shapeBtn) {
			setIcon(shapeBtn, this.shapeKind === "rect" ? "square" : "circle");
			shapeBtn.toggleClass("is-active", this.mode === "shape");
		}
		const eraseBtn = this.toolBtnEls["erase"];
		if (eraseBtn) {
			setIcon(eraseBtn, this.eraseKind === "px" ? "eraser" : "scissors");
			eraseBtn.toggleClass("is-active", eraseActive);
		}
		const penBtn = this.toolBtnEls["pen"];
		if (penBtn) penBtn.toggleClass("is-active", this.mode === "pen");
		const hlBtn = this.toolBtnEls["hl"];
		if (hlBtn) hlBtn.toggleClass("is-active", this.mode === "hl");
		this.widthPresetEls.forEach((el) =>
			el.toggleClass("is-active", Number(el.dataset.size) === this.size)
		);
		if (this.colorInputEl) this.colorInputEl.value = this.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.size);
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
	}

	private closePopover(): void {
		this.popover?.remove();
		this.popover = null;
		if (this.popCloser) {
			window.removeEventListener("pointerdown", this.popCloser, true);
			this.popCloser = null;
		}
	}

	private openPopover(
		anchor: HTMLElement,
		build: (el: HTMLElement) => void
	): void {
		this.closePopover();
		const content = this.contentEl;
		const pop = content.createDiv({ cls: "free-doodle-popover" });
		this.popover = pop;
		build(pop);
		const aRect = anchor.getBoundingClientRect();
		const cRect = content.getBoundingClientRect();
		pop.style.left = `${Math.max(4, Math.round(aRect.left - cRect.left))}px`;
		pop.style.top = `${Math.round(aRect.bottom - cRect.top + 6)}px`;
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover && !this.popover.contains(t) && !anchor.contains(t)) {
				this.closePopover();
			}
		};
		this.popCloser = closer;
		window.setTimeout(() => window.addEventListener("pointerdown", closer, true), 0);
	}

	private openBoardStylePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			el.addClass("free-doodle-style-pop");
			this.swatchEls = [];
			this.widthPresetEls = [];
			const colors = el.createDiv({ cls: "free-doodle-pop-row" });
			for (const c of PALETTE) {
				const b = colors.createEl("button", {
					cls: "free-doodle-swatch",
					attr: { title: c },
				});
				b.dataset.color = c;
				b.addEventListener("click", () => {
					this.color = c;
					if (this.mode === "erasePx" || this.mode === "eraseStroke")
						this.setBoardMode("pen");
					else this.syncToolbar();
				});
				this.swatchEls.push(b);
			}
			this.colorInputEl = colors.createEl("input", {
				cls: "free-doodle-color-input",
				type: "color",
				attr: { title: "自定义颜色" },
			});
			this.colorInputEl.value = this.color;
			this.colorInputEl.addEventListener("input", () => {
				this.color = this.colorInputEl.value;
				if (this.mode === "erasePx" || this.mode === "eraseStroke")
					this.setBoardMode("pen");
				else this.syncToolbar();
			});

			const sizeRow = el.createDiv({ cls: "free-doodle-pop-row" });
			sizeRow.createSpan({ cls: "free-doodle-pop-label", text: "粗细" });
			for (const [label, val] of [
				["细", 2],
				["中", 5],
				["粗", 10],
			] as const) {
				const b = sizeRow.createEl("button", {
					cls: "free-doodle-btn free-doodle-wpreset",
					text: label,
				});
				b.dataset.size = String(val);
				b.addEventListener("click", () => {
					this.size = val;
					this.syncToolbar();
				});
				this.widthPresetEls.push(b);
			}

			const opRow = el.createDiv({ cls: "free-doodle-pop-row" });
			opRow.createSpan({ cls: "free-doodle-pop-label", text: "不透明" });
			this.opacitySliderEl = opRow.createEl("input", {
				cls: "free-doodle-slider",
				type: "range",
				attr: { min: "10", max: "100", step: "5" },
			});
			this.opacitySliderEl.value = String(Math.round(this.opacity * 100));
			this.opacityLabelEl = opRow.createSpan({
				cls: "free-doodle-size-label",
				text: `${Math.round(this.opacity * 100)}%`,
			});
			this.opacitySliderEl.addEventListener("input", () => {
				this.opacity = Number(this.opacitySliderEl.value) / 100;
				this.opacityLabelEl.setText(`${this.opacitySliderEl.value}%`);
			});

			const smRow = el.createDiv({ cls: "free-doodle-pop-row" });
			smRow.createSpan({ cls: "free-doodle-pop-label", text: "优化" });
			const smBtn = smRow.createEl("button", {
				cls: "free-doodle-btn clickable-icon",
				attr: { title: "笔迹平滑（去抖动）" },
			});
			setIcon(smBtn, "sparkles");
			smBtn.toggleClass("is-active", this.smooth);
			smBtn.addEventListener("click", () => {
				this.smooth = !this.smooth;
				smBtn.toggleClass("is-active", this.smooth);
			});
			this.syncToolbar();
		});
	}

	private openBoardShapePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			const defs = [
				{ shape: "line" as DrawShape, icon: "minus", title: "直线" },
				{ shape: "arrow" as DrawShape, icon: "arrow-up-right", title: "箭头" },
				{ shape: "rect" as DrawShape, icon: "square", title: "矩形" },
				{ shape: "ellipse" as DrawShape, icon: "circle", title: "椭圆" },
				{ shape: "diamond" as DrawShape, icon: "diamond", title: "菱形" },
			];
			for (const d of defs) {
				const b = el.createEl("button", {
					cls: "free-doodle-btn clickable-icon free-doodle-pop-item",
					attr: { title: d.title },
				});
				setIcon(b, d.icon);
				b.toggleClass("is-active", this.mode === "shape" && this.shapeKind === d.shape);
				b.addEventListener("click", () => {
					this.shapeKind = d.shape;
					this.setBoardMode("shape");
					this.closePopover();
				});
			}
		});
	}

	private openBoardErasePopover(anchor: HTMLElement): void {
		this.openPopover(anchor, (el) => {
			const defs = [
				{
					kind: "px" as EraseKind,
					mode: "erasePx" as BoardTool,
					icon: "eraser",
					title: "像素擦除（擦掉划过的区域）",
				},
				{
					kind: "stroke" as EraseKind,
					mode: "eraseStroke" as BoardTool,
					icon: "scissors",
					title: "整笔擦除（删除碰到的整笔）",
				},
			];
			for (const d of defs) {
				const b = el.createEl("button", {
					cls: "free-doodle-btn clickable-icon free-doodle-pop-item",
					attr: { title: d.title },
				});
				setIcon(b, d.icon);
				b.toggleClass("is-active", this.eraseKind === d.kind);
				b.addEventListener("click", () => {
					this.eraseKind = d.kind;
					this.setBoardMode(d.mode);
					this.closePopover();
				});
			}
		});
	}

	private setBoardMode(mode: BoardTool): void {
		this.mode = mode;
		if (mode === "hl" && this.opacity > 0.6) {
			this.opacity = 0.35;
			if (this.opacitySliderEl)
				this.opacitySliderEl.value = String(Math.round(this.opacity * 100));
			if (this.opacityLabelEl) this.opacityLabelEl.setText(`${Math.round(this.opacity * 100)}%`);
		}
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		this.syncToolbar();
	}

	private resizeCanvas(): void {
		const wrap = this.canvas.parentElement;
		if (!wrap) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.cw = Math.max(1, Math.floor(wrap.clientWidth));
		this.ch = Math.max(1, Math.floor(wrap.clientHeight));
		this.canvas.width = Math.floor(this.cw * dpr);
		this.canvas.height = Math.floor(this.ch * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.redraw();
	}

	private pushUndo(): void {
		this.undoStack.push(this.strokes.slice());
		if (this.undoStack.length > 50) this.undoStack.shift();
	}

	private undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.strokes = prev;
		this.redraw();
	}

	private clear(): void {
		if (!this.strokes.length) return;
		this.pushUndo();
		this.strokes = [];
		this.redraw();
	}

	private toPoint(evt: PointerEvent): Point {
		const r = this.rect ?? this.canvas.getBoundingClientRect();
		return { x: evt.clientX - r.left, y: evt.clientY - r.top };
	}

	private onDown(evt: PointerEvent): void {
		if (!evt.isPrimary) return;
		this.rect = this.canvas.getBoundingClientRect();
		this.canvas.setPointerCapture(evt.pointerId);
		const p = this.toPoint(evt);

		if (this.mode === "eraseStroke") {
			this.strokeEraseUndoArmed = true;
			this.removeStrokesNear(p);
			return;
		}

		const erase = this.mode === "erasePx";
		this.current = {
			color: this.color,
			size: this.effSize(),
			erase,
			alpha: erase ? undefined : this.opacity,
			points: [p],
			shape: this.mode === "shape" ? this.shapeKind : undefined,
		};
	}

	private strokeEraseUndoArmed = false;

	private removeStrokesNear(p: Point): void {
		let removed = 0;
		for (let i = this.strokes.length - 1; i >= 0; i--) {
			const s = this.strokes[i];
			if (s.erase) continue;
			const th = Math.max(10, s.size) + 6;
			let hit = false;
			if (!s.shape) {
				for (const q of s.points) {
					const ddx = q.x - p.x;
					const ddy = q.y - p.y;
					if (ddx * ddx + ddy * ddy <= th * th) {
						hit = true;
						break;
					}
				}
			} else {
				hit = hitShapeOrPath(s, p.x, p.y, th);
			}
			if (hit) {
				if (this.strokeEraseUndoArmed) {
					this.pushUndo();
					this.strokeEraseUndoArmed = false;
				}
				this.strokes.splice(i, 1);
				removed++;
			}
		}
		if (removed > 0) {
			this.redraw();
		}
	}

	private schedulePreview(): void {
		if (this.previewScheduled) return;
		this.previewScheduled = true;
		window.requestAnimationFrame(() => {
			this.previewScheduled = false;
			const s = this.current;
			if (!s || !this.ctx || !this.containerEl.isConnected) return;
			let draw = s;
			if (!s.erase && !s.shape && this.smooth && s.points.length > 6 && s.points.length < 4000) {
				draw = { ...s, points: beautifyPoints(s.points) };
			}
			this.redraw();
			drawStroke(this.ctx, draw);
		});
	}

	private onMove(evt: PointerEvent): void {
		const s = this.current;
		if (!evt.isPrimary) return;

		if (!s && this.mode === "eraseStroke") {
			this.removeStrokesNear(this.toPoint(evt));
			return;
		}
		if (!s) return;

		if (s.shape) {
			s.points[1] = this.toPoint(evt);
		} else {
			s.points.push(this.toPoint(evt));
		}
		this.schedulePreview();
	}

	private onUp(): void {
		const s = this.current;
		if (!s) return;
		this.current = null;

		if (s.shape && s.points.length >= 2) {
			const a = s.points[0];
			const b = s.points[s.points.length - 1];
			if (Math.abs(b.x - a.x) < 4 && Math.abs(b.y - a.y) < 4) return;
		}

		let final: Stroke = s;
		if (!s.erase && !s.shape && this.smooth && s.points.length > 2) {
			final = { ...s, points: beautifyPoints(s.points) };
		}

		this.pushUndo();
		this.strokes.push(final);
		this.redraw();
	}

	private redraw(): void {
		this.ctx.clearRect(0, 0, this.cw, this.ch);
		this.ctx.fillStyle = "#ffffff";
		this.ctx.fillRect(0, 0, this.cw, this.ch);
		drawStrokes(this.ctx, this.strokes);
	}

	private async saveToVault(): Promise<void> {
		try {
			const folder = normalizePath(this.plugin.settings.saveFolder);
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}
			const d = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const base =
				`涂鸦-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
				`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
			let name = `${base}.png`;
			let i = 1;
			while (await adapter.exists(normalizePath(`${folder}/${name}`))) {
				name = `${base}-${i++}.png`;
			}

			const blob = await new Promise<Blob | null>((resolve) =>
				this.canvas.toBlob(resolve, "image/png")
			);
			if (!blob) throw new Error("画布导出失败");
			const buf = await blob.arrayBuffer();

			const file: TFile = await this.app.vault.createBinary(
				normalizePath(`${folder}/${name}`),
				buf
			);

			try {
				await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			} catch {
				/* 剪贴板不可用时忽略 */
			}

			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (mdView) {
				mdView.editor.replaceSelection(`![[${file.name}]]`);
				new Notice(`已保存并插入：${file.path}`);
			} else {
				new Notice(`已保存：${file.path}（图片已复制到剪贴板，可粘贴进笔记）`);
			}
		} catch (e) {
			console.error("[free-doodle] 保存失败", e);
			new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export default class FreeDoodlePlugin extends Plugin {
	settings: FreeDoodleSettings = { ...DEFAULT_SETTINGS };

	overlays = new Map<MarkdownView, InkOverlay>();
	activePath: string | null = null;
	private sweepTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_DOODLE, (leaf) => new DoodleView(leaf, this));

		this.addRibbonIcon("highlighter", "在当前笔记涂鸦 / 退出", () => {
			void this.toggleAnnotate();
		});

		this.addCommand({
			id: "toggle-annotate",
			name: "开始 / 结束当前笔记涂鸦",
			callback: () => {
				void this.toggleAnnotate();
			},
		});

		this.addCommand({
			id: "open-doodle-board",
			name: "打开独立涂鸦画板",
			callback: () => {
				void this.activateBoard();
			},
		});

		this.addCommand({
			id: "clear-current-doodle",
			name: "清除当前笔记的涂鸦数据",
			callback: () => {
				void this.clearCurrent();
			},
		});

		this.addCommand({
			id: "clean-empty-doodles",
			name: "清理全库：移除没有笔迹的涂鸦属性",
			callback: () => {
				void this.cleanEmptyEverywhere();
			},
		});

		// 仅在嵌入引用 / 悬浮预览中渲染墨迹；主视图由覆盖层负责
		this.registerMarkdownCodeBlockProcessor(
			BLOCK_LANG,
			(source, el, _ctx: MarkdownPostProcessorContext) => {
				const host = el.createDiv({ cls: "free-doodle-inline-host" });
				const inMainView =
					!!el.closest(".cm-editor") || !!el.closest(".markdown-reading-view");
				if (inMainView) {
					host.createDiv({
						cls: "free-doodle-placeholder",
						text: "🖌 涂鸦层数据（Ctrl+D 编辑，阅读模式自动叠加显示）",
					});
					return;
				}
				try {
					const data = JSON.parse(source) as DoodleData;
					const strokes = parseStrokes(data);
					const holder = host.createDiv({ cls: "free-doodle-inline" });
					const canvas = holder.createEl("canvas");
					const w = Math.min(Math.max(1, Number(data?.w) || 600), 16000);
					const h = Math.min(Math.max(1, Number(data?.h) || 400), 16000);
					const dpr = Math.min(window.devicePixelRatio || 1, 2);
					canvas.width = Math.floor(w * dpr);
					canvas.height = Math.floor(h * dpr);
					const c2d = canvas.getContext("2d");
					if (!c2d) return;
					c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
					drawStrokes(c2d, strokes);
				} catch (e) {
					host.createDiv({ cls: "free-doodle-broken", text: "（涂鸦数据无法解析）" });
					console.error("[free-doodle] 渲染涂鸦块失败", e);
				}
			}
		);

		this.addSettingTab(new FreeDoodleSettingTab(this.app, this));

		// 切换笔记/布局变化时立即同步覆盖层，避免旧墨迹残留到其他笔记
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.sweep())
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.sweep()));

		this.sweep();
		this.sweepTimer = window.setInterval(this.sweep, 700);
	}

	onunload(): void {
		if (this.sweepTimer !== null) window.clearInterval(this.sweepTimer);
		for (const ov of Array.from(this.overlays.values())) {
			ov.destroy(true);
		}
		this.overlays.clear();
		this.activePath = null;
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<FreeDoodleSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private sweep = (): void => {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		const seen = new Set<MarkdownView>();
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			seen.add(view);
			let ov = this.overlays.get(view);
			// 视图被复用加载了别的文件：旧覆盖层作废
			if (ov && ov.file !== view.file) {
				Diag.log(`sweep: 视图复用，销毁旧覆盖层 ${ov.file.path}`);
				ov.destroy(false);
				this.overlays.delete(view);
				if (this.activePath === ov.file.path) this.activePath = null;
				ov = undefined;
			}
			const interactive = this.activePath === view.file.path;
			const want = interactive || view.getMode() === "preview";
			if (!ov && want) {
				ov = new InkOverlay(this, view, interactive);
				this.overlays.set(view, ov);
				void ov.init();
			} else if (ov) {
				if (!want) {
					ov.destroy(true);
					this.overlays.delete(view);
				} else {
					ov.setInteractive(interactive);
				}
			}
		}
		for (const [view, ov] of Array.from(this.overlays.entries())) {
			if (!seen.has(view)) {
				ov.destroy(true);
				this.overlays.delete(view);
				if (this.activePath === ov.file.path) this.activePath = null;
			}
		}
	};

	dropOverlay(overlay: InkOverlay): void {
		for (const [view, ov] of Array.from(this.overlays.entries())) {
			if (ov === overlay) {
				ov.destroy(false);
				this.overlays.delete(view);
			}
		}
		if (this.activePath === overlay.file.path) this.activePath = null;
	}

	async toggleAnnotate(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice("请先打开一个笔记文件再开始涂鸦");
			return;
		}
		if (this.activePath === view.file.path) {
			this.exitAnnotate();
			return;
		}
		if (this.activePath) this.exitAnnotate();

		this.activePath = view.file.path;
		let ov = this.overlays.get(view);
		if (!ov) {
			ov = new InkOverlay(this, view, true);
			this.overlays.set(view, ov);
			void ov.init();
		} else {
			ov.setInteractive(true);
		}
	}

	exitAnnotate(): void {
		if (!this.activePath) return;
		for (const [view, ov] of Array.from(this.overlays.entries())) {
			if (ov.file.path === this.activePath) {
				ov.setInteractive(false);
				// 编辑模式下退出后不再需要覆盖层，交给 sweep 清理
				if (view.getMode() !== "preview") {
					ov.destroy(false);
					this.overlays.delete(view);
				}
			}
		}
		this.activePath = null;
	}

	async clearCurrent(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice("请先打开一个笔记");
			return;
		}
		const ov = this.overlays.get(view);
		if (ov) {
			ov.clearAllForRemove();
			return;
		}
		try {
			await this.app.vault.process(view.file, (data: string) =>
				InkOverlay.removeFrontmatterKey(InkOverlay.stripBlock(data))
			);
			new Notice("已清除该笔记的涂鸦数据");
		} catch (e) {
			console.error("[free-doodle] 清除涂鸦数据失败", e);
			new Notice("清除失败，详见控制台");
		}
	}

	async cleanEmptyEverywhere(): Promise<void> {
		const activeFiles = new Set<string>();
		for (const ov of this.overlays.values()) activeFiles.add(ov.file.path);
		const files = this.app.vault.getMarkdownFiles();
		let cleaned = 0;
		for (const f of files) {
			if (activeFiles.has(f.path)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			const b64 = fm ? (fm as Record<string, unknown>)[FRONT_KEY] : undefined;
			if (typeof b64 !== "string" || b64.length === 0) continue;
			let isEmpty: boolean;
			try {
				isEmpty = parseStrokes(JSON.parse(fromBase64(b64)) as DoodleData).length === 0;
			} catch {
				isEmpty = true;
			}
			if (!isEmpty) continue;
			try {
				await this.app.vault.process(f, (data: string) =>
					InkOverlay.removeFrontmatterKey(InkOverlay.stripBlock(data))
				);
				cleaned++;
			} catch (e) {
				console.error("[free-doodle] 清理失败：" + f.path, e);
			}
		}
		new Notice(`清理完成：移除了 ${cleaned} 个笔记的空涂鸦属性`);
	}

	async activateBoard(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_DOODLE);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf(true);
		}
		await leaf.setViewState({ type: VIEW_TYPE_DOODLE, active: true });
		await workspace.revealLeaf(leaf);
	}
}

class FreeDoodleSettingTab extends PluginSettingTab {
	plugin: FreeDoodlePlugin;

	constructor(app: App, plugin: FreeDoodlePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("常规").setHeading();

		new Setting(containerEl)
			.setName("默认画笔颜色")
			.setDesc("进入涂鸦模式时的初始颜色")
			.addColorPicker((cb) =>
				cb.setValue(this.plugin.settings.penColor).onChange(async (v) => {
					this.plugin.settings.penColor = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("默认画笔粗细")
			.setDesc("1 - 40")
			.addSlider((sb) =>
				sb
					.setLimits(1, 40, 1)
					.setValue(this.plugin.settings.penSize)
					.onChange(async (v) => {
						this.plugin.settings.penSize = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("独立画板图片文件夹")
			.setDesc("仅用于独立画板导出 PNG 的存放路径（库内相对路径），不存在时自动创建")
			.addText((tb) =>
				tb
					.setPlaceholder("涂鸦")
					.setValue(this.plugin.settings.saveFolder)
					.onChange(async (v) => {
						this.plugin.settings.saveFolder = v.trim() || "涂鸦";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("独立涂鸦画板")
			.setDesc("全屏画板，工具与笔记内涂鸦一致，可导出 PNG 并插入笔记（关闭本设置页即可查看）")
			.addButton((b) =>
				b.setButtonText("打开画板").onClick(() => {
					void this.plugin.activateBoard();
				})
			);

		containerEl.createEl("p", {
			text: "用法：打开任意笔记 → 点击左侧荧光笔图标或 Ctrl+D 进入涂鸦模式，直接在内容上划线标注；点击“完成”或按 Esc 退出。墨迹数据保存在笔记的 free-doodle 属性（frontmatter）中，不影响正文编辑；阅读模式会自动叠加显示。",
			cls: "free-doodle-setting-hint",
		});

		this.buildDiagnostics(containerEl);
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	setControlValue(key: string, value: unknown): void {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "saveFolder" && typeof value === "string") {
			value = value.trim() || DEFAULT_SETTINGS.saveFolder;
		}
		settings[key] = value;
		void this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const generalGroup: SettingDefinitionItem = {
			type: "group",
			heading: "Annotate / 涂鸦",
			items: [
				{
					name: "Default pen color 默认画笔颜色",
					desc: "Initial color when entering annotate mode. 进入涂鸦模式时的初始颜色。",
					control: {
						type: "color",
						key: "penColor",
						defaultValue: DEFAULT_SETTINGS.penColor,
					},
				},
				{
					name: "Default pen size 默认画笔粗细",
					desc: "Width in px, 1 - 40. 粗细（像素）。",
					control: {
						type: "slider",
						key: "penSize",
						min: 1,
						max: 40,
						step: 1,
						defaultValue: DEFAULT_SETTINGS.penSize,
					},
				},
				{
					name: "Board PNG folder 独立画板图片文件夹",
					desc: "Relative vault path, created automatically. 库内相对路径，不存在时自动创建。",
					control: {
						type: "text",
						key: "saveFolder",
						placeholder: "涂鸦",
						defaultValue: DEFAULT_SETTINGS.saveFolder,
					},
				},
				{
					name: "Open standalone board 打开独立画板",
					desc: "Full-screen doodle board with PNG export. 全屏涂鸦画板，可导出 PNG 并插入笔记。",
					action: () => {
						void this.plugin.activateBoard();
					},
				},
			],
		};
		const diagnostics: SettingDefinition = {
			name: "Diagnostics 诊断日志",
			desc: "Overlay mount/save events and live canvas state. 覆盖层事件与画布实时状态。",
			render: (setting) => {
				this.mountDiagnostics(setting.controlEl);
			},
		};
		return [generalGroup, diagnostics];
	}

	private buildDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("诊断日志").setHeading();
		this.mountDiagnostics(containerEl);
	}

	private mountDiagnostics(parent: HTMLElement): void {
		const textarea = parent.createEl("textarea", {
			cls: "free-doodle-diag",
			attr: { readonly: "true", spellcheck: "false" },
		});
		textarea.rows = 16;
		const refresh = () => {
			const lines: string[] = [Diag.dump()];
			lines.push(`---- 实时状态 ----`);
			lines.push(`activePath=${this.plugin.activePath ?? "null"} overlays=${this.plugin.overlays.size}`);
			document.querySelectorAll(".free-doodle-canvas").forEach((c, i) => {
				const cv = c as HTMLCanvasElement;
				const r = cv.getBoundingClientRect();
				lines.push(
					`canvas#${i}: connected=${cv.isConnected} px=${cv.width}x${cv.height} ` +
						`css=${cv.style.width || "-"} rect=[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}] ` +
						`parent=${(cv.parentElement?.className ?? "null").slice(0, 50)}`
				);
			});
			if (!lines[1]) lines.splice(1, 1);
			textarea.value = lines.filter((l) => l.length > 0).join("\n");
		};

		new Setting(parent)
			.setName("诊断日志")
			.setDesc("记录覆盖层挂载/保存/销毁等关键事件与画布实时状态")
			.addButton((b) =>
				b.setButtonText("刷新").onClick(() => {
					refresh();
				})
			)
			.addButton((b) =>
				b.setButtonText("复制全部").onClick(async () => {
					refresh();
					try {
						await navigator.clipboard.writeText(textarea.value);
						new Notice("诊断信息已复制到剪贴板");
					} catch {
						new Notice("复制失败，请手动全选复制");
					}
				})
			)
			.addButton((b) =>
				b.setButtonText("清空").onClick(() => {
					Diag.clear();
					refresh();
				})
			);

		refresh();
	}
}
