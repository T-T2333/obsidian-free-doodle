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
	SettingDefinitionGroup,
	SettingDefinitionItem,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
	PluginManifest,
	requestUrl,
} from "obsidian";
import * as ort from "onnxruntime-web/wasm";
import "./hanzilookup.min.js";

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
	/** 笔刷类型（自由笔迹） */
	brush?: BrushId;
	/** 钢笔逐点宽度（速度感应，触控笔压感已折算） */
	w?: number[];
	/** 触控笔逐点压力 0-1（与 points 等长；仅触控笔书写时记录） */
	pr?: number[];
	/** 文本标注内容 */
	text?: string;
	/** 文本字体族（手写识别美化文字用；缺省用笔记正文字体） */
	font?: string;
	/** 浓度 0-100（铅笔颗粒、马克笔叠层） */
	density?: number;
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
	brush?: BrushId;
	w?: number[];
	pr?: number[];
	text?: string;
	font?: string;
	density?: number;
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

/* ---------- 手写识别（主：PP-OCRv5 / 回退：HanziLookupJS） ---------- */

interface HanziMatch {
	character: string;
	score: number;
}

interface HwLineMatch {
	text: string;
	score: number;
}

interface HanziLookupApi {
	data: Record<string, { chars: unknown[]; substrokes: string | Uint8Array }>;
	decodeCompact(s: string): Uint8Array;
	AnalyzedCharacter: new (strokes: number[][][]) => unknown;
	Matcher: new (name: string) => {
		match(ac: unknown, limit: number, cb: (matches: HanziMatch[]) => void): void;
	};
}

/** 库由 hanzilookup.min.js 挂到 window（脚本内 var 与 declare global 会冲突，故显式取用） */
function getHanziLookup(): HanziLookupApi | null {
	const hl = (window as unknown as { HanziLookup?: HanziLookupApi }).HanziLookup;
	return hl ?? null;
}

/** 首用下载镜像（按序尝试；首个成功后写入插件目录缓存） */
const MMAH_DATA_URLS = [
	"https://fastly.jsdelivr.net/gh/gugray/HanziLookupJS@master/dist/mmah.json",
	"https://cdn.jsdelivr.net/gh/gugray/HanziLookupJS@master/dist/mmah.json",
	"https://raw.githubusercontent.com/gugray/HanziLookupJS/master/dist/mmah.json",
];
const HW_DATA_FILE = "hanzi-mmah.json";
const IMPORTED_FONT_FAMILY = "FreeDoodleImportedFont";
const IMPORTED_FONT_BASENAME = "free-doodle-font";
const IMPORTED_FONT_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2"]);
const MAX_IMPORTED_FONT_BYTES = 50 * 1024 * 1024;
type ManagedFontFaceSet = FontFaceSet & {
	add(face: FontFace): ManagedFontFaceSet;
	delete(face: FontFace): boolean;
};

/** 自动替换的最低置信度 */
const HW_AUTO_MIN_SCORE = 0.5;
const HW_AUTO_DELAY_MS = 1200;

const PPOCR_MODEL_FILE = "ppocrv5_rec.ort";
const PPOCR_DICT_FILE = "ppocrv5_dict.txt";
const ORT_WASM_FILE = "ort-wasm-simd-threaded.wasm";
const ORT_MJS_FILE = "ort-wasm-simd-threaded.mjs";

interface HwAsset {
	file: string;
	minBytes: number;
	label: string;
	urls: string[];
}

/** 首用下载的 PP-OCR / ORT 运行时资源（约 28MB，缓存到插件目录） */
const HW_ASSETS: HwAsset[] = [
	{
		file: PPOCR_MODEL_FILE,
		minBytes: 16_000_000,
		label: "识别模型",
		urls: [
			"https://fastly.jsdelivr.net/npm/@ibus-qikai/models@0.1.4/assets/PP-OCRv5_rec_mobile_infer.ort",
			"https://cdn.jsdelivr.net/npm/@ibus-qikai/models@0.1.4/assets/PP-OCRv5_rec_mobile_infer.ort",
		],
	},
	{
		file: PPOCR_DICT_FILE,
		minBytes: 50_000,
		label: "字符表",
		urls: [
			"https://fastly.jsdelivr.net/npm/@ibus-qikai/models@0.1.4/assets/ppocrv5_dict.txt",
			"https://cdn.jsdelivr.net/npm/@ibus-qikai/models@0.1.4/assets/ppocrv5_dict.txt",
		],
	},
	{
		file: ORT_WASM_FILE,
		minBytes: 11_000_000,
		label: "推理运行时",
		urls: [
			"https://fastly.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm",
			"https://registry.npmmirror.com/onnxruntime-web/1.20.1/files/dist/ort-wasm-simd-threaded.wasm",
			"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm",
		],
	},
	{
		file: ORT_MJS_FILE,
		minBytes: 20_000,
		label: "推理加载器",
		urls: [
			"https://fastly.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs",
			"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs",
		],
	},
];

/** 笔迹集合的包围盒（含线宽），无有效点返回 null */
function strokesBBox(strokes: Stroke[]): { x: number; y: number; w: number; h: number } | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let any = false;
	for (const s of strokes) {
		if (s.erase || s.shape) continue;
		const pad = Math.max(2, s.size / 2);
		for (const p of s.points) {
			any = true;
			if (p.x - pad < minX) minX = p.x - pad;
			if (p.y - pad < minY) minY = p.y - pad;
			if (p.x + pad > maxX) maxX = p.x + pad;
			if (p.y + pad > maxY) maxY = p.y + pad;
		}
	}
	if (!any || maxX <= minX || maxY <= minY) return null;
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function textWidthEm(text: string): number {
	return Array.from(text).reduce(
		(sum, ch) => sum + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.58),
		0
	);
}

function buildHwLinePopover(
	host: HTMLElement,
	match: HwLineMatch,
	onApply: (text: string) => void,
	onKeep: () => void
): HTMLElement {
	const pop = host.createDiv({ cls: "free-doodle-popover free-doodle-hw-pop" });
	pop.createDiv({
		cls: "free-doodle-pop-label",
		text: `整行识别 · 置信度 ${match.score.toFixed(2)}`,
	});
	const input = pop.createEl("input", {
		cls: "free-doodle-hw-line-input",
		attr: { spellcheck: "false" },
	});
	input.value = match.text;
	const row = pop.createDiv({ cls: "free-doodle-pop-row free-doodle-hw-row" });
	const apply = row.createEl("button", { cls: "free-doodle-btn mod-cta", text: "采用整行" });
	const commit = () => {
		const text = input.value.trim();
		if (text) onApply(text);
	};
	apply.addEventListener("click", commit);
	const keep = row.createEl("button", { cls: "free-doodle-btn", text: "保留手写" });
	keep.addEventListener("click", onKeep);
	input.addEventListener("keydown", (e) => {
		if (e.isComposing) return;
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			onKeep();
		}
	});
	window.setTimeout(() => input.focus(), 30);
	return pop;
}

function hwTextStroke(batch: Stroke[], text: string, font: string): Stroke | null {
	const bb = strokesBBox(batch);
	if (!bb) return null;
	const pad = 4;
	const wantFs = Math.max(16, Math.round(bb.h + pad * 2));
	const size = Math.max(4, Math.round(wantFs / 4));
	const fs = Math.max(12, size * 4);
	const textW = fs * textWidthEm(text);
	const first = batch[0];
	return {
		color: first?.color ?? "#1e1e1e",
		size,
		erase: false,
		alpha: 1,
		text,
		font,
		points: [{ x: bb.x - pad + (bb.w + pad * 2 - textW) / 2, y: bb.y - pad }],
	};
}

