import {
	App,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
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
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (s.erase) {
		ctx.globalCompositeOperation = "destination-out";
		ctx.strokeStyle = "#000";
		ctx.fillStyle = "#000";
	} else {
		ctx.globalCompositeOperation = "source-over";
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

	private tool = { color: "#e03131", size: 4, erase: false };

	private swatchEls: HTMLElement[] = [];
	private colorInputEl!: HTMLInputElement;
	private sizeSliderEl!: HTMLInputElement;
	private eraserBtnEl!: HTMLElement;

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
			await new Promise((resolve) => setTimeout(resolve, 300));
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
			if (!this.canvas || !this.canvas.isConnected) {
				requestAnimationFrame(() => {
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
		this.unmount();
		const scroller = this.findScroller();
		if (!scroller) {
			Diag.log("mount 跳过：未找到滚动容器");
			return;
		}
		this.scroller = scroller;
		Diag.log(
			`mount 容器=${scroller.className.slice(0, 50)} w=${scroller.clientWidth} h=${scroller.scrollHeight} strokes=${this.strokes.length}`
		);

		const content = this.view.contentEl;
		if (getComputedStyle(content).position === "static") {
			content.style.position = "relative";
		}
		if (getComputedStyle(scroller).position === "static") {
			scroller.style.position = "relative";
		}

		const wrap = scroller.createDiv({ cls: "free-doodle-overlay" });
		wrap.toggleClass("is-interactive", this.interactive);
		const canvas = wrap.createEl("canvas", { cls: "free-doodle-canvas" });
		this.wrap = wrap;
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d");
		// 关键：新画布必须重新计算尺寸。清空缓存，防止 applySize 因新旧尺寸恰好相同而跳过，
		// 导致画布停留在 300x150 默认值、墨迹被裁剪“消失”
		this.cw = 0;
		this.ch = 0;

		canvas.addEventListener("pointerdown", this.onDown);
		canvas.addEventListener("pointermove", this.onMove);
		canvas.addEventListener("pointerup", this.onUp);
		canvas.addEventListener("pointercancel", this.onCancel);

		this.applySize();
		if (this.interactive) this.buildToolbar();
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

		const doneBtn = tb.createEl("button", {
			cls: "free-doodle-btn mod-cta",
			attr: { title: "完成并保存 (Esc)" },
		});
		setIcon(doneBtn, "check");
		doneBtn.createSpan({ text: "完成" });
		doneBtn.addEventListener("click", () => this.plugin.exitAnnotate());

		tb.createDiv({ cls: "free-doodle-sep" });

		for (const c of PALETTE) {
			const b = tb.createEl("button", {
				cls: "free-doodle-swatch",
				attr: { title: c },
			});
			b.style.backgroundColor = c;
			b.addEventListener("click", () => {
				this.tool.color = c;
				this.tool.erase = false;
				this.syncTool();
			});
			this.swatchEls.push(b);
		}

		this.colorInputEl = tb.createEl("input", {
			cls: "free-doodle-color-input",
			type: "color",
			attr: { title: "自定义颜色" },
		});
		this.colorInputEl.value = this.tool.color;
		this.colorInputEl.addEventListener("input", () => {
			this.tool.color = this.colorInputEl.value;
			this.tool.erase = false;
			this.syncTool();
		});

		tb.createDiv({ cls: "free-doodle-sep" });

		this.sizeSliderEl = tb.createEl("input", {
			cls: "free-doodle-slider",
			type: "range",
			attr: { min: "1", max: "40", step: "1", title: "粗细" },
		});
		this.sizeSliderEl.value = String(this.tool.size);
		this.sizeSliderEl.addEventListener("input", () => {
			this.tool.size = Number(this.sizeSliderEl.value);
		});

		this.eraserBtnEl = tb.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "橡皮擦" },
		});
		setIcon(this.eraserBtnEl, "eraser");
		this.eraserBtnEl.addEventListener("click", () => {
			this.tool.erase = !this.tool.erase;
			this.syncTool();
		});

		const undoBtn = tb.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "撤销 (Ctrl+Z)" },
		});
		setIcon(undoBtn, "undo-2");
		undoBtn.addEventListener("click", () => this.undo());

		const clearBtn = tb.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "清空全部墨迹" },
		});
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => this.clearAll());

		this.syncTool();
	}

	private syncTool(): void {
		this.swatchEls.forEach((el) =>
			el.toggleClass(
				"is-active",
				!this.tool.erase &&
					el.style.backgroundColor.toLowerCase() === this.tool.color.toLowerCase()
			)
		);
		this.eraserBtnEl?.toggleClass("is-active", this.tool.erase);
		if (this.colorInputEl) this.colorInputEl.value = this.tool.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.tool.size);
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
		this.current = {
			color: this.tool.color,
			size: this.tool.size,
			erase: this.tool.erase,
			points: [this.toPoint(evt)],
		};
	};

	private onMove = (evt: PointerEvent): void => {
		const s = this.current;
		const ctx = this.ctx;
		if (!s || !ctx || !evt.isPrimary) return;
		s.points.push(this.toPoint(evt));
		const pts = s.points;
		const a = pts[pts.length - 2];
		const b = pts[pts.length - 1];
		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.lineWidth = s.size;
		if (s.erase) {
			ctx.globalCompositeOperation = "destination-out";
			ctx.strokeStyle = "#000";
		} else {
			ctx.globalCompositeOperation = "source-over";
			ctx.strokeStyle = s.color;
		}
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		ctx.restore();
	};

	private onUp = (): void => {
		const s = this.current;
		if (!s) return;
		this.current = null;
		this.attachAnchor(s);
		this.undoStack.push(this.strokes.slice());
		if (this.undoStack.length > 50) this.undoStack.shift();
		this.strokes.push(s);
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
		const candidates = this.getCandidateBlocks();
		for (const s of this.strokes) {
			const { dx, dy } = this.findBlockDeltaIn(candidates, s);
			drawStroke(ctx, s, dx, dy);
		}
	}

	private static readonly BLOCK_SEL = ".cm-line, p, li, h1, h2, h3, h4, h5, h6";

	private static blockKey(el: HTMLElement): string {
		return normText(el.textContent ?? "").slice(0, 80);
	}

	private getCandidateBlocks(): HTMLElement[] {
		if (!this.scroller) return [];
		return Array.from(
			this.scroller.querySelectorAll<HTMLElement>(InkOverlay.BLOCK_SEL)
		);
	}

	private findBlockDeltaIn(
		candidates: HTMLElement[],
		s: Stroke
	): { dx: number; dy: number } {
		if (!s.k || !this.canvas) return { dx: 0, dy: 0 };
		const cRect = this.canvas.getBoundingClientRect();
		let occ = 0;
		for (const el of candidates) {
			const t = InkOverlay.blockKey(el);
			if (!t) continue;
			const matched =
				t === s.k || (t.length > 10 && (t.includes(s.k) || s.k.includes(t)));
			if (!matched) continue;
			if (occ === (s.o ?? 0)) {
				const r = el.getBoundingClientRect();
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
		 const doc = document as Document & {
				caretRangeFromPoint?: (x: number, y: number) => Range | null;
			};
			if (!doc.caretRangeFromPoint) return;
			// 关键：临时让画布对命中测试透明，否则只会命中画布自身而非下方文字
			const prevPE = canvas.style.pointerEvents;
			canvas.style.pointerEvents = "none";
			let range: Range | null = null;
			try {
				range = doc.caretRangeFromPoint(cRect.left + p.x, cRect.top + p.y);
			} finally {
				canvas.style.pointerEvents = prevPE;
			}
			if (!range || !range.startContainer) return;
			let node: Node = range.startContainer;
			if (node.nodeType !== Node.TEXT_NODE) {
				node = node.childNodes[range.startOffset] ?? node;
			}
			if (!(node instanceof Text)) return;
			const parentEl = node.parentElement;
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

class DoodleView extends ItemView {
	private plugin: FreeDoodlePlugin;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;

	private strokes: Stroke[] = [];
	private undoStack: Stroke[][] = [];
	private current: Stroke | null = null;

	private color: string;
	private size: number;
	private erasing = false;

	private rect: DOMRect | null = null;
	private cw = 0;
	private ch = 0;
	private ro?: ResizeObserver;

	private swatchEls: HTMLElement[] = [];
	private colorInputEl!: HTMLInputElement;
	private sizeSliderEl!: HTMLInputElement;
	private sizeLabelEl!: HTMLElement;
	private eraserBtnEl!: HTMLButtonElement;

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
		this.ro?.disconnect();
		this.contentEl.empty();
	}

	private buildToolbar(toolbar: HTMLDivElement): void {
		for (const c of PALETTE) {
			const b = toolbar.createEl("button", {
				cls: "free-doodle-swatch",
				attr: { title: c },
			});
			b.style.backgroundColor = c;
			b.addEventListener("click", () => {
				this.color = c;
				this.erasing = false;
				this.syncToolbar();
			});
			this.swatchEls.push(b);
		}

		this.colorInputEl = toolbar.createEl("input", {
			cls: "free-doodle-color-input",
			type: "color",
			attr: { title: "自定义颜色" },
		});
		this.colorInputEl.value = this.color;
		this.colorInputEl.addEventListener("input", () => {
			this.color = this.colorInputEl.value;
			this.erasing = false;
			this.syncToolbar();
		});

		const sizeWrap = toolbar.createDiv({ cls: "free-doodle-size-wrap" });
		sizeWrap.createSpan({ text: "粗细" });
		this.sizeSliderEl = sizeWrap.createEl("input", {
			type: "range",
			attr: { min: "1", max: "40", step: "1" },
		});
		this.sizeSliderEl.value = String(this.size);
		this.sizeLabelEl = sizeWrap.createSpan({ cls: "free-doodle-size-label" });
		this.sizeSliderEl.addEventListener("input", () => {
			this.size = Number(this.sizeSliderEl.value);
			this.sizeLabelEl.setText(String(this.size));
		});

		this.eraserBtnEl = toolbar.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "橡皮擦" },
		});
		setIcon(this.eraserBtnEl, "eraser");
		this.eraserBtnEl.addEventListener("click", () => {
			this.erasing = !this.erasing;
			this.syncToolbar();
		});

		const undoBtn = toolbar.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "撤销 (Ctrl+Z)" },
		});
		setIcon(undoBtn, "undo-2");
		undoBtn.addEventListener("click", () => this.undo());

		const clearBtn = toolbar.createEl("button", {
			cls: "free-doodle-btn clickable-icon",
			attr: { title: "清空画布" },
		});
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => this.clear());

		const saveBtn = toolbar.createEl("button", {
			cls: "free-doodle-btn free-doodle-save mod-cta",
			attr: { title: "保存为 PNG（同时复制到剪贴板）" },
		});
		setIcon(saveBtn, "save");
		saveBtn.createSpan({ text: "保存 PNG" });
		saveBtn.addEventListener("click", () => void this.saveToVault());

		this.syncToolbar();
	}

	private syncToolbar(): void {
		this.swatchEls.forEach((el) =>
			el.toggleClass(
				"is-active",
				!this.erasing && el.style.backgroundColor.toLowerCase() === this.color.toLowerCase()
			)
		);
		this.eraserBtnEl.toggleClass("is-active", this.erasing);
		if (this.colorInputEl) this.colorInputEl.value = this.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.size);
		if (this.sizeLabelEl) this.sizeLabelEl.setText(String(this.size));
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
		this.current = {
			color: this.color,
			size: this.size,
			erase: this.erasing,
			points: [this.toPoint(evt)],
		};
	}

	private onMove(evt: PointerEvent): void {
		const s = this.current;
		if (!s || !evt.isPrimary) return;
		s.points.push(this.toPoint(evt));
		const pts = s.points;
		const a = pts[pts.length - 2];
		const b = pts[pts.length - 1];
		this.ctx.save();
		this.ctx.lineCap = "round";
		this.ctx.lineJoin = "round";
		this.ctx.lineWidth = s.size;
		if (s.erase) {
			this.ctx.globalCompositeOperation = "destination-out";
			this.ctx.strokeStyle = "#000";
		} else {
			this.ctx.globalCompositeOperation = "source-over";
			this.ctx.strokeStyle = s.color;
		}
		this.ctx.beginPath();
		this.ctx.moveTo(a.x, a.y);
		this.ctx.lineTo(b.x, b.y);
		this.ctx.stroke();
		this.ctx.restore();
	}

	private onUp(): void {
		const s = this.current;
		if (!s) return;
		this.current = null;
		this.pushUndo();
		this.strokes.push(s);
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
					canvas.style.maxWidth = "100%";
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
				| Record<string, unknown>
				| undefined;
			const b64 = fm ? fm[FRONT_KEY] : undefined;
			if (typeof b64 !== "string" || b64.length === 0) continue;
			let isEmpty = true;
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

		containerEl.createEl("h3", { text: "Free Doodle 设置" });

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
					.setDynamicTooltip()
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

		containerEl.createEl("p", {
			text: "用法：打开任意笔记 → 点击左侧荧光笔图标或 Ctrl+D 进入涂鸦模式，直接在内容上划线标注；点击“完成”或按 Esc 退出。墨迹数据保存在笔记的 free-doodle 属性（frontmatter）中，不影响正文编辑；阅读模式会自动叠加显示。",
			cls: "free-doodle-setting-hint",
		});

		this.buildDiagnostics(containerEl);
	}

	private buildDiagnostics(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "诊断" });

		const textarea = containerEl.createEl("textarea", {
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

		new Setting(containerEl)
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