function splitStrokeGroups(strokes: number[][][]): number[][][][] {
	const valid = strokes.filter((s) => s.some((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
	if (valid.length <= 1) return valid.length ? [valid] : [];
	const boxes = valid.map((stroke) => {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of stroke) {
			if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
			minX = Math.min(minX, p[0]);
			maxX = Math.max(maxX, p[0]);
			minY = Math.min(minY, p[1]);
			maxY = Math.max(maxY, p[1]);
		}
		return { minX, maxX, minY, maxY, size: Math.max(maxX - minX, maxY - minY) };
	});
	const sizes = boxes.map((b) => b.size).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
	const reference = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 1;
	const gap = Math.max(4, reference * 0.22);
	const ordered = valid.map((stroke, index) => ({ stroke, index, box: boxes[index] })).sort((a, b) => a.box.minX - b.box.minX);
	const groups: Array<Array<{ stroke: number[][]; index: number }>> = [];
	let current: Array<{ stroke: number[][]; index: number }> = [];
	let currentMaxX = -Infinity;
	for (const item of ordered) {
		if (!current.length || item.box.minX > currentMaxX + gap) {
			if (current.length) groups.push(current);
			current = [];
			currentMaxX = -Infinity;
		}
		current.push(item);
		currentMaxX = Math.max(currentMaxX, item.box.maxX);
	}
	if (current.length) groups.push(current);
	return groups.map((group) => group.sort((a, b) => a.index - b.index).map((item) => item.stroke));
}

/**
 * 手写识别引擎：首选 PP-OCRv5（位图 OCR，首用下载约 28MB 缓存到插件目录）；
 * 模型/运行时不可用时回退 HanziLookup 笔画匹配（约 0.8MB）。
 */
class HandwritingEngine {
	private ready = false;
	private loading: Promise<void> | null = null;
	private backend: "ppocr" | "hanzi" | null = null;
	private session: ort.InferenceSession | null = null;
	private dictionary: string[] = [];
	private mjsBlobUrl: string | null = null;
	private preCanvas: HTMLCanvasElement | null = null;
	private preCtx: CanvasRenderingContext2D | null = null;
	private floatBuf: Float32Array | null = null;
	private hanziReady = false;
	private disposed = false;
	private recognitionQueue: Promise<void> = Promise.resolve();
	private activeRecognitions = 0;

	constructor(private plugin: FreeDoodlePlugin) {}

	get backendName(): string {
		return this.backend ?? "none";
	}

	private pluginFile(name: string): string {
		const dir = this.plugin.manifest.dir;
		if (!dir) throw new Error("plugin manifest.dir missing");
		return `${dir}/${name}`;
	}

	async ensureReady(): Promise<void> {
		if (this.disposed) throw new Error("手写识别引擎已释放");
		if (this.ready) return;
		if (this.loading) return this.loading;
		this.loading = this.load();
		try {
			await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async load(): Promise<void> {
		if (this.disposed) return;
		try {
			await this.loadPpocr();
			if (this.disposed) return;
			this.backend = "ppocr";
			this.ready = true;
			return;
		} catch (e) {
			if (this.disposed) return;
			Diag.log(`PP-OCR 加载失败，回退 HanziLookup: ${String(e)}`);
		}
		if (this.disposed) return;
		await this.loadHanzi();
		if (this.disposed) return;
		this.backend = "hanzi";
		this.ready = true;
	}

	private async loadPpocr(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const need = (
			await Promise.all(
				HW_ASSETS.map(async (a) => {
					const path = this.pluginFile(a.file);
					if (!(await adapter.exists(path))) return true;
					const st = await adapter.stat(path);
					return !st || st.type !== "file" || st.size < a.minBytes;
				})
			)
		).some(Boolean);

		let notice: Notice | null = null;
		if (need) notice = new Notice("手写识别：首次使用需下载模型（约 28 mb），请稍候…", 0);
		try {
			for (const asset of HW_ASSETS) {
				await this.ensureAsset(asset);
				if (this.disposed) return;
			}
		} finally {
			notice?.hide();
		}

		const dictText = await adapter.read(this.pluginFile(PPOCR_DICT_FILE));
		if (dictText.includes("<html") || dictText.includes("<!DOCTYPE")) {
			throw new Error("字符表内容无效（拿到了 HTML）");
		}
		// 与 ibus-qikai 一致：索引 0 = CTC blank
		this.dictionary = ["", ...dictText.split(/\r?\n/)];
		if (this.dictionary.length < 100) throw new Error("字符表过短");

		const modelBuf = await adapter.readBinary(this.pluginFile(PPOCR_MODEL_FILE));
		const wasmBuf = await adapter.readBinary(this.pluginFile(ORT_WASM_FILE));
		if (!WebAssembly.validate(wasmBuf)) {
			throw new Error("推理运行时无效");
		}
		const mjsText = await adapter.read(this.pluginFile(ORT_MJS_FILE));
		if (mjsText.length < 1000 || !mjsText.includes("ortWasm")) {
			throw new Error("推理加载器内容无效");
		}
		const nodeDetector =
			'B="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node';
		const nodeFlag = "var isNode = typeof globalThis.process?.versions?.node == 'string';";
		const wasmUrlExpression = '(new URL("ort-wasm-simd-threaded.wasm",import.meta.url)).href';
		if (!mjsText.includes(nodeDetector) || !mjsText.includes(nodeFlag) || !mjsText.includes(wasmUrlExpression)) {
			throw new Error("推理加载器浏览器补丁失败");
		}
		const browserMjsText = mjsText
			.replace(nodeDetector, "B=false")
			.replace(nodeFlag, "var isNode = false;")
			.replace(wasmUrlExpression, '"ort-wasm-simd-threaded.wasm"');
		if (this.disposed) return;

		if (this.mjsBlobUrl) URL.revokeObjectURL(this.mjsBlobUrl);
		this.mjsBlobUrl = URL.createObjectURL(new Blob([browserMjsText], { type: "text/javascript" }));

		ort.env.wasm.proxy = false;
		ort.env.wasm.numThreads = 1;
		ort.env.wasm.wasmBinary = wasmBuf;
		ort.env.wasm.wasmPaths = { mjs: this.mjsBlobUrl };

		const session = await ort.InferenceSession.create(modelBuf, {
			executionProviders: ["wasm"],
		});
		if (this.disposed) {
			this.releaseSession(session);
			return;
		}
		this.session = session;
		Diag.log(
			`PP-OCR 就绪 backend=ppocr dict=${this.dictionary.length} inputs=${session.inputNames.join(",")}`
		);
	}

	private releaseSession(session: ort.InferenceSession): void {
		void session.release().catch((e) => Diag.log(`手写识别会话释放失败: ${String(e)}`));
	}

	private async ensureAsset(asset: HwAsset): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const path = this.pluginFile(asset.file);
		if (await adapter.exists(path)) {
			try {
				const st = await adapter.stat(path);
				if (st && st.type === "file" && st.size >= asset.minBytes) return;
			} catch {
				/* fall through to re-download */
			}
		}
		let lastErr: unknown = null;
		for (const url of asset.urls) {
			try {
				const res = await requestUrl({ url, method: "GET", headers: {} });
				const buf = res.arrayBuffer;
				if (buf.byteLength < asset.minBytes) {
					throw new Error(`响应过小 ${buf.byteLength}B`);
				}
				await adapter.writeBinary(path, buf);
				const st = await adapter.stat(path);
				if (!st || st.size < asset.minBytes) throw new Error("写入校验失败");
				Diag.log(`已缓存 ${asset.file} ${st.size}B ← ${url}`);
				return;
			} catch (e) {
				lastErr = e;
				Diag.log(`${asset.label}下载失败 ${url}: ${String(e)}`);
			}
		}
		throw lastErr instanceof Error
			? lastErr
			: new Error(`${asset.label}下载失败（请检查网络后重试）`);
	}

	private async loadHanzi(): Promise<void> {
		if (this.hanziReady) return;
		const path = this.pluginFile(HW_DATA_FILE);
		const adapter = this.plugin.app.vault.adapter;
		let text: string | null = null;
		try {
			if (await adapter.exists(path)) {
				text = await adapter.read(path);
				JSON.parse(text);
			}
		} catch {
			text = null;
		}
		if (text === null) {
			const notice = new Notice("手写识别：首次使用需下载汉字数据，请稍候…", 0);
			let lastErr: unknown = null;
			try {
				for (const url of MMAH_DATA_URLS) {
					try {
						const res = await requestUrl({ url, method: "GET", headers: {} });
						const body = res.text;
						const parsed = JSON.parse(body) as { chars?: unknown; substrokes?: unknown };
						if (!Array.isArray(parsed.chars) || typeof parsed.substrokes !== "string") {
							throw new Error("识别数据格式无效");
						}
						text = body;
						lastErr = null;
						break;
					} catch (e) {
						lastErr = e;
						Diag.log(`手写数据下载失败 ${url}: ${String(e)}`);
					}
				}
				if (text === null) {
					throw lastErr instanceof Error
						? lastErr
						: new Error("识别数据下载失败（请检查网络/代理后重试）");
				}
			} finally {
				notice.hide();
			}
			try {
				await adapter.write(path, text);
			} catch (e) {
				Diag.log(`手写数据缓存失败: ${String(e)}`);
			}
		}
		const json = JSON.parse(text) as { chars: unknown[]; substrokes: string };
		if (!Array.isArray(json.chars) || typeof json.substrokes !== "string") {
			throw new Error("识别数据格式无效，请删除插件目录内 hanzi-mmah.json 后重试");
		}
		if (this.disposed) return;
		const HL = getHanziLookup();
		if (!HL) throw new Error("识别引擎未加载（请重新启用插件）");
		HL.data["mmah"] = {
			chars: json.chars,
			substrokes: HL.decodeCompact(json.substrokes),
		};
		this.hanziReady = true;
		Diag.log(`手写数据就绪 chars=${json.chars.length}`);
	}

	dispose(): void {
		this.disposed = true;
		const session = this.session;
		this.session = null;
		this.dictionary = [];
		if (this.mjsBlobUrl) {
			URL.revokeObjectURL(this.mjsBlobUrl);
			this.mjsBlobUrl = null;
		}
		this.preCanvas = null;
		this.preCtx = null;
		this.floatBuf = null;
		this.ready = false;
		this.backend = null;
		this.hanziReady = false;
		if (session && this.activeRecognitions === 0) this.releaseSession(session);
	}

	recognize(strokes: number[][][], limit = 6): Promise<HwLineMatch> {
		const result = this.recognitionQueue.then(() => {
			if (this.disposed) throw new Error("手写识别引擎已释放");
			if (this.backend === "ppocr") return this.recognizePpocr(strokes);
			if (this.backend === "hanzi") return this.recognizeHanziLine(strokes, limit);
			throw new Error("手写识别引擎尚未就绪");
		});
		this.recognitionQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private async recognizeHanziLine(strokes: number[][][], limit: number): Promise<HwLineMatch> {
		const groups = splitStrokeGroups(strokes);
		const characters: string[] = [];
		for (const group of groups) {
			const matches = await this.recognizeHanzi(group, limit);
			const top = matches[0];
			if (!top) continue;
			characters.push(top.character);
		}
		return {
			text: characters.join(""),
			score: 0,
		};
	}

	/** 清洗点列：丢弃非有限坐标与空笔（单点以圆点形式保留在渲染阶段） */
	private cleanStrokes(strokes: number[][][]): number[][][] {
		return strokes
			.map((s) => s.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
			.filter((s) => s.length > 0);
	}

	/** 笔迹 → 黑色墨迹画布（透明底），供 OCR 裁剪 */
	private renderInk(strokes: number[][][]): HTMLCanvasElement | null {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let any = false;
		for (const s of strokes) {
			for (const p of s) {
				any = true;
				if (p[0] < minX) minX = p[0];
				if (p[1] < minY) minY = p[1];
				if (p[0] > maxX) maxX = p[0];
				if (p[1] > maxY) maxY = p[1];
			}
		}
		if (!any) return null;
		const pad = 6;
		const w = Math.max(1, maxX - minX + pad * 2);
		const h = Math.max(1, maxY - minY + pad * 2);
		// 限制渲染分辨率，避免超大笔迹撑爆内存
		const scale = Math.min(3, 960 / Math.max(w, h));
		const cw = Math.max(1, Math.ceil(w * scale));
		const ch = Math.max(1, Math.ceil(h * scale));
		const canvas = createEl("canvas");
		canvas.width = cw;
		canvas.height = ch;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.clearRect(0, 0, cw, ch);
		ctx.save();
		ctx.scale(scale, scale);
		ctx.translate(-minX + pad, -minY + pad);
		ctx.strokeStyle = "#000000";
		ctx.fillStyle = "#000000";
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const lw = Math.max(2, Math.min(w, h) * 0.07);
		ctx.lineWidth = lw;
		for (const s of strokes) {
			if (s.length === 1) {
				ctx.beginPath();
				ctx.arc(s[0][0], s[0][1], lw / 2, 0, Math.PI * 2);
				ctx.fill();
				continue;
			}
			ctx.beginPath();
			ctx.moveTo(s[0][0], s[0][1]);
			for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
			ctx.stroke();
		}
		ctx.restore();
		return canvas;
	}

	private preprocess(
		source: HTMLCanvasElement,
		forcedWidth?: number
	): { data: Float32Array; width: number } | null {
		const imgH = 48;
		const srcCtx = source.getContext("2d", { willReadFrequently: true });
		if (!srcCtx) return null;
		const sw = source.width;
		const sh = source.height;
		const srcData = srcCtx.getImageData(0, 0, sw, sh).data;
		let minX = sw;
		let minY = sh;
		let maxX = 0;
		let maxY = 0;
		let has = false;
		const step = 2;
		for (let y = 0; y < sh; y += step) {
			for (let x = 0; x < sw; x += step) {
				if (srcData[(y * sw + x) * 4 + 3] > 0) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
					has = true;
				}
			}
		}
		if (!has) return null;
		const box = {
			x: minX,
			y: minY,
			w: maxX - minX + 1,
			h: maxY - minY + 1,
		};
		const naturalWidth = Math.max(
			128,
			Math.min(960, Math.round((imgH * (box.w / box.h)) / 8) * 8)
		);
		const imgW = forcedWidth
			? Math.max(128, Math.round(forcedWidth / 8) * 8)
			: naturalWidth;
		if (!this.preCanvas) this.preCanvas = createEl("canvas");
		if (this.preCanvas.width !== imgW || this.preCanvas.height !== imgH) {
			this.preCanvas.width = imgW;
			this.preCanvas.height = imgH;
			this.preCtx = this.preCanvas.getContext("2d", { willReadFrequently: true });
		}
		const ctx = this.preCtx;
		if (!ctx) return null;
		ctx.fillStyle = "rgb(128, 128, 128)";
		ctx.fillRect(0, 0, imgW, imgH);
		const padding = 6;
		const availableW = Math.max(1, imgW - padding * 2);
		const availableH = imgH - padding * 2;
		const scale = Math.min(availableH / box.h, availableW / box.w);
		const drawW = box.w * scale;
		const drawH = box.h * scale;
		const dx = (imgW - drawW) / 2;
		const dy = padding + (availableH - drawH) / 2;
		ctx.drawImage(source, box.x, box.y, box.w, box.h, dx, dy, drawW, drawH);

		const imageData = ctx.getImageData(0, 0, imgW, imgH);
		const data = imageData.data;
		const n = imgH * imgW;
		if (!this.floatBuf || this.floatBuf.length !== n * 3) {
			this.floatBuf = new Float32Array(n * 3);
		}
		const floatData = this.floatBuf;
		for (let i = 0; i < n; i++) {
			const r = data[i * 4] / 255;
			const g = data[i * 4 + 1] / 255;
			const b = data[i * 4 + 2] / 255;
			floatData[i] = (b - 0.5) / 0.5;
			floatData[n + i] = (g - 0.5) / 0.5;
			floatData[2 * n + i] = (r - 0.5) / 0.5;
		}
		return { data: floatData, width: imgW };
	}

	private postprocess(out: Float32Array, dims: readonly number[]): HwLineMatch {
		const seqLen = dims.length >= 3 ? dims[dims.length - 2] : dims[0] ?? 0;
		const dictSize = dims[dims.length - 1] ?? 0;
		if (seqLen <= 0 || dictSize <= 0) return { text: "", score: 0 };
		let text = "";
		let scoreSum = 0;
		let scoreCount = 0;
		let previousIndex = -1;
		for (let t = 0; t < seqLen; t++) {
			const frameStart = t * dictSize;
			let bestIndex = 0;
			let bestProb = out[frameStart] ?? 0;
			for (let i = 1; i < dictSize; i++) {
				const prob = out[frameStart + i] ?? 0;
				if (prob > bestProb) {
					bestProb = prob;
					bestIndex = i;
				}
			}
			if (bestIndex > 0 && bestIndex !== previousIndex) {
				const character = this.dictionary[bestIndex] ?? "";
				if (character) {
					text += character;
					const nonBlank = Math.max(1 - (out[frameStart] ?? 0), 0.001);
					scoreSum += bestProb / nonBlank;
					scoreCount++;
				}
			}
			previousIndex = bestIndex;
		}
		return {
			text: text.replace(/[\r\n]+/g, " ").trim(),
			score: scoreCount ? scoreSum / scoreCount : 0,
		};
	}

	private async recognizePpocr(strokes: number[][][]): Promise<HwLineMatch> {
		const session = this.session;
		if (!session) return Promise.reject(new Error("PP-OCR 会话未就绪"));
		this.activeRecognitions++;
		try {
			const cleaned = this.cleanStrokes(strokes);
			if (!cleaned.length) return { text: "", score: 0 };
			const ink = this.renderInk(cleaned);
			if (!ink) return { text: "", score: 0 };
			const prepared = this.preprocess(ink);
			if (!prepared) return { text: "", score: 0 };
			const inputName = session.inputNames[0];
			if (!inputName) return { text: "", score: 0 };
			const runPrepared = async (value: { data: Float32Array; width: number }): Promise<HwLineMatch> => {
				const tensor = new ort.Tensor("float32", value.data, [1, 3, 48, value.width]);
				try {
					const results = await session.run({ [inputName]: tensor });
					try {
						const outName = session.outputNames[0];
						const output = outName ? results[outName] : undefined;
						if (!output) return { text: "", score: 0 };
						return this.postprocess(output.data as Float32Array, output.dims);
					} finally {
						for (const key of Object.keys(results)) {
							results[key]?.dispose();
						}
					}
				} finally {
					tensor.dispose();
				}
			};
			try {
				return await runPrepared(prepared);
			} catch (e) {
				if (this.disposed) throw e;
				const groups = splitStrokeGroups(cleaned);
				if (groups.length > 1) {
					const texts: string[] = [];
					const scores: number[] = [];
					for (const group of groups) {
						try {
							const one = await this.recognizePpocr(group);
							if (one.text) {
								texts.push(one.text);
								scores.push(one.score);
							}
						} catch {
							continue;
						}
					}
					if (texts.length) {
						return { text: texts.join(""), score: Math.min(...scores) };
					}
				}
				if (prepared.width === 128) throw e;
				const fallback = this.preprocess(ink, 128);
				if (!fallback) throw e;
				return runPrepared(fallback);
			}
		} finally {
			this.activeRecognitions--;
			if (this.disposed && this.activeRecognitions === 0) this.releaseSession(session);
		}
	}

	private recognizeHanzi(strokes: number[][][], limit: number): Promise<HanziMatch[]> {
		const HL = getHanziLookup();
		if (!HL) return Promise.reject(new Error("识别引擎未加载"));
		// 识别器要求每笔 ≥2 个有效点；空/单点笔画会抛错或永不回调
		const cleaned = strokes
			.map((s) => s.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
			.filter((s) => s.length >= 2);
		if (!cleaned.length) return Promise.resolve([]);

		let ac: unknown;
		try {
			ac = new HL.AnalyzedCharacter(cleaned);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new Error(String(e)));
		}
		const analyzed = ac as { analyzedStrokes?: unknown[] };
		if (!analyzed.analyzedStrokes || analyzed.analyzedStrokes.length === 0) {
			return Promise.resolve([]);
		}

		let matcher: { match(ac: unknown, limit: number, cb: (m: HanziMatch[]) => void): void };
		try {
			matcher = new HL.Matcher("mmah");
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new Error(String(e)));
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = window.setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error("识别超时"));
				}
			}, 8000);
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				fn();
			};
			try {
				// 多取一些再过滤无效分，避免 NaN/-Infinity 占位
				matcher.match(ac, Math.max(limit, 16), (matches) => {
					finish(() => {
						const good = (matches || [])
							.filter(
								(m) =>
									!!m &&
									typeof m.character === "string" &&
									m.character.length > 0 &&
									Number.isFinite(m.score)
							)
							.sort((a, b) => b.score - a.score)
							.slice(0, limit);
						resolve(good);
					});
				});
			} catch (e) {
				finish(() => reject(e instanceof Error ? e : new Error(String(e))));
			}
		});
	}
}

interface FreeDoodleSettings {
	penColor: string;
	penSize: number;
	saveFolder: string;
	autoFit: boolean;
	stylusPressure: boolean;
	/** 手写识别转文字后的美化字体 */
	hwFont: string;
	hwFontFile: string;
	hwFontName: string;
	brushes: Record<BrushId, BrushCfg>;
}

interface BrushCfg {
	size: number;
	opacity: number;
	density: number;
	stability: number;
}

const BRUSH_IDS: BrushId[] = ["pen", "pencil", "ball", "marker", "hl", "laser"];

const BRUSH_DEFAULTS: Record<BrushId, BrushCfg> = {
	pen: { size: 4, opacity: 1, density: 70, stability: 55 },
	pencil: { size: 3, opacity: 0.8, density: 45, stability: 35 },
	ball: { size: 3, opacity: 0.92, density: 85, stability: 65 },
	marker: { size: 10, opacity: 0.6, density: 60, stability: 70 },
	hl: { size: 10, opacity: 0.35, density: 50, stability: 60 },
	laser: { size: 6, opacity: 0.9, density: 90, stability: 85 },
};

function defaultBrushes(): Record<BrushId, BrushCfg> {
	const out = {} as Record<BrushId, BrushCfg>;
	for (const id of BRUSH_IDS) out[id] = { ...BRUSH_DEFAULTS[id] };
	return out;
}

const DEFAULT_SETTINGS: FreeDoodleSettings = {
	penColor: "#e03131",
	penSize: 4,
	saveFolder: "涂鸦",
	autoFit: true,
	stylusPressure: true,
	hwFont: "STKaiti, KaiTi, 楷体, 'Kaiti SC', 'Segoe Print', serif",
	hwFontFile: "",
	hwFontName: "",
	brushes: defaultBrushes(),
};

const PALETTE = [
	"#1e1e1e",
	"#e03131",
	"#f08c00",
	"#2f9e44",
	"#1971c2",
	"#9c36b5",
];

/** 统一使用笔记正文字体渲染文本标注 */
let TEXT_FONT_FAMILY = '"Segoe UI", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

function setFontFamilyFromCanvas(cv: HTMLCanvasElement): void {
	const f = getComputedStyle(cv).fontFamily;
	if (f) TEXT_FONT_FAMILY = f;
}

function frac(x: number): number {
	return x - Math.floor(x);
}

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

/**触控笔压力归一化：无压感设备/异常值回退 0.5（≈基准宽） */
function normPress(p: number): number {
	return Number.isFinite(p) && p > 0 ? Math.max(0.01, Math.min(1, p)) : 0.5;
}

/**压力 → 宽度系数：0.5 压力 ≈ 1.0 基准宽，范围 [0.35, 1.8] */
function pressScale(p: number): number {
	return Math.max(0.35, Math.min(1.8, 0.5 + (Number.isFinite(p) ? p : 0.5)));
}

/**合并同一帧内的高频指针事件（触控笔 120Hz+ 采样），无支持时回退单事件 */
function coalescedList(evt: PointerEvent): PointerEvent[] {
	try {
		const list = typeof evt.getCoalescedEvents === "function" ? evt.getCoalescedEvents() : [];
		if (list.length > 1 && list.length <= 64) return list;
	} catch {
		/* 某些实现可能抛错，回退即可 */
	}
	return [evt];
}

/**激光轨迹渲染前做一次 Chaikin 角点细分：平滑快速滑动的大转角，消除 butt 接缝缺口与透明度跳变 */
function smoothLaserPts(
	pts: Array<{ x: number; y: number; t: number }>
): Array<{ x: number; y: number; t: number }> {
	if (pts.length < 3) return pts;
	const out: Array<{ x: number; y: number; t: number }> = [pts[0]];
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		out.push({
			x: a.x * 0.75 + b.x * 0.25,
			y: a.y * 0.75 + b.y * 0.25,
			t: a.t * 0.75 + b.t * 0.25,
		});
		out.push({
			x: a.x * 0.25 + b.x * 0.75,
			y: a.y * 0.25 + b.y * 0.75,
			t: a.t * 0.25 + b.t * 0.75,
		});
	}
	out.push(pts[pts.length - 1]);
	return out;
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

	if (s.text) {
		// 文本标注：统一笔记字体
		const p = s.points[0];
		if (!p || !s.text.trim()) {
			ctx.restore();
			return;
		}
			const fs = Math.max(12, s.size * 4);
			if (!s.erase) {
				ctx.globalAlpha = s.alpha ?? 1;
				ctx.fillStyle = s.color;
				ctx.font = `${fs}px ${s.font ?? TEXT_FONT_FAMILY}`;
				ctx.textBaseline = "top";
				s.text.split("\n").forEach((ln, i) => ctx.fillText(ln, p.x, p.y + i * fs * 1.35));
			}
		ctx.restore();
		return;
	}

	const brush = s.brush ?? "pen";
	let alphaMul = 1;
	if (!s.erase && s.alpha !== undefined) alphaMul = Math.max(0.05, Math.min(1, s.alpha));
	if (brush === "ball") alphaMul *= 0.92;
	if (brush === "pencil") alphaMul *= 0.8;
	ctx.globalAlpha = s.erase ? 1 : alphaMul;

	ctx.lineCap = brush === "marker" || brush === "hl" ? "butt" : "round";
	const widthMul =
		brush === "marker" ? 1.6 : brush === "ball" ? 0.85 : brush === "pencil" ? 0.85 : 1;
	ctx.lineWidth = s.size * widthMul;
	if (brush === "laser") {
		ctx.shadowColor = s.color;
		ctx.shadowBlur = s.size * 2.2;
	}

	const density = Math.max(0, Math.min(100, s.density ?? 50));
	const passes = s.erase
		? 1
		: brush === "pencil"
			? 1 + Math.round(density / 40)
			: brush === "marker" || brush === "hl"
				? 1 + Math.round(density / 45)
				: 1;

	const pts = s.points;
	const pres =
		!s.erase &&
		!s.shape &&
		!s.text &&
		s.pr &&
		s.pr.length === pts.length &&
		pts.length > 1 &&
		(brush === "pen" || brush === "pencil" || brush === "ball")
			? s.pr
			: null;

	// 钢笔：逐段速度感应宽度（触控笔压感已在捕获期折算进 w）
	if (brush === "pen" && !s.erase && s.w && s.w.length === pts.length && pts.length > 1) {
		for (let i = 1; i < pts.length; i++) {
			ctx.lineWidth = ((s.w[i - 1] + s.w[i]) / 2) * widthMul;
			ctx.beginPath();
			ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
			ctx.lineTo(pts[i].x, pts[i].y);
			ctx.stroke();
		}
		ctx.restore();
		return;
	}

	if (pres) {
		// 触控笔压感：逐段变宽（仅书写类笔刷；荧光笔/马克笔保持恒宽）
		for (let i = 1; i < pts.length; i++) {
			ctx.lineWidth = s.size * widthMul * 0.5 * (pressScale(pres[i - 1]) + pressScale(pres[i]));
			ctx.beginPath();
			ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
			ctx.lineTo(pts[i].x, pts[i].y);
			ctx.stroke();
		}
	} else {
		for (let pass = 0; pass < passes; pass++) {
			if (pass > 0) ctx.globalAlpha = (s.alpha ?? 1) * 0.4;
			ctx.beginPath();
			if (pts.length === 1) {
				ctx.arc(pts[0].x, pts[0].y, Math.max(0.5, ctx.lineWidth / 2), 0, Math.PI * 2);
				ctx.fillStyle = s.erase ? "#000" : ctx.strokeStyle;
				ctx.fill();
			} else {
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
		}
	}

	// 铅笔颗粒（确定性散点，重绘稳定）
	if (brush === "pencil" && !s.erase && pts.length > 2) {
		const dots = Math.round((density / 100) * pts.length * 2);
		ctx.globalAlpha = alphaMul * 0.5;
		for (let i = 0; i < dots; i++) {
			const idx = Math.min(
				pts.length - 1,
				Math.floor((i / dots) * (pts.length - 1))
			);
			const h1 = frac(Math.sin((idx + 1) * 127.1) * 43758.5453);
			const h2 = frac(Math.sin((idx + 1) * 311.7) * 12543.21);
			const jx = (h1 - 0.5) * s.size * 0.9;
			const jy = (h2 - 0.5) * s.size * 0.9;
			ctx.beginPath();
			ctx.arc(pts[idx].x + jx, pts[idx].y + jy, Math.max(0.4, s.size * 0.16), 0, Math.PI * 2);
			ctx.fill();
		}
	}
	ctx.restore();
}

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]): void {
	for (const s of strokes) drawStroke(ctx, s);
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
 * 指数平滑（EMA）：逐点 O(1)、输出单调稳定，用于捕获期实时平滑。
 * 稳定性 0-100 → 平滑系数：越高越顺滑（跟随稍延迟）。
 */
function emaSmooth(
	prev: Point,
	p: Point,
	stability: number
): Point {
	const alpha = 0.9 - (Math.max(0, Math.min(100, stability)) / 100) * 0.72;
	return {
		x: prev.x + (p.x - prev.x) * alpha,
		y: prev.y + (p.y - prev.y) * alpha,
	};
}



function countCorners(pts: Point[], minTurnDeg: number): number {
	if (pts.length < 3) return 0;
	let c = 0;
	const rad = (minTurnDeg * Math.PI) / 180;
	for (let i = 1; i < pts.length - 1; i++) {
		const ax = pts[i].x - pts[i - 1].x;
		const ay = pts[i].y - pts[i - 1].y;
		const bx = pts[i + 1].x - pts[i].x;
		const by = pts[i + 1].y - pts[i].y;
		const la = Math.hypot(ax, ay);
		const lb = Math.hypot(bx, by);
		if (la < 2 || lb < 2) continue;
		const dot = (ax * bx + ay * by) / (la * lb);
		const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
		if (ang > rad) c++;
	}
	return c;
}

/** 几何自动拟合：开放笔迹→直线（水平/垂直吸附）；闭合笔迹→按角点数判定矩形或椭圆 */
function fitFreehand(s: Stroke): Stroke | null {
	if (s.shape || s.erase || s.text || s.points.length < 10) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of s.points) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	const w = x1 - x0;
	const h = y1 - y0;
	const diag = Math.hypot(w, h) || 1;
	const simp = rdpSimplify(s.points, Math.max(2.4, diag * 0.045));
	let v = simp.length;
	const first = simp[0];
	const last = simp[simp.length - 1];
	const gap = Math.hypot(first.x - last.x, first.y - last.y);
	const closed = gap < diag * 0.22;
	if (closed && v > 2) v--;

	if (!closed) {
		if (v === 2) {
			const A = { ...s.points[0] };
			const B = { ...s.points[s.points.length - 1] };
			if (Math.abs(B.y - A.y) <= diag * 0.07) B.y = A.y;
			else if (Math.abs(B.x - A.x) <= diag * 0.07) B.x = A.x;
			return { ...s, shape: "line", points: [A, B], w: undefined, pr: undefined };
		}
		return null;
	}

	const corners = countCorners(simp, 42);
	const tl = { x: x0, y: y0 };
	const br = { x: x1, y: y1 };
	if (corners >= 3 && corners <= 6)
		return { ...s, shape: "rect", points: [tl, br], w: undefined, pr: undefined };
	return { ...s, shape: "ellipse", points: [tl, br], w: undefined, pr: undefined };
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
			brush: (s.brush ?? "pen"),
			w: Array.isArray(s.w) ? s.w.filter((n) => typeof n === "number" && n > 0) : undefined,
			pr: Array.isArray(s.pr)
				? s.pr.filter((n) => typeof n === "number" && n >= 0 && n <= 1)
				: undefined,
			text: typeof s.text === "string" ? s.text : undefined,
			font: typeof s.font === "string" ? s.font : undefined,
			density: typeof s.density === "number" ? Math.max(0, Math.min(100, s.density)) : undefined,
		}))
		.filter((s) => s.points.length > 0 || !!s.text);
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
	/** 手写识别模式下累计的笔迹（识别后替换为美化文字） */
	private hwBatch: Stroke[] = [];
	private hwBusy = false;
	private hwAutoT: number | null = null;

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
	private activeBrush: BrushId = "pen";
	private cfgSaveT: number | null = null;

	private curBrushId(): BrushId {
		return brushOf(this.tool.mode) ?? this.activeBrush;
	}

	private curCfg(): BrushCfg {
		return this.plugin.settings.brushes[this.curBrushId()];
	}

	private queueSaveSettings(): void {
		if (this.cfgSaveT) window.clearTimeout(this.cfgSaveT);
		this.cfgSaveT = window.setTimeout(() => void this.plugin.saveSettings(), 350);
	}

	private effSize(): number {
		return this.curCfg().size;
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

	getDiagMode(): string {
		return this.tool.mode;
	}

	getDiagHwBatch(): number {
		return this.hwBatch.length;
	}

	isDiagInteractive(): boolean {
		return this.interactive;
	}

	refreshFont(): void {
		this.redraw();
	}

	/** 命令面板入口：进入手写识别模式 */
	enterHwMode(): void {
		if (!this.interactive || this.destroyed) {
			new Notice("请先进入涂鸦模式再使用手写识别");
			return;
		}
		this.setMode("hw");
	}

	destroy(save: boolean): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.cancelHwAuto();
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
		// 设置防抖未落盘时立即保存，避免 350ms 内卸载丢失笔刷/样式修改
		if (this.cfgSaveT !== null) {
			window.clearTimeout(this.cfgSaveT);
			this.cfgSaveT = null;
			void this.plugin.saveSettings();
		}
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

	private framePending = false;

	/** rAF 合帧的重绘请求：ResizeObserver / DOM 变化等高频事件统一走这里 */
	private requestRepaint(): void {
		if (this.framePending || this.destroyed) return;
		this.framePending = true;
		window.requestAnimationFrame(() => {
			this.framePending = false;
			if (this.destroyed) return;
			if (!this.canvas || !this.canvas.isConnected) {
				this.mount();
				return;
			}
			this.applySize();
			this.redraw();
		});
	}

	private watchDom(): void {
		this.mo?.disconnect();
		this.mo = new MutationObserver(() => {
			if (this.destroyed) return;
			// 笔记内容变化后文字块缓存即失效，避免锚定到已分离的旧元素
			this.candCache = null;
			this.requestRepaint();
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
			setFontFamilyFromCanvas(canvas);
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
			if (!this.destroyed) this.requestRepaint();
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
		canvas.setCssStyles({
			width: `${w}px`,
			height: `${h}px`,
		});
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.rebuildBase();
		this.paint();
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
			{ id: "pen" as const, icon: "pen-tool", title: "钢笔（速度感应粗细）" },
			{ id: "pencil" as const, icon: "pencil", title: "铅笔（颗粒质感）" },
			{ id: "ball" as const, icon: "pen", title: "圆珠笔" },
			{ id: "marker" as const, icon: "paintbrush", title: "马克笔（宽头）" },
			{ id: "hl" as const, icon: "highlighter", title: "荧光笔" },
			{ id: "laser" as const, icon: "flashlight", title: "激光笔（发光）" },
		];
		for (const t of tools) {
			const b = mkBtn(t.icon, t.title, () => this.onToolClick(t.id));
			this.toolBtnEls[t.id] = b;
		}

		tb.createDiv({ cls: "free-doodle-sep" });

		this.toolBtnEls["hw"] = mkBtn("languages", "手写识别：写一行，停顿后自动替换为美化文字", () =>
			this.setMode("hw")
		);
		this.toolBtnEls["hwrun"] = mkBtn("sparkles", "手动识别并编辑整行（自动识别的兜底）", () =>
			void this.runHandwriting(false)
		);

		tb.createDiv({ cls: "free-doodle-sep" });

		this.toolBtnEls["shape"] = mkBtn(
			"shapes",
			"形状：直线/箭头/矩形/椭圆/菱形",
			() => this.openShapePopover(this.toolBtnEls["shape"])
		);
		this.toolBtnEls["text"] = mkBtn("type", "文本标注：点击画布插入文字", () =>
			this.setMode("text")
		);
		this.toolBtnEls["erase"] = mkBtn(
			"eraser",
			"橡皮：像素 / 整笔擦除",
			() => this.openErasePopover(this.toolBtnEls["erase"])
		);

		this.toolBtnEls["fit"] = mkBtn(
			"check-check",
			"一键修正：最后一笔拟合为直线/矩形/椭圆",
			() => this.fitLast()
		);

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
		this.toolBtnEls["redo"] = mkBtn("redo-2", "重做 (Ctrl+Shift+Z)", () => this.redo());
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

	private fitLast(): void {
		// 从最后一笔向前找到最近的可拟合自由笔迹（跳过形状/文本/擦除笔）
		for (let i = this.strokes.length - 1; i >= 0; i--) {
			const s = this.strokes[i];
			if (s.erase || s.shape || s.text) continue;
			const fitted = fitFreehand(s);
			if (!fitted) continue;
			this.undoStack.push(this.strokes.slice());
			if (this.undoStack.length > 50) this.undoStack.shift();
			this.redoStack.length = 0;
			this.strokes[i] = fitted;
			this.syncTool();
			this.redraw();
			this.scheduleSave();
			new Notice("已修正为规则图形");
			return;
		}
		new Notice("最近的自由笔迹无法拟合为规则图形");
	}

	private onToolClick(
		id: ToolMode | "erase" | "style" | "mic" | "undo" | "trash" | "hwrun"
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
			case "hwrun":
				void this.runHandwriting(false);
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
		pop.setCssStyles({
			left: "0px",
			top: "0px",
			visibility: "hidden",
		});
		const pw = pop.offsetWidth || 240;
		const ph = pop.offsetHeight || 140;
		let left = Math.max(4, Math.round(aRect.left - cRect.left));
		if (left + pw > cRect.width - 6) left = Math.max(4, cRect.width - pw - 6);
		let top = aRect.bottom - cRect.top + 6;
		if (top + ph > cRect.height - 6)
			top = Math.max(4, Math.max(0, aRect.top - cRect.top - ph - 6));
		pop.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			visibility: "visible",
		});
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover && !this.popover.contains(t) && !anchor.contains(t)) {
				this.closePopover();
			}
		};
		this.popCloser = closer;
		window.setTimeout(() => window.addEventListener("pointerdown", closer, true), 0);
	}

	private startLaser(): void {
		this.laserPts = [];
		if (!this.laserRunning) {
			this.laserRunning = true;
			window.requestAnimationFrame(() => this.laserLoop());
		}
	}

	private pushLaser(p: Point): void {
		this.laserPts.push({ x: p.x, y: p.y, t: performance.now() });
	}

	private laserLoop(): void {
		if (this.destroyed || !this.ctx) {
			this.laserRunning = false;
			return;
		}
		const now = performance.now();
		const fade = 900;
		this.laserPts = this.laserPts.filter((q) => now - q.t < fade);
		this.paint();
		const cfg = this.plugin.settings.brushes.laser;
		const ctx = this.ctx;
		const pts = smoothLaserPts(this.laserPts);
		if (pts.length > 1) {
			ctx.save();
			ctx.lineCap = "butt";
			ctx.lineJoin = "round";
			ctx.strokeStyle = this.tool.color;
			ctx.lineWidth = cfg.size;
			for (let i = 1; i < pts.length; i++) {
				const p0 = pts[i - 1];
				const p1 = pts[i];
				const age = (now - p1.t) / fade;
				if (age >= 1) continue;
				// 先画的先淡出：每段透明度取决于自身年龄（恒定线宽避免接缝）
				ctx.globalAlpha = (1 - age) * cfg.opacity;
				ctx.beginPath();
				ctx.moveTo(p0.x, p0.y);
				ctx.lineTo(p1.x, p1.y);
				ctx.stroke();
			}
			ctx.restore();
		}
		// 轨迹点淡出完毕且已松开时停止循环
		const tip = pts[pts.length - 1];
		if (tip) {
			ctx.save();
			ctx.globalAlpha = Math.max(0.3, 1 - (now - tip.t) / fade);
			ctx.fillStyle = "#ffffff";
			ctx.shadowColor = this.tool.color;
			ctx.shadowBlur = cfg.size * 1.8;
			ctx.beginPath();
			ctx.arc(tip.x, tip.y, Math.max(2.5, cfg.size * 0.45), 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		if (this.laserPts.length > 0 || this.laserDown) {
			window.requestAnimationFrame(() => this.laserLoop());
		} else {
			this.laserRunning = false;
		}
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
				b.setCssStyles({ backgroundColor: c });
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

			const bid = this.curBrushId();
			const cfg = this.plugin.settings.brushes[bid];

			const sizeRow = el.createDiv({ cls: "free-doodle-pop-row" });
			sizeRow.createSpan({ cls: "free-doodle-pop-label", text: "粗细 px" });
			const sizeSlider = sizeRow.createEl("input", {
				cls: "free-doodle-slider",
				type: "range",
				attr: { min: "1", max: "40", step: "1" },
			});
			sizeSlider.value = String(cfg.size);
			const sizeVal = sizeRow.createSpan({
				cls: "free-doodle-size-label",
				text: `${cfg.size} px`,
			});
			sizeSlider.addEventListener("input", () => {
				cfg.size = Number(sizeSlider.value);
				sizeVal.setText(`${cfg.size} px`);
				// penSize 是钢笔粗细的兼容镜像，保持同步
				if (bid === "pen") this.plugin.settings.penSize = cfg.size;
				this.syncTool();
				this.queueSaveSettings();
			});

			const opRow = el.createDiv({ cls: "free-doodle-pop-row" });
			opRow.createSpan({ cls: "free-doodle-pop-label", text: "不透明" });
			const opSlider = opRow.createEl("input", {
				cls: "free-doodle-slider",
				type: "range",
				attr: { min: "10", max: "100", step: "5" },
			});
			opSlider.value = String(Math.round(cfg.opacity * 100));
			const opVal = opRow.createSpan({
				cls: "free-doodle-size-label",
				text: `${Math.round(cfg.opacity * 100)}%`,
			});
			opSlider.addEventListener("input", () => {
				cfg.opacity = Number(opSlider.value) / 100;
				opVal.setText(`${opSlider.value}%`);
				this.syncTool();
				this.queueSaveSettings();
			});

			if (bid !== "pen") {
				const deRow = el.createDiv({ cls: "free-doodle-pop-row" });
				deRow.createSpan({ cls: "free-doodle-pop-label", text: "浓度" });
				const deSlider = deRow.createEl("input", {
					cls: "free-doodle-slider",
					type: "range",
					attr: { min: "0", max: "100", step: "5" },
				});
				deSlider.value = String(Math.round(cfg.density));
				deSlider.addEventListener("input", () => {
					cfg.density = Number(deSlider.value);
					this.queueSaveSettings();
				});
			}

			const stRow = el.createDiv({ cls: "free-doodle-pop-row" });
			stRow.createSpan({ cls: "free-doodle-pop-label", text: "稳定" });
			const stSlider = stRow.createEl("input", {
				cls: "free-doodle-slider",
				type: "range",
				attr: { min: "0", max: "100", step: "5" },
			});
			stSlider.value = String(Math.round(cfg.stability));
			stSlider.addEventListener("input", () => {
				cfg.stability = Number(stSlider.value);
				this.queueSaveSettings();
			});

			const afRow = el.createDiv({ cls: "free-doodle-pop-row" });
			afRow.createSpan({ cls: "free-doodle-pop-label", text: "自动拟合" });
			const afBtn = afRow.createEl("button", {
				cls: "free-doodle-btn free-doodle-wpreset",
				text: this.plugin.settings.autoFit ? "开" : "关",
			});
			afBtn.toggleClass("is-active", this.plugin.settings.autoFit);
			afBtn.addEventListener("click", () => {
				this.plugin.settings.autoFit = !this.plugin.settings.autoFit;
				afBtn.setText(this.plugin.settings.autoFit ? "开" : "关");
				afBtn.toggleClass("is-active", this.plugin.settings.autoFit);
				this.queueSaveSettings();
			});

			const smRow = el.createDiv({ cls: "free-doodle-pop-row" });
			smRow.createSpan({ cls: "free-doodle-pop-label", text: "平滑预览" });
			const smBtn = smRow.createEl("button", {
				cls: "free-doodle-btn clickable-icon",
				attr: { title: "绘制时实时显示美化后的笔迹" },
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
		// 切走手写模式时保留批次（识别前再过滤已撤销笔画），便于回头点识别
		if (mode === "hw" && this.tool.mode !== "hw") {
			this.hwBatch = this.hwBatch.filter((s) => this.strokes.includes(s));
			Diag.log(`setMode→hw batch=${this.hwBatch.length}`);
			new Notice("手写模式：可写多个字/英文/数字，停顿约 1.2 秒后自动替换整行");
		} else {
			Diag.log(`setMode ${this.tool.mode}→${mode}`);
		}
		if (mode !== "hw") this.cancelHwAuto();
		this.tool.mode = mode;
		// 切到荧光笔时若笔刷不透明度过高，自动降为典型荧光笔透明
		// （笔迹 alpha 取自 curCfg().opacity，必须改笔刷配置而非 tool.opacity）
		if (mode === "hl") {
			const cfg = this.curCfg();
			if (cfg.opacity > 0.6) {
				cfg.opacity = 0.35;
				this.tool.opacity = 0.35;
				if (this.opacitySliderEl)
					this.opacitySliderEl.value = String(Math.round(0.35 * 100));
				this.queueSaveSettings();
			}
		}
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		if (this.wrap) this.wrap.dataset.cursor = mode === "text" ? "text" : "draw";
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
		for (const id of ["pencil", "ball", "marker", "laser", "hw"] as const) {
			const b = this.toolBtnEls[id];
			if (b) b.toggleClass("is-active", this.tool.mode === id);
		}
		const textBtn = this.toolBtnEls["text"];
		if (textBtn) textBtn.toggleClass("is-active", this.tool.mode === "text");
		const hwRunBtn = this.toolBtnEls["hwrun"] as HTMLButtonElement | undefined;
		if (hwRunBtn) hwRunBtn.disabled = this.hwBusy || this.hwBatch.length === 0;
		if (this.colorInputEl) this.colorInputEl.value = this.tool.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.tool.size);
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		if (this.opacitySliderEl)
			this.opacitySliderEl.value = String(Math.round(this.tool.opacity * 100));
		if (this.opacityLabelEl)
			this.opacityLabelEl.setText(`${Math.round(this.tool.opacity * 100)}%`);
		const undoBtn = this.toolBtnEls["undo"] as HTMLButtonElement | undefined;
		if (undoBtn) undoBtn.disabled = this.undoStack.length === 0;
		const redoBtn = this.toolBtnEls["redo"] as HTMLButtonElement | undefined;
		if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
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
			if (!txt.trim()) return;
			if (this.view.getMode() === "preview") {
				new Notice("语音输入需在编辑模式（实时预览）下使用");
				return;
			}
			this.view.editor.replaceSelection(txt + " ");
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

	private penLastTs = 0;
	private activePointerId: number | null = null;
	private activePointerType: string | null = null;

	private onDown = (evt: PointerEvent): void => {
		if (!this.interactive) return;
		const canvas = this.canvas;
		if (!canvas) return;
		const pen = evt.pointerType === "pen";
		if (pen) {
			// 已有非触摸指针在画时，忽略第二支笔/次要指针（允许笔接管触摸/手掌的笔迹）
			if (!evt.isPrimary && (this.current || this.laserDown) && this.activePointerType !== "touch")
				return;
			this.penLastTs = performance.now();
		} else {
			if (!evt.isPrimary) return;
			// 掌触拒绝：触控笔活动后 1s 内忽略触摸输入
			if (evt.pointerType === "touch" && performance.now() - this.penLastTs < 1000) return;
		}
		this.activePointerId = evt.pointerId;
		this.activePointerType = evt.pointerType;
		this.rect = canvas.getBoundingClientRect();
		canvas.setPointerCapture(evt.pointerId);
		const p = this.toPoint(evt);

		if (this.tool.mode === "laser") {
			this.laserDown = true;
			this.startLaser();
			return;
		}
		if (this.tool.mode === "text") {
			this.beginTextAt(p);
			return;
		}

		if (this.tool.mode === "eraseStroke") {
			this.strokeEraseUndoArmed = true;
			if (this.removeStrokesNear(p) > 0) this.syncTool();
			return;
		}

		const erase = this.tool.mode === "erasePx";
		const bid = brushOf(this.tool.mode);
		if (bid) this.activeBrush = bid;
		const cfg = this.curCfg();
		this.current = {
			color: this.tool.color,
			size: cfg.size,
			erase,
			alpha: erase ? undefined : cfg.opacity,
			density: cfg.density,
			brush: bid ?? undefined,
			w: bid === "pen" ? [Math.max(2, cfg.size)] : undefined,
			pr:
				pen && !erase && this.tool.mode !== "shape" && this.plugin.settings.stylusPressure
					? [normPress(evt.pressure)]
					: undefined,
			points: [p],
			shape: this.tool.mode === "shape" ? this.shapeKind : undefined,
		};
	};

	private beginTextAt(p: Point): void {
		const content = this.view.contentEl;
		this.closePopover();
		const pop = content.createDiv({ cls: "free-doodle-popover free-doodle-text-pop" });
		this.popover = pop;
		pop.setCssStyles({
			left: `${Math.round(p.x)}px`,
			top: `${Math.round(Math.max(4, p.y - 14))}px`,
		});
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover === pop && !pop.contains(t)) this.closePopover();
		};
		this.popCloser = closer;
		window.addEventListener("pointerdown", closer, true);
		const input = pop.createEl("input", {
			cls: "free-doodle-text-input",
			attr: { placeholder: "输入文字后按回车确认", spellcheck: "false" },
		});
		window.setTimeout(() => input.focus(), 30);
		const commit = () => {
			const t = input.value.trim();
			this.closePopover();
			if (!t) return;
			const st: Stroke = {
				color: this.tool.color,
				size: this.curCfg().size,
				erase: false,
				alpha: this.curCfg().opacity,
				text: t,
				points: [p],
			};
			this.attachAnchor(st);
			this.undoStack.push(this.strokes.slice());
			if (this.undoStack.length > 50) this.undoStack.shift();
			this.redoStack.length = 0;
			this.strokes.push(st);
			this.redraw();
			this.scheduleSave();
			this.syncTool();
		};
		input.addEventListener("keydown", (e) => {
			// 中文等输入法组合期的回车不提交
			if (e.isComposing) return;
			if (e.key === "Enter") commit();
			else if (e.key === "Escape") this.closePopover();
		});
		pop.createEl("button", { cls: "free-doodle-btn mod-cta", text: "确定" }).addEventListener(
			"click",
			commit
		);
	}

	private strokeEraseUndoArmed = false;

	private laserPts: Array<{ x: number; y: number; t: number }> = [];
	private laserRunning = false;
	private laserDown = false;

	private removeStrokesNear(p: Point, deferRedraw = false): number {
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
			if (s.text && s.points.length >= 1) {
				// 文本标注：按估算文本框命中
				const p0 = s.points[0];
				const fs = Math.max(12, s.size * 4);
				const wEst = s.text.length * fs * 0.6;
				const hEst = fs * 1.35;
				hit =
					px >= p0.x - th &&
					px <= p0.x + wEst + th &&
					py >= p0.y - th &&
					py <= p0.y + hEst + th;
			} else if (!s.shape) {
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
					this.redoStack.length = 0;
					if (this.undoStack.length > 50) this.undoStack.shift();
					this.strokeEraseUndoArmed = false;
				}
				this.strokes.splice(i, 1);
				removed++;
			}
		}
		if (removed > 0 && !deferRedraw) {
			this.redraw();
			this.scheduleSave();
		}
		return removed;
	}

	private inkCanvas: HTMLCanvasElement | null = null;
	private inkCtx: CanvasRenderingContext2D | null = null;
	private inkCount = -1;

	/** 当前笔迹渲染到独立图层（满透明度），合成时叠加真实不透明度：无端点残影、无抖动 */
	private renderInkLayer(s: Stroke): void {
		if (!this.inkCanvas || !this.inkCtx) {
			this.inkCanvas = document.createElement("canvas");
			this.inkCtx = this.inkCanvas.getContext("2d");
		}
		const ic = this.inkCanvas;
		const ictx = this.inkCtx!;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const tw = Math.floor(this.cw * dpr);
		const th = Math.floor(this.ch * dpr);
		if (ic.width !== tw || ic.height !== th) {
			ic.width = tw;
			ic.height = th;
			this.inkCount = -1;
		}
		ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ictx.clearRect(0, 0, this.cw, this.ch);
		drawStroke(ictx, s);
		this.inkCount = s.points.length;
	}

	private schedulePreview(): void {
		if (this.previewScheduled) return;
		this.previewScheduled = true;
		window.requestAnimationFrame(() => {
			this.previewScheduled = false;
			const s = this.current;
			const ctx = this.ctx;
			if (!s || !ctx || this.destroyed) return;
			this.paint();
			if (s.erase || s.shape || s.text) {
				drawStroke(ctx, s);
				return;
			}
			if (s.points.length !== this.inkCount) this.renderInkLayer(s);
			// ink 层内 drawStroke 已应用 alpha，合成时不能再乘一次
			ctx.drawImage(this.inkCanvas!, 0, 0, this.cw, this.ch);
		});
	}

	private onMove = (evt: PointerEvent): void => {
		const pen = evt.pointerType === "pen";
		if (pen) {
			this.penLastTs = performance.now();
		} else {
			if (!evt.isPrimary) return;
			if (evt.pointerType === "touch" && performance.now() - this.penLastTs < 1000) return;
		}
		if (this.tool.mode === "laser") {
			if (this.laserDown) {
				for (const e of coalescedList(evt)) this.pushLaser(this.toPoint(e));
			}
			return;
		}
		// 整笔擦除拖动（需按住；悬停不误擦；合并采样防止快速拖动漏擦）
		if (
			!this.current &&
			this.interactive &&
			this.tool.mode === "eraseStroke" &&
			(evt.buttons & 1) !== 0
		) {
			let any = false;
			for (const e of coalescedList(evt)) {
				if (this.removeStrokesNear(this.toPoint(e), true) > 0) any = true;
			}
			if (any) {
				this.redraw();
				this.scheduleSave();
				this.syncTool();
			}
			return;
		}
		const s = this.current;
		if (!s) return;

		const list = coalescedList(evt);
		if (s.shape) {
			s.points[1] = this.toPoint(list[list.length - 1]);
		} else {
			for (const e of list) {
				const raw = this.toPoint(e);
				const prev = s.points[s.points.length - 1] ?? raw;
				const sm = emaSmooth(prev, raw, this.curCfg().stability);
				s.points.push(sm);
				if (s.pr) s.pr.push(normPress(e.pressure));
				if (s.brush === "pen" && s.w) {
					// 速度感应宽度：越慢越粗（基于平滑后坐标）；触控笔再叠压感
					const speed = Math.hypot(sm.x - prev.x, sm.y - prev.y);
					const base = this.curCfg().size;
					let wv = Math.max(
						base * 0.45,
						Math.min(base * 1.5, base * (1.45 - speed * 0.03))
					);
					if (s.pr) {
						wv = Math.max(
							base * 0.2,
							Math.min(base * 2.2, wv * pressScale(s.pr[s.pr.length - 1]))
						);
					}
					s.w.push(wv);
				}
			}
		}
		this.schedulePreview();
	};

	private onUp = (evt?: PointerEvent): void => {
		// 仅响应本次捕获指针的抬起/取消，避免其它指针提前提交
		if (evt && evt.pointerId !== this.activePointerId) return;
		this.activePointerId = null;
		this.activePointerType = null;
		this.laserDown = false;
		if (this.tool.mode === "laser") return; // 淡出由激光循环处理
		const s = this.current;
		if (!s) return;
		this.current = null;

		// 形状拖动距离过小则丢弃（重绘清除预览残影）
		if (s.shape && s.points.length >= 2) {
			const a = s.points[0];
			const b = s.points[s.points.length - 1];
			if (Math.abs(b.x - a.x) < 4 && Math.abs(b.y - a.y) < 4) {
				this.redraw();
				return;
			}
		}

		// 笔迹平滑已在捕获期完成（EMA），此处仅做几何自动拟合
		// 手写识别模式：原始笔迹入批次，不自动拟合
		let final: Stroke = s;
		if (this.tool.mode === "hw") {
			this.hwBatch.push(final);
			Diag.log(`hw入批 batch=${this.hwBatch.length} pts=${final.points.length}`);
			this.undoStack.push(this.strokes.slice());
			this.redoStack.length = 0;
			if (this.undoStack.length > 50) this.undoStack.shift();
			this.strokes.push(final);
			this.redraw();
			this.scheduleSave();
			this.syncTool();
			this.scheduleHwAuto();
			return;
		}
		if (this.plugin.settings.autoFit) {
			const fitted = fitFreehand(final);
			if (fitted) final = fitted;
		}

		this.attachAnchor(final);
		this.undoStack.push(this.strokes.slice());
		this.redoStack.length = 0;
		if (this.undoStack.length > 50) this.undoStack.shift();
		this.strokes.push(final);
		this.redraw();
		this.scheduleSave();
		this.syncTool();
	};

	/** 手写停顿后自动识别并替换整行（✨ 为手动编辑兜底） */
	private scheduleHwAuto(): void {
		this.cancelHwAuto();
		this.hwAutoT = window.setTimeout(() => {
			this.hwAutoT = null;
			void this.runHandwriting(true);
		}, HW_AUTO_DELAY_MS);
	}

	private cancelHwAuto(): void {
		if (this.hwAutoT !== null) {
			window.clearTimeout(this.hwAutoT);
			this.hwAutoT = null;
		}
	}

	private async runHandwriting(auto = false): Promise<void> {
		Diag.log(`runHandwriting mode=${this.tool.mode} batch=${this.hwBatch.length} busy=${this.hwBusy} auto=${auto}`);
		if (this.hwBusy) {
			if (auto) this.scheduleHwAuto();
			return;
		}
		this.hwBatch = this.hwBatch.filter((s) => this.strokes.includes(s));
		const batch = this.hwBatch.slice();
		if (!batch.length) {
			if (!auto) new Notice("请先切到手写识别工具，写一行字，再点识别按钮");
			return;
		}
		this.hwBusy = true;
		this.syncTool();
		const notice = new Notice("手写识别：加载数据…", 0);
		try {
			await this.plugin.hwEngine.ensureReady();
			if (!this.isHwBatchCurrent(batch)) return;
			notice.setMessage("手写识别：识别中…");
			const pts = batch.map((s) => s.points.map((p) => [p.x, p.y]));
			Diag.log(`手写识别 strokes=${pts.length} pts=${pts.map((s) => s.length).join(",")}`);
			const result = await this.plugin.hwEngine.recognize(pts, 6);
			if (!this.isHwBatchCurrent(batch)) {
				Diag.log("手写识别结果已丢弃：批次已被撤销或清除");
				return;
			}
			Diag.log(
				`手写识别结果 text=${JSON.stringify(result.text)} score=${result.score.toFixed(3)} ` +
					`chars=${Array.from(result.text).length} backend=${this.plugin.hwEngine.backendName}`
			);
			if (!result.text.trim()) {
				if (!auto) new Notice("未识别出文字：请写完整一行并保留字符之间的空隙");
				return;
			}
			if (auto && result.score < HW_AUTO_MIN_SCORE) {
				Diag.log(`自动替换跳过 score=${result.score.toFixed(3)} < ${HW_AUTO_MIN_SCORE}`);
				this.showHwLinePopover(result, batch);
			} else if (auto) {
				this.applyHwText(result.text, batch);
			} else {
				this.showHwLinePopover(result, batch);
			}
		} catch (e) {
			Diag.log(`手写识别失败: ${String(e)}`);
			if (!auto) new Notice(`手写识别失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			notice.hide();
			this.hwBusy = false;
			this.syncTool();
		}
	}

	private isHwBatchCurrent(batch: Stroke[]): boolean {
		return batch.every((s) => this.hwBatch.includes(s) && this.strokes.includes(s));
	}

	private showHwLinePopover(result: HwLineMatch, batch: Stroke[]): void {
		if (!this.isHwBatchCurrent(batch)) return;
		const host = this.view.contentEl;
		this.closePopover();
		const pop = buildHwLinePopover(
			host,
			result,
			(text) => this.applyHwText(text, batch),
			() => {
				this.hwBatch = this.hwBatch.filter((s) => !batch.includes(s));
				this.closePopover();
				this.syncTool();
			}
		);
		this.popover = pop;
		const bb = strokesBBox(batch);
		const cRect = host.getBoundingClientRect();
		const canvasRect = this.canvas?.getBoundingClientRect();
		let left = 16;
		let top = 16;
		if (bb && canvasRect) {
			left = canvasRect.left - cRect.left + bb.x;
			top = canvasRect.top - cRect.top + bb.y + bb.h + 10;
		}
		pop.setCssStyles({
			left: "0px",
			top: "0px",
			visibility: "hidden",
		});
		const pw = pop.offsetWidth || 280;
		const ph = pop.offsetHeight || 90;
		left = Math.max(6, Math.min(left, cRect.width - pw - 6));
		top = Math.max(6, Math.min(top, cRect.height - ph - 6));
		pop.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			visibility: "visible",
		});
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover === pop && !pop.contains(t)) this.closePopover();
		};
		this.popCloser = closer;
		window.setTimeout(() => window.addEventListener("pointerdown", closer, true), 0);
	}

	private applyHwText(text: string, batch: Stroke[]): void {
		if (!text.trim() || !batch.length || !this.isHwBatchCurrent(batch)) return;
		this.closePopover();
		this.hwBatch = this.hwBatch.filter((s) => !batch.includes(s));
		const st = hwTextStroke(batch, text, this.plugin.settings.hwFont);
		if (!st) return;
		this.undoStack.push(this.strokes.slice());
		this.redoStack.length = 0;
		if (this.undoStack.length > 50) this.undoStack.shift();
		this.strokes = this.strokes.filter((s) => !batch.includes(s));
		this.attachAnchor(st);
		this.strokes.push(st);
		this.redraw();
		this.scheduleSave();
		this.syncTool();
	}

	// pointercancel（掌触/手势打断）提交半截笔迹而不是整笔丢弃
	private onCancel = (evt?: PointerEvent): void => {
		this.onUp(evt);
	};

	private redoStack: Stroke[][] = [];

	private undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.strokes.slice());
		this.strokes = prev;
		this.redraw();
		this.scheduleSave();
		this.syncTool();
	}

	private redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.strokes.slice());
		this.strokes = next;
		this.redraw();
		this.scheduleSave();
		this.syncTool();
	}

	private clearAll(): void {
		this.cancelHwAuto();
		this.hwBatch = [];
		this.closePopover();
		if (!this.strokes.length) return;
		this.undoStack.push(this.strokes.slice());
		this.redoStack.length = 0;
		this.strokes = [];
		this.redraw();
		this.flushSave();
		this.syncTool();
	}

	clearAllForRemove(): void {
		this.cancelHwAuto();
		this.hwBatch = [];
		this.closePopover();
		this.strokes = [];
		this.undoStack = [];
		this.redoStack = [];
		this.redraw();
		this.dirty = true;
		this.flushSave();
		new Notice("已清除该笔记的涂鸦数据");
	}

	private baseCanvas: HTMLCanvasElement | null = null;
	private baseCtx: CanvasRenderingContext2D | null = null;

	/** 已提交墨迹渲染到离屏缓存；绘制中每帧仅贴图 + 当前笔迹，避免整幅重绘卡顿 */
	private rebuildBase(): void {
		if (this.destroyed || !this.canvas) return;
		if (!this.baseCanvas || !this.baseCtx) {
			this.baseCanvas = createEl("canvas");
			this.baseCtx = this.baseCanvas.getContext("2d");
		}
		const bc = this.baseCanvas;
		const bctx = this.baseCtx!;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const tw = Math.floor(this.cw * dpr);
		const th = Math.floor(this.ch * dpr);
		if (bc.width !== tw || bc.height !== th) {
			bc.width = tw;
			bc.height = th;
		}
		bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		bctx.clearRect(0, 0, this.cw, this.ch);
		const entries = this.getCandidateEntries();
		for (const s of this.strokes) {
			const { dx, dy } = this.findBlockDeltaIn(entries, s);
			drawStroke(bctx, s, dx, dy);
		}
	}

	private paint(): void {
		const ctx = this.ctx;
		const cv = this.canvas;
		if (!ctx || !cv || !this.baseCanvas) return;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, cv.width, cv.height);
		ctx.restore();
		ctx.drawImage(this.baseCanvas, 0, 0, this.cw, this.ch);
	}

	private redraw(): void {
		this.rebuildBase();
		this.paint();
		// 外部触发的重绘也要保留进行中的笔迹（drawStroke 覆盖形状/擦除/墨迹）
		const s = this.current;
		if (s && this.ctx) drawStroke(this.ctx, s);
		this.inkCount = -1;
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
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "z") {
				// 输入框/可编辑区内交给原生撤销，避免劫持文本撤销
				const tgt = e.target as HTMLElement | null;
				if (
					tgt &&
					(tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)
				)
					return;
				const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (active !== this.view) return;
				e.preventDefault();
				if (e.shiftKey || e.key.toLowerCase() === "y") this.redo();
				else this.undo();
				return;
			}
			if (e.key !== "Escape") return;
			// Esc 优先关闭弹层（样式/形状/橡皮/文本输入），再退出涂鸦模式
			if (this.popover) {
				const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView === this.view) {
					e.preventDefault();
					e.stopPropagation();
					this.closePopover();
				}
				return;
			}
			const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView === this.view) {
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
			// 已被进行中的写入/刷新落盘时跳过，避免重复写
			if (this.dirty) void this.writeNote();
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

	private writing = false;
	private pendingWrite = false;

	async writeNote(): Promise<void> {
		// 并发保护：写入进行中时排队一次补写，避免 vault.process 读改写互相覆盖
		if (this.writing) {
			this.pendingWrite = true;
			return;
		}
		this.writing = true;
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
			// 保存失败：恢复脏标记，等待下次操作重试
			this.dirty = true;
			const msg = e instanceof Error ? e.message : String(e);
			Diag.log(`writeNote 失败: ${msg}`);
			console.error("[free-doodle] 保存涂鸦失败", e);
			new Notice(`涂鸦保存失败：${msg}`);
		} finally {
			this.writing = false;
			if (this.pendingWrite) {
				this.pendingWrite = false;
				if (this.dirty) void this.writeNote();
			}
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
				brush: s.brush,
				w: s.w && s.w.length === s.points.length ? s.w : undefined,
				pr:
					s.pr && s.pr.length === s.points.length
						? s.pr.map((n) => Math.round(n * 100) / 100)
						: undefined,
			text: s.text,
			font: s.font,
			density: s.density,
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

type BoardTool = ToolMode;

type ToolMode =
	| "pen"
	| "pencil"
	| "ball"
	| "marker"
	| "hl"
	| "laser"
	| "text"
	| "shape"
	| "hw"
	| "erasePx"
	| "eraseStroke";

type BrushId = "pen" | "pencil" | "ball" | "marker" | "hl" | "laser";

function brushOf(mode: ToolMode): BrushId | null {
	switch (mode) {
		case "pen":
			return "pen";
		case "pencil":
			return "pencil";
		case "ball":
			return "ball";
		case "marker":
			return "marker";
		case "hl":
			return "hl";
		case "laser":
			return "laser";
		case "hw":
			return "pen";
		default:
			return null;
	}
}

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
	private activeBrush: BrushId = "pen";

	private smooth = true;
	private popover: HTMLElement | null = null;
	private popCloser: ((e: MouseEvent) => void) | null = null;
	private widthPresetEls: HTMLElement[] = [];

	private shapeKind: DrawShape = "rect";
	private eraseKind: EraseKind = "px";
	private previewScheduled = false;
	/** 手写识别批次与忙碌状态 */
	private hwBatch: Stroke[] = [];
	private hwBusy = false;
	private hwAutoT: number | null = null;

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
		return this.curCfg().size;
	}

	private curBrushId(): BrushId {
		return brushOf(this.mode) ?? this.activeBrush;
	}

	private curCfg(): BrushCfg {
		return this.plugin.settings.brushes[this.curBrushId()];
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

	refreshFont(): void {
		this.redraw();
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
		setFontFamilyFromCanvas(this.canvas);
		this.resizeCanvas();

		this.ro = new ResizeObserver(() => this.scheduleResize());
		this.ro.observe(wrap);

		this.registerDomEvent(this.canvas, "pointerdown", (evt: PointerEvent) =>
			this.onDown(evt)
		);
		this.registerDomEvent(this.canvas, "pointermove", (evt: PointerEvent) =>
			this.onMove(evt)
		);
		this.registerDomEvent(this.canvas, "pointerup", (evt: PointerEvent) => this.onUp(evt));
		// pointercancel（掌触/手势打断）提交半截笔迹而不是整笔丢弃
		this.registerDomEvent(this.canvas, "pointercancel", (evt: PointerEvent) => this.onUp(evt));
		this.registerDomEvent(this.canvas, "contextmenu", (evt: MouseEvent) =>
			evt.preventDefault()
		);
		this.registerDomEvent(root, "keydown", (evt: KeyboardEvent) => {
			const mod = evt.ctrlKey || evt.metaKey;
			if (mod && !evt.shiftKey && evt.key.toLowerCase() === "z") {
				evt.preventDefault();
				this.undo();
			} else if (
				(mod && evt.shiftKey && evt.key.toLowerCase() === "z") ||
				(mod && evt.key.toLowerCase() === "y")
			) {
				evt.preventDefault();
				this.redo();
			}
		});
	}

	async onClose(): Promise<void> {
		this.cancelHwAuto();
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
			{ id: "pen" as const, icon: "pen-tool", title: "钢笔（速度感应粗细）" },
			{ id: "pencil" as const, icon: "pencil", title: "铅笔（颗粒质感）" },
			{ id: "ball" as const, icon: "pen", title: "圆珠笔" },
			{ id: "marker" as const, icon: "paintbrush", title: "马克笔（宽头）" },
			{ id: "hl" as const, icon: "highlighter", title: "荧光笔" },
			{ id: "laser" as const, icon: "flashlight", title: "激光笔（发光）" },
			{ id: "shape" as const, icon: "shapes", title: "形状：直线/箭头/矩形/椭圆/菱形" },
			{ id: "text" as const, icon: "type", title: "文本标注：点击画布插入文字" },
			{ id: "hw" as const, icon: "languages", title: "手写识别：手绘一行，识别后转为美化文字" },
			{ id: "erase" as const, icon: "eraser", title: "橡皮：像素 / 整笔擦除" },
		];
		for (const t of tools) {
			this.toolBtnEls[t.id] = mkBtn(t.icon, t.title, () =>
				this.onBoardToolClick(t.id)
			);
		}

		toolbar.createDiv({ cls: "free-doodle-sep" });
		this.toolBtnEls["hwrun"] = mkBtn("sparkles", "手动识别并编辑整行（自动识别的兜底）", () =>
			void this.runHandwriting(false)
		);
		toolbar.createDiv({ cls: "free-doodle-sep" });

		this.styleBtnEl = mkBtn("settings-2", "样式：颜色 / 粗细 / 不透明度 / 笔迹优化", () =>
			this.openBoardStylePopover(this.styleBtnEl)
		);

		toolbar.createDiv({ cls: "free-doodle-sep" });

		this.toolBtnEls["undo"] = mkBtn("undo-2", "撤销 (Ctrl+Z)", () => this.undo());
		this.toolBtnEls["redo"] = mkBtn("redo-2", "重做 (Ctrl+Shift+Z)", () => this.redo());
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

	private startLaser(): void {
		this.laserPts = [];
		if (!this.laserRunning) {
			this.laserRunning = true;
			window.requestAnimationFrame(() => this.laserLoop());
		}
	}

	private pushLaser(p: Point): void {
		this.laserPts.push({ x: p.x, y: p.y, t: performance.now() });
	}

	private laserLoop(): void {
		if (!this.ctx || !this.containerEl.isConnected) {
			this.laserRunning = false;
			return;
		}
		const now = performance.now();
		const fade = 900;
		this.laserPts = this.laserPts.filter((q) => now - q.t < fade);
		this.paint();
		const pts = smoothLaserPts(this.laserPts);
		if (pts.length > 1) {
			const cfg = this.plugin.settings.brushes.laser;
			const ctx = this.ctx;
			ctx.save();
			ctx.lineCap = "butt";
			ctx.lineJoin = "round";
			ctx.strokeStyle = this.color;
			ctx.lineWidth = cfg.size;
			for (let i = 1; i < pts.length; i++) {
				const p0 = pts[i - 1];
				const p1 = pts[i];
				const age = (now - p1.t) / fade;
				if (age >= 1) continue;
				// 先画的先淡出：每段透明度取决于自身年龄（恒定线宽避免接缝）
				ctx.globalAlpha = (1 - age) * cfg.opacity;
				ctx.beginPath();
				ctx.moveTo(p0.x, p0.y);
				ctx.lineTo(p1.x, p1.y);
				ctx.stroke();
			}
			ctx.restore();
		}
		// 轨迹点淡出完毕且已松开时停止循环
		const tip = pts[pts.length - 1];
		if (tip) {
			const ctx = this.ctx;
			const cfgL = this.plugin.settings.brushes.laser;
			ctx.save();
			ctx.globalAlpha = Math.max(0.3, 1 - (now - tip.t) / fade);
			ctx.fillStyle = "#ffffff";
			ctx.shadowColor = this.color;
			ctx.shadowBlur = cfgL.size * 1.8;
			ctx.beginPath();
			ctx.arc(tip.x, tip.y, Math.max(2.5, cfgL.size * 0.45), 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		if (this.laserPts.length > 0 || this.laserDown) {
			window.requestAnimationFrame(() => this.laserLoop());
		} else {
			this.laserRunning = false;
		}
	}

	private onBoardToolClick(id: BoardTool | "erase" | "hwrun"): void {
		if (id === "shape") {
			this.openBoardShapePopover(this.toolBtnEls["shape"] ?? this.styleBtnEl);
			return;
		}
		if (id === "erase") {
			this.openBoardErasePopover(this.toolBtnEls["erase"] ?? this.styleBtnEl);
			return;
		}
		if (id === "hwrun") {
			void this.runHandwriting(false);
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
		for (const id of ["pencil", "ball", "marker", "laser", "hw"] as const) {
			const b = this.toolBtnEls[id];
			if (b) b.toggleClass("is-active", this.mode === id);
		}
		const textBtn = this.toolBtnEls["text"];
		if (textBtn) textBtn.toggleClass("is-active", this.mode === "text");
		const hwRunBtn = this.toolBtnEls["hwrun"] as HTMLButtonElement | undefined;
		if (hwRunBtn) hwRunBtn.disabled = this.hwBusy || this.hwBatch.length === 0;
		this.widthPresetEls.forEach((el) =>
			el.toggleClass("is-active", Number(el.dataset.size) === this.curCfg().size)
		);
		if (this.colorInputEl) this.colorInputEl.value = this.color;
		if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.curCfg().size);
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		const undoBtn2 = this.toolBtnEls["undo"] as HTMLButtonElement | undefined;
		if (undoBtn2) undoBtn2.disabled = this.undoStack.length === 0;
		const redoBtn2 = this.toolBtnEls["redo"] as HTMLButtonElement | undefined;
		if (redoBtn2) redoBtn2.disabled = this.redoStack.length === 0;
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
		pop.setCssStyles({
			left: "0px",
			top: "0px",
			visibility: "hidden",
		});
		const pw = pop.offsetWidth || 240;
		const ph = pop.offsetHeight || 140;
		let left = Math.max(4, Math.round(aRect.left - cRect.left));
		if (left + pw > cRect.width - 6) left = Math.max(4, cRect.width - pw - 6);
		let top = aRect.bottom - cRect.top + 6;
		if (top + ph > cRect.height - 6)
			top = Math.max(4, Math.max(0, aRect.top - cRect.top - ph - 6));
		pop.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			visibility: "visible",
		});
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
			// 粗细/不透明度实际作用于 curCfg()（笔迹 alpha/size 来源），打开时从配置初始化
			this.size = this.curCfg().size;
			this.opacity = this.curCfg().opacity;
			const colors = el.createDiv({ cls: "free-doodle-pop-row" });
			for (const c of PALETTE) {
				const b = colors.createEl("button", {
					cls: "free-doodle-swatch",
					attr: { title: c },
				});
				b.dataset.color = c;
				b.setCssStyles({ backgroundColor: c });
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
				// 必须写入笔刷配置：OnDown 的 size 取自 curCfg().size
				const cfg = this.curCfg();
				cfg.size = val;
				this.size = val;
				if (this.curBrushId() === "pen") this.plugin.settings.penSize = val;
				this.syncToolbar();
				void this.plugin.saveSettings();
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
				// 笔迹 alpha 取自 curCfg().opacity，必须同步写入笔刷配置
				this.curCfg().opacity = this.opacity;
				this.opacityLabelEl.setText(`${this.opacitySliderEl.value}%`);
			});
			this.opacitySliderEl.addEventListener("change", () => {
				void this.plugin.saveSettings();
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
		if (mode === "hw" && this.mode !== "hw") {
			this.hwBatch = this.hwBatch.filter((s) => this.strokes.includes(s));
			Diag.log(`setBoardMode→hw batch=${this.hwBatch.length}`);
			new Notice("手写模式：可写多个字/英文/数字，停顿约 1.2 秒后自动替换整行");
		} else {
			Diag.log(`setBoardMode ${this.mode}→${mode}`);
		}
		if (mode !== "hw") this.cancelHwAuto();
		this.mode = mode;
		// 荧光笔透明度同样写入笔刷配置（笔迹 alpha 来源）
		if (mode === "hl") {
			const cfg = this.curCfg();
			if (cfg.opacity > 0.6) {
				cfg.opacity = 0.35;
				this.opacity = 0.35;
				if (this.opacitySliderEl)
					this.opacitySliderEl.value = String(Math.round(0.35 * 100));
				if (this.opacityLabelEl) this.opacityLabelEl.setText("35%");
				void this.plugin.saveSettings();
			}
		}
		if (this.sizeLabelEl) this.sizeLabelEl.setText(`${this.effSize()} px`);
		this.canvas.setCssStyles({
			cursor: mode === "text" ? "text" : "crosshair",
		});
		this.syncToolbar();
	}

	private resizePending = false;

	private scheduleResize(): void {
		if (this.resizePending) return;
		this.resizePending = true;
		window.requestAnimationFrame(() => {
			this.resizePending = false;
			this.resizeCanvas();
		});
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
		this.rebuildBase();
		this.paint();
	}

	private pushUndo(): void {
		this.undoStack.push(this.strokes.slice());
		this.redoStack.length = 0;
		if (this.undoStack.length > 50) this.undoStack.shift();
	}

	private redoStack: Stroke[][] = [];

	private undo(): void {
		const prev = this.undoStack.pop();
		if (!prev) return;
		this.redoStack.push(this.strokes.slice());
		this.strokes = prev;
		this.redraw();
		this.syncToolbar();
	}

	private redo(): void {
		const next = this.redoStack.pop();
		if (!next) return;
		this.undoStack.push(this.strokes.slice());
		this.strokes = next;
		this.redraw();
		this.syncToolbar();
	}

	private clear(): void {
		this.cancelHwAuto();
		this.hwBatch = [];
		this.closePopover();
		if (!this.strokes.length) return;
		this.pushUndo();
		this.strokes = [];
		this.redraw();
		this.syncToolbar();
	}

	private toPoint(evt: PointerEvent): Point {
		const r = this.rect ?? this.canvas.getBoundingClientRect();
		return { x: evt.clientX - r.left, y: evt.clientY - r.top };
	}

	private penLastTs = 0;
	private activePointerId: number | null = null;
	private activePointerType: string | null = null;

	private onDown(evt: PointerEvent): void {
		const pen = evt.pointerType === "pen";
		if (pen) {
			// 已有非触摸指针在画时，忽略第二支笔/次要指针（允许笔接管触摸/手掌的笔迹）
			if (!evt.isPrimary && (this.current || this.laserDown) && this.activePointerType !== "touch")
				return;
			this.penLastTs = performance.now();
		} else {
			if (!evt.isPrimary) return;
			// 掌触拒绝：触控笔活动后 1s 内忽略触摸输入
			if (evt.pointerType === "touch" && performance.now() - this.penLastTs < 1000) return;
		}
		this.activePointerId = evt.pointerId;
		this.activePointerType = evt.pointerType;
		this.rect = this.canvas.getBoundingClientRect();
		this.canvas.setPointerCapture(evt.pointerId);
		const p = this.toPoint(evt);

		if (this.mode === "laser") {
			this.laserDown = true;
			this.startLaser();
			return;
		}
		if (this.mode === "text") {
			this.beginBoardTextAt(p);
			return;
		}

		if (this.mode === "eraseStroke") {
			this.strokeEraseUndoArmed = true;
			if (this.removeStrokesNear(p) > 0) this.syncToolbar();
			return;
		}

		const erase = this.mode === "erasePx";
		const bid = brushOf(this.mode);
		if (bid) this.activeBrush = bid;
		const cfg = this.curCfg();
		this.current = {
			color: this.color,
			size: cfg.size,
			erase,
			alpha: erase ? undefined : cfg.opacity,
			density: cfg.density,
			brush: bid ?? undefined,
			w: bid === "pen" ? [Math.max(2, cfg.size)] : undefined,
			pr:
				pen && !erase && this.mode !== "shape" && this.plugin.settings.stylusPressure
					? [normPress(evt.pressure)]
					: undefined,
			points: [p],
			shape: this.mode === "shape" ? this.shapeKind : undefined,
		};
	}
	private beginBoardTextAt(p: Point): void {
		this.closePopover();
		const pop = this.contentEl.createDiv({ cls: "free-doodle-popover free-doodle-text-pop" });
		this.popover = pop;
		pop.style.left = `${Math.round(p.x)}px`;
		pop.style.top = `${Math.round(Math.max(4, p.y - 14))}px`;
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover === pop && !pop.contains(t)) this.closePopover();
		};
		this.popCloser = closer;
		window.addEventListener("pointerdown", closer, true);
		const input = pop.createEl("input", {
			cls: "free-doodle-text-input",
			attr: { placeholder: "输入文字后按回车确认", spellcheck: "false" },
		});
		window.setTimeout(() => input.focus(), 30);
		const commit = () => {
			const t = input.value.trim();
			this.closePopover();
			if (!t) return;
			const st: Stroke = {
				color: this.color,
				size: this.curCfg().size,
				erase: false,
				alpha: this.curCfg().opacity,
				text: t,
				points: [p],
			};
			this.pushUndo();
			this.strokes.push(st);
			this.redraw();
			this.syncToolbar();
		};
		input.addEventListener("keydown", (e) => {
			// 中文等输入法组合期的回车不提交
			if (e.isComposing) return;
			if (e.key === "Enter") commit();
			else if (e.key === "Escape") this.closePopover();
		});
		pop.createEl("button", { cls: "free-doodle-btn mod-cta", text: "确定" }).addEventListener(
			"click",
			commit
		);
	}

	private strokeEraseUndoArmed = false;

	private laserPts: Array<{ x: number; y: number; t: number }> = [];
	private laserRunning = false;
	private laserDown = false;

	private removeStrokesNear(p: Point, deferRedraw = false): number {
		let removed = 0;
		for (let i = this.strokes.length - 1; i >= 0; i--) {
			const s = this.strokes[i];
			if (s.erase) continue;
			const th = Math.max(10, s.size) + 6;
			let hit = false;
			if (s.text && s.points.length >= 1) {
				// 文本标注：按估算文本框命中
				const p0 = s.points[0];
				const fs = Math.max(12, s.size * 4);
				const wEst = s.text.length * fs * 0.6;
				const hEst = fs * 1.35;
				hit =
					p.x >= p0.x - th &&
					p.x <= p0.x + wEst + th &&
					p.y >= p0.y - th &&
					p.y <= p0.y + hEst + th;
			} else if (!s.shape) {
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
		if (removed > 0 && !deferRedraw) {
			this.redraw();
		}
		return removed;
	}

	private inkCanvas: HTMLCanvasElement | null = null;
	private inkCtx: CanvasRenderingContext2D | null = null;
	private inkCount = -1;

	/** 当前笔迹渲染到独立图层（满透明度），合成时叠加真实不透明度：无端点残影、无抖动 */
	private renderInkLayer(s: Stroke): void {
		if (!this.inkCanvas || !this.inkCtx) {
			this.inkCanvas = document.createElement("canvas");
			this.inkCtx = this.inkCanvas.getContext("2d");
		}
		const ic = this.inkCanvas;
		const ictx = this.inkCtx!;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const tw = Math.floor(this.cw * dpr);
		const th = Math.floor(this.ch * dpr);
		if (ic.width !== tw || ic.height !== th) {
			ic.width = tw;
			ic.height = th;
			this.inkCount = -1;
		}
		ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ictx.clearRect(0, 0, this.cw, this.ch);
		drawStroke(ictx, s);
		this.inkCount = s.points.length;
	}

	private schedulePreview(): void {
		if (this.previewScheduled) return;
		this.previewScheduled = true;
		window.requestAnimationFrame(() => {
			this.previewScheduled = false;
			const s = this.current;
			if (!s || !this.ctx || !this.containerEl.isConnected) return;
			this.paint();
			if (s.erase || s.shape || s.text) {
				drawStroke(this.ctx, s);
				return;
			}
			if (s.points.length !== this.inkCount) this.renderInkLayer(s);
			// ink 层内 drawStroke 已应用 alpha，合成时不能再乘一次
			this.ctx.drawImage(this.inkCanvas!, 0, 0, this.cw, this.ch);
		});
	}

	private onMove(evt: PointerEvent): void {
		const pen = evt.pointerType === "pen";
		if (pen) {
			this.penLastTs = performance.now();
		} else {
			if (!evt.isPrimary) return;
			if (evt.pointerType === "touch" && performance.now() - this.penLastTs < 1000) return;
		}
		if (this.mode === "laser") {
			if (this.laserDown) {
				for (const e of coalescedList(evt)) this.pushLaser(this.toPoint(e));
			}
			return;
		}
		// 整笔擦除拖动（需按住；悬停不误擦；合并采样防止快速拖动漏擦）
		if (!this.current && this.mode === "eraseStroke" && (evt.buttons & 1) !== 0) {
			let any = false;
			for (const e of coalescedList(evt)) {
				if (this.removeStrokesNear(this.toPoint(e), true) > 0) any = true;
			}
			if (any) {
				this.redraw();
				this.syncToolbar();
			}
			return;
		}
		const s = this.current;
		if (!s) return;

		const list = coalescedList(evt);
		if (s.shape) {
			s.points[1] = this.toPoint(list[list.length - 1]);
		} else {
			for (const e of list) {
				const prev = s.points[s.points.length - 1];
				const cur = this.toPoint(e);
				s.points.push(cur);
				if (s.pr) s.pr.push(normPress(e.pressure));
				if (s.brush === "pen" && s.w) {
					const speed = Math.hypot(cur.x - prev.x, cur.y - prev.y);
					const base = this.curCfg().size;
					let wv = Math.max(
						base * 0.45,
						Math.min(base * 1.5, base * (1.45 - speed * 0.03))
					);
					if (s.pr) {
						wv = Math.max(
							base * 0.2,
							Math.min(base * 2.2, wv * pressScale(s.pr[s.pr.length - 1]))
						);
					}
					s.w.push(wv);
				}
			}
		}
		this.schedulePreview();
	}

	private onUp(evt?: PointerEvent): void {
		// 仅响应本次捕获指针的抬起/取消，避免其它指针提前提交
		if (evt && evt.pointerId !== this.activePointerId) return;
		this.activePointerId = null;
		this.activePointerType = null;
		this.laserDown = false;
		if (this.mode === "laser") return; // 淡出由激光循环处理
		const s = this.current;
		if (!s) return;
		this.current = null;

		if (s.shape && s.points.length >= 2) {
			const a = s.points[0];
			const b = s.points[s.points.length - 1];
			if (Math.abs(b.x - a.x) < 4 && Math.abs(b.y - a.y) < 4) {
				this.redraw();
				return;
			}
		}

		// 笔迹平滑已在捕获期完成（EMA），此处仅做几何自动拟合
		let final: Stroke = s;
		if (this.mode === "hw") {
			this.hwBatch.push(final);
			Diag.log(`hw入批 batch=${this.hwBatch.length} pts=${final.points.length}`);
			this.pushUndo();
			this.strokes.push(final);
			this.redraw();
			this.syncToolbar();
			this.scheduleHwAuto();
			return;
		}
		if (this.plugin.settings.autoFit) {
			const fitted = fitFreehand(final);
			if (fitted) final = fitted;
		}

		this.pushUndo();
		this.strokes.push(final);
		this.redraw();
		this.syncToolbar();
	}

	/** 手写停顿后自动识别并替换整行（✨ 为手动编辑兜底） */
	private scheduleHwAuto(): void {
		this.cancelHwAuto();
		this.hwAutoT = window.setTimeout(() => {
			this.hwAutoT = null;
			void this.runHandwriting(true);
		}, HW_AUTO_DELAY_MS);
	}

	private cancelHwAuto(): void {
		if (this.hwAutoT !== null) {
			window.clearTimeout(this.hwAutoT);
			this.hwAutoT = null;
		}
	}

	private async runHandwriting(auto = false): Promise<void> {
		Diag.log(`runHandwriting mode=${this.mode} batch=${this.hwBatch.length} busy=${this.hwBusy} auto=${auto}`);
		if (this.hwBusy) {
			if (auto) this.scheduleHwAuto();
			return;
		}
		this.hwBatch = this.hwBatch.filter((s) => this.strokes.includes(s));
		const batch = this.hwBatch.slice();
		if (!batch.length) {
			if (!auto) new Notice("请先切到手写识别工具，写一行字，再点识别按钮");
			return;
		}
		this.hwBusy = true;
		this.syncToolbar();
		const notice = new Notice("手写识别：加载数据…", 0);
		try {
			await this.plugin.hwEngine.ensureReady();
			if (!this.isHwBatchCurrent(batch)) return;
			notice.setMessage("手写识别：识别中…");
			const pts = batch.map((s) => s.points.map((p) => [p.x, p.y]));
			Diag.log(`手写识别 strokes=${pts.length} pts=${pts.map((s) => s.length).join(",")}`);
			const result = await this.plugin.hwEngine.recognize(pts, 6);
			if (!this.isHwBatchCurrent(batch)) {
				Diag.log("手写识别结果已丢弃：批次已被撤销或清除");
				return;
			}
			Diag.log(
				`手写识别结果 text=${JSON.stringify(result.text)} score=${result.score.toFixed(3)} ` +
					`chars=${Array.from(result.text).length} backend=${this.plugin.hwEngine.backendName}`
			);
			if (!result.text.trim()) {
				if (!auto) new Notice("未识别出文字：请写完整一行并保留字符之间的空隙");
				return;
			}
			if (auto && result.score < HW_AUTO_MIN_SCORE) {
				Diag.log(`自动替换跳过 score=${result.score.toFixed(3)} < ${HW_AUTO_MIN_SCORE}`);
				this.showHwLinePopover(result, batch);
			} else if (auto) {
				this.applyHwText(result.text, batch);
			} else {
				this.showHwLinePopover(result, batch);
			}
		} catch (e) {
			Diag.log(`手写识别失败: ${String(e)}`);
			if (!auto) new Notice(`手写识别失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			notice.hide();
			this.hwBusy = false;
			this.syncToolbar();
		}
	}

	private isHwBatchCurrent(batch: Stroke[]): boolean {
		return batch.every((s) => this.hwBatch.includes(s) && this.strokes.includes(s));
	}

	private showHwLinePopover(result: HwLineMatch, batch: Stroke[]): void {
		if (!this.isHwBatchCurrent(batch)) return;
		this.closePopover();
		const pop = buildHwLinePopover(
			this.contentEl,
			result,
			(text) => this.applyHwText(text, batch),
			() => {
				this.hwBatch = this.hwBatch.filter((s) => !batch.includes(s));
				this.closePopover();
				this.syncToolbar();
			}
		);
		this.popover = pop;
		const bb = strokesBBox(batch);
		const cRect = this.contentEl.getBoundingClientRect();
		const canvasRect = this.canvas.getBoundingClientRect();
		let left = 16;
		let top = 80;
		if (bb) {
			left = canvasRect.left - cRect.left + bb.x;
			top = canvasRect.top - cRect.top + bb.y + bb.h + 14;
		}
		pop.setCssStyles({ left: "0px", top: "0px", visibility: "hidden" });
		const pw = pop.offsetWidth || 280;
		const ph = pop.offsetHeight || 90;
		left = Math.max(6, Math.min(left, cRect.width - pw - 6));
		top = Math.max(6, Math.min(top, cRect.height - ph - 6));
		pop.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
			visibility: "visible",
		});
		const closer = (e: MouseEvent) => {
			const t = e.target as Node;
			if (this.popover === pop && !pop.contains(t)) this.closePopover();
		};
		this.popCloser = closer;
		window.setTimeout(() => window.addEventListener("pointerdown", closer, true), 0);
	}

	private applyHwText(text: string, batch: Stroke[]): void {
		if (!text.trim() || !batch.length || !this.isHwBatchCurrent(batch)) return;
		this.closePopover();
		this.hwBatch = this.hwBatch.filter((s) => !batch.includes(s));
		const st = hwTextStroke(batch, text, this.plugin.settings.hwFont);
		if (!st) return;
		this.pushUndo();
		this.strokes = this.strokes.filter((s) => !batch.includes(s));
		this.strokes.push(st);
		this.redraw();
		this.syncToolbar();
	}

	private baseCanvas: HTMLCanvasElement | null = null;
	private baseCtx: CanvasRenderingContext2D | null = null;

	private rebuildBase(): void {
		if (!this.baseCanvas || !this.baseCtx) {
			this.baseCanvas = createEl("canvas");
			this.baseCtx = this.baseCanvas.getContext("2d");
		}
		const bc = this.baseCanvas;
		const bctx = this.baseCtx!;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const tw = Math.floor(this.cw * dpr);
		const th = Math.floor(this.ch * dpr);
		if (bc.width !== tw || bc.height !== th) {
			bc.width = tw;
			bc.height = th;
		}
		bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		bctx.fillStyle = "#ffffff";
		bctx.fillRect(0, 0, this.cw, this.ch);
		drawStrokes(bctx, this.strokes);
	}

	private paint(): void {
		const ctx = this.ctx;
		const cv = this.canvas;
		if (!ctx || !cv || !this.baseCanvas) return;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, cv.width, cv.height);
		ctx.restore();
		ctx.drawImage(this.baseCanvas, 0, 0, this.cw, this.ch);
	}

	private redraw(): void {
		this.rebuildBase();
		this.paint();
		const s = this.current;
		if (s) {
			drawStroke(this.ctx, s);
		}
		this.inkCount = -1;
	}

	private async saveToVault(): Promise<void> {
		try {
			const folder = normalizePath(this.plugin.settings.saveFolder);
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(folder))) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				/* 并发创建竞态（已存在）时忽略 */
			}
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
		// 阅读模式下 editor 不可见，跳过插入，仅提示路径
		if (mdView && mdView.getMode() !== "preview") {
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
	hwEngine: HandwritingEngine;
	private sweepTimer: number | null = null;
	private importedFontFace: FontFace | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.hwEngine = new HandwritingEngine(this);
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadImportedFont();

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
			id: "handwriting-mode",
			name: "手写识别模式（写一行，停顿后自动美化替换）",
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const ov = view ? this.overlays.get(view) : undefined;
				if (!ov) {
					new Notice("请先用 Ctrl+D 或荧光笔图标进入涂鸦模式");
					return;
				}
				ov.enterHwMode();
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
		this.removeImportedFontFace();
		this.hwEngine.dispose();
	}

	private pluginAssetPath(name: string): string {
		const dir = this.manifest.dir;
		if (!dir) throw new Error("plugin manifest.dir missing");
		return `${dir}/${name}`;
	}

	private isImportedFontFile(name: string): boolean {
		return /^free-doodle-font\.(ttf|otf|woff|woff2)$/i.test(name);
	}

	private importedFontStack(): string {
		const current =
			typeof this.settings.hwFont === "string" && this.settings.hwFont.trim()
				? this.settings.hwFont.trim()
				: DEFAULT_SETTINGS.hwFont;
		return current.includes(IMPORTED_FONT_FAMILY)
			? current
			: `${IMPORTED_FONT_FAMILY}, ${current}`;
	}

	private managedFontSet(): ManagedFontFaceSet | null {
		if (typeof document === "undefined" || !document.fonts) return null;
		return document.fonts as ManagedFontFaceSet;
	}

	private removeImportedFontFace(): void {
		if (!this.importedFontFace) return;
		try {
			this.managedFontSet()?.delete(this.importedFontFace);
		} catch (e) {
			Diag.log(`移除导入字体失败: ${String(e)}`);
		}
		this.importedFontFace = null;
	}

	private refreshFontRendering(): void {
		for (const overlay of this.overlays.values()) overlay.refreshFont();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DOODLE)) {
			if (leaf.view instanceof DoodleView) leaf.view.refreshFont();
		}
	}

	private async loadImportedFont(): Promise<void> {
		const file = this.settings.hwFontFile;
		if (!file) {
			this.removeImportedFontFace();
			return;
		}
		if (!this.isImportedFontFile(file)) {
			Diag.log(`导入字体文件名无效: ${file}`);
			return;
		}
		try {
			const fontSet = this.managedFontSet();
			if (typeof FontFace !== "function" || !fontSet) {
				throw new Error("当前环境不支持自定义字体");
			}
			const data = await this.app.vault.adapter.readBinary(this.pluginAssetPath(file));
			const face = new FontFace(IMPORTED_FONT_FAMILY, data);
			await face.load();
			this.removeImportedFontFace();
			fontSet.add(face);
			this.importedFontFace = face;
			this.settings.hwFont = this.importedFontStack();
			await this.saveSettings();
			Diag.log(`导入字体已加载: ${this.settings.hwFontName || file}`);
		} catch (e) {
			Diag.log(`导入字体加载失败: ${String(e)}`);
		}
	}

	async importBeautifyFont(file: File): Promise<void> {
		const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
		if (!IMPORTED_FONT_EXTENSIONS.has(ext)) {
			new Notice("仅支持 ttf、otf、woff、woff2 字体文件");
			return;
		}
		if (file.size <= 0 || file.size > MAX_IMPORTED_FONT_BYTES) {
			new Notice("字体文件为空或超过 50 mb");
			return;
		}
		try {
			const fontSet = this.managedFontSet();
			if (typeof FontFace !== "function" || !fontSet) {
				throw new Error("当前环境不支持自定义字体");
			}
			const data = await file.arrayBuffer();
			const face = new FontFace(IMPORTED_FONT_FAMILY, data);
			await face.load();
			const nextFile = `${IMPORTED_FONT_BASENAME}.${ext}`;
			const oldFile = this.settings.hwFontFile;
			await this.app.vault.adapter.writeBinary(this.pluginAssetPath(nextFile), data);
			this.removeImportedFontFace();
			fontSet.add(face);
			this.importedFontFace = face;
			this.settings.hwFontFile = nextFile;
			this.settings.hwFontName = file.name;
			this.settings.hwFont = this.importedFontStack();
			await this.saveSettings();
			if (oldFile && oldFile !== nextFile && this.isImportedFontFile(oldFile)) {
				try {
					await this.app.vault.adapter.remove(this.pluginAssetPath(oldFile));
				} catch (e) {
					Diag.log(`旧字体缓存清理失败: ${String(e)}`);
				}
			}
			this.refreshFontRendering();
			new Notice(`已导入美化字体：${file.name}`);
		} catch (e) {
			Diag.log(`导入字体失败: ${String(e)}`);
			new Notice(`字体导入失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async clearImportedFont(): Promise<void> {
		const oldFile = this.settings.hwFontFile;
		this.removeImportedFontFace();
		this.settings.hwFontFile = "";
		this.settings.hwFontName = "";
		this.settings.hwFont = DEFAULT_SETTINGS.hwFont;
		await this.saveSettings();
		if (oldFile && this.isImportedFontFile(oldFile)) {
			try {
				await this.app.vault.adapter.remove(this.pluginAssetPath(oldFile));
			} catch (e) {
				Diag.log(`字体缓存清理失败: ${String(e)}`);
			}
		}
		this.refreshFontRendering();
		new Notice("已移除导入字体，恢复默认字体");
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<FreeDoodleSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
		const bStored = (stored?.brushes ?? {}) as Partial<
			Record<BrushId, Partial<BrushCfg>>
		>;
		this.settings.brushes = defaultBrushes();
		for (const id of BRUSH_IDS) {
			const o = bStored[id];
			if (o) this.settings.brushes[id] = { ...defaultBrushes()[id], ...o };
		}
		// penSize 为兼容镜像字段：以实际生效的钢笔笔刷粗细为准（历史版本该字段不生效）
		this.settings.penSize = this.settings.brushes.pen.size;
		if (typeof this.settings.autoFit !== "boolean") this.settings.autoFit = true;
		if (typeof this.settings.hwFont !== "string") this.settings.hwFont = DEFAULT_SETTINGS.hwFont;
		if (typeof this.settings.hwFontFile !== "string") this.settings.hwFontFile = "";
		if (typeof this.settings.hwFontName !== "string") this.settings.hwFontName = "";
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
					// 视图已切到别的文件：仍需把旧文件未保存的墨迹落盘
					ov.destroy(true);
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
				// 文件切换导致的作废：保存未落盘的墨迹，避免丢笔
				ov.destroy(true);
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

	private mountFontImport(host: HTMLElement): () => void {
		const row = host.createDiv({ cls: "free-doodle-font-import" });
		const input = row.createEl("input", {
			cls: "free-doodle-font-input",
			attr: { type: "file", accept: ".ttf,.otf,.woff,.woff2" },
		});
		const status = row.createSpan({
			cls: "free-doodle-font-status",
			text: "当前：默认字体",
		});
		const clear = row.createEl("button", { cls: "free-doodle-btn", text: "移除导入" });
		const refresh = () => {
			status.setText(
				this.plugin.settings.hwFontName
					? `当前：${this.plugin.settings.hwFontName}`
					: "当前：默认字体"
			);
			clear.disabled = !this.plugin.settings.hwFontFile;
		};
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			input.value = "";
			if (file) void this.plugin.importBeautifyFont(file).then(refresh);
		});
		clear.addEventListener("click", () => {
			void this.plugin.clearImportedFont().then(refresh);
		});
		refresh();
		return () => row.remove();
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
				// 实际笔迹粗细取自 brushes.pen.size，保持镜像同步
				this.plugin.settings.brushes.pen.size = v;
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl)
			.setName("自动拟合图形")
			.setDesc("随手画的闭合图形自动修正为规则形状（直线/矩形/椭圆）")
			.addToggle((tb) =>
				tb.setValue(this.plugin.settings.autoFit).onChange(async (v) => {
					this.plugin.settings.autoFit = v;
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

		new Setting(containerEl).setName("手写美化字体").setHeading();
		this.mountFontImport(containerEl);

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
		// penSize 是钢笔粗细兼容字段，同步到实际生效的笔刷配置
		if (key === "penSize" && typeof value === "number") {
			this.plugin.settings.brushes.pen.size = Math.max(1, Math.min(40, Math.round(value)));
		}
		void this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const generalItems: SettingDefinition<string>[] = [

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
				{
					name: "Auto fit shapes 自动拟合图形",
					desc: "Freehand closed shapes snap to perfect geometry. 手绘闭合图形自动修正。",
					control: {
						type: "toggle",
						key: "autoFit",
						defaultValue: true,
					},
				},
				{
					name: "Stylus pressure 触控笔压感",
					desc: "Pen/pencil/ball width follows stylus pressure (tablet). 钢笔/铅笔/圆珠笔按触控笔压力变化粗细。",
					control: {
						type: "toggle",
						key: "stylusPressure",
						defaultValue: true,
					},
				},
				{
					name: "Handwriting beautify font 手写识别美化字体",
					desc: "CSS font stack for recognized handwriting. 识别手写整行后替换为该字体的规范文字（如楷体）。",
					control: {
						type: "text",
						key: "hwFont",
						placeholder: DEFAULT_SETTINGS.hwFont,
						defaultValue: DEFAULT_SETTINGS.hwFont,
					},
				},
			];

		const generalGroup: SettingDefinitionGroup = {
			type: "group",
			heading: "Annotate / 涂鸦",
			items: generalItems,
		};
		const fontImport: SettingDefinition = {
			name: "Import beautify font 导入美化字体",
			desc: "Choose a local TTF, OTF, WOFF, or WOFF2 file. 字体只保存在本地插件目录。",
			render: (setting) => {
				setting.settingEl.toggleClass("free-doodle-diag-row", true);
				return this.mountFontImport(setting.settingEl);
			},
		};
		const diagnostics: SettingDefinition = {
			name: "Diagnostics 诊断日志",
			desc: "Overlay mount/save events and live canvas state. 覆盖层事件与画布实时状态。",
			render: (setting) => {
				// 整行全宽渲染（controlEl 是右侧窄栏，放不下 textarea）
				setting.settingEl.toggleClass("free-doodle-diag-row", true);
				const host = setting.settingEl.createDiv({ cls: "free-doodle-diag-host" });
				this.mountDiagnostics(host);
				return () => host.remove();
			},
		};
		return [generalGroup, fontImport, diagnostics];
	}

	private buildDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("诊断日志").setHeading();
		const host = containerEl.createDiv({ cls: "free-doodle-diag-host" });
		this.mountDiagnostics(host);
	}

	private mountDiagnostics(parent: HTMLElement): void {
		const textarea = parent.createEl("textarea", {
			cls: "free-doodle-diag",
			attr: { readonly: "true", spellcheck: "false", "aria-label": "诊断日志" },
		});
		textarea.rows = 16;
		const refresh = () => {
			const lines: string[] = [Diag.dump()];
			lines.push(`---- 实时状态 ----`);
			lines.push(`activePath=${this.plugin.activePath ?? "null"} overlays=${this.plugin.overlays.size}`);
			const ov = this.plugin.activePath
				? [...this.plugin.overlays.values()].find((o) => o.file.path === this.plugin.activePath)
				: undefined;
			if (ov) {
				lines.push(
					`mode=${ov.getDiagMode()} hwBatch=${ov.getDiagHwBatch()} interactive=${ov.isDiagInteractive()}`
				);
			}
			document.querySelectorAll(".free-doodle-canvas").forEach((c, i) => {
				const cv = c as HTMLCanvasElement;
				const r = cv.getBoundingClientRect();
				lines.push(
					`canvas#${i}: connected=${cv.isConnected} px=${cv.width}x${cv.height} ` +
						`css=${cv.style.width || "-"} rect=[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}] ` +
						`parent=${(cv.parentElement?.className ?? "null").slice(0, 50)}`
				);
			});
			textarea.value = lines.filter((l) => l.length > 0).join("\n");
		};

		const btnRow = parent.createDiv({ cls: "free-doodle-diag-actions" });
		const mk = (label: string, onClick: () => void) => {
			const b = btnRow.createEl("button", { cls: "mod-cta free-doodle-btn", text: label });
			b.addEventListener("click", onClick);
		};
		mk("刷新", () => refresh());
		mk("复制全部", () => {
			refresh();
			void navigator.clipboard.writeText(textarea.value).then(
				() => new Notice("诊断信息已复制到剪贴板"),
				() => new Notice("复制失败，请手动全选复制")
			);
		});
		mk("清空", () => {
			Diag.clear();
			refresh();
		});

		// 打开设置页时自动刷一次；之后仅手动刷新（避免遮挡用户滚动）
		refresh();
	}
}

/* ------------------------------------------------------------------ */
