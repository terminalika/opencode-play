/**
 * The JS half of tcell's web-screen protocol, hosted in opencode's TUI
 * process instead of a browser. tcell's Go side (the wasm) calls the
 * globals `resize`, `clearScreen`, `drawCell`, `show`, `showCursor`,
 * `setCursorStyle`, `beep` and `setTitle`; this keeps a cell grid and
 * turns it into styled runs for the plugin's Solid view (renderRuns), or
 * ANSI lines for the headless smoke test (renderLines).
 *
 * Colours arrive as 24-bit ints. tcell's web screen has no notion of
 * "default": a cell drawn with StyleDefault comes through as
 * 0xe5e5e5-on-0x000000. Those (and plain white text) are emitted with no
 * colour at all, so the overlay follows the terminal's own default colours
 * the way a real terminal would.
 */

export interface Cell {
	s: string;
	fg: number;
	bg: number;
	attrs: number;
	us: number;
}

const DEFAULT_BG = 0x000000;
const DEFAULT_FG = new Set([0xe5e5e5, 0xffffff]);

const ATTR_BOLD = 1;
const ATTR_BLINK = 1 << 1;
const ATTR_REVERSE = 1 << 2;
const ATTR_DIM = 1 << 4;
const ATTR_ITALIC = 1 << 5;
const ATTR_STRIKE = 1 << 6;

const GLOBALS = ["resize", "clearScreen", "drawCell", "show", "showCursor", "setCursorStyle", "beep", "setTitle"] as const;
const RECEIVERS = ["onKeyEvent", "onMouseClick", "onMouseMove", "onFocus", "onPaste"] as const;

function blank(): Cell {
	return { s: " ", fg: -1, bg: -1, attrs: 0, us: 0 };
}

/** Display width of one cell's text: 2 for East Asian wide / emoji, else 1. */
function cellWidth(s: string): number {
	const cp = s.codePointAt(0);
	if (cp === undefined) return 1;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

function sgr(c: Cell): string {
	let fg = c.fg;
	let bg = c.bg;
	if (c.attrs & ATTR_REVERSE) {
		const t = fg;
		fg = bg;
		bg = t;
	}
	const parts: string[] = ["0"];
	if (c.attrs & ATTR_BOLD) parts.push("1");
	if (c.attrs & ATTR_DIM) parts.push("2");
	if (c.attrs & ATTR_ITALIC) parts.push("3");
	if (c.us !== 0) parts.push("4");
	if (c.attrs & ATTR_BLINK) parts.push("5");
	if (c.attrs & ATTR_STRIKE) parts.push("9");
	if (fg >= 0 && !DEFAULT_FG.has(fg)) parts.push(`38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}`);
	if (bg >= 0 && bg !== DEFAULT_BG) parts.push(`48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}`);
	return `\x1b[${parts.join(";")}m`;
}

function sameStyle(a: Cell, b: Cell): boolean {
	return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs && (a.us !== 0) === (b.us !== 0);
}

/** One same-styled stretch of a row, as renderRuns returns it. */
export interface Run {
	text: string;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
}

function hex(n: number): string {
	return `#${n.toString(16).padStart(6, "0")}`;
}

function runStyle(c: Cell): Omit<Run, "text"> {
	let fg = c.fg;
	let bg = c.bg;
	if (c.attrs & ATTR_REVERSE) {
		const t = fg;
		fg = bg;
		bg = t;
	}
	const style: Omit<Run, "text"> = {};
	if (fg >= 0 && !DEFAULT_FG.has(fg)) style.fg = hex(fg);
	if (bg >= 0 && bg !== DEFAULT_BG) style.bg = hex(bg);
	if (c.attrs & ATTR_BOLD) style.bold = true;
	if (c.attrs & ATTR_DIM) style.dim = true;
	return style;
}

export class WebScreen {
	cols = 0;
	rows = 0;
	private grid: Cell[][] = [];
	private dirty = false;
	private cache: { width: number; lines: string[] } | null = null;

	/** Called on every show() that follows a change; wire it to requestRender. */
	onShow: (() => void) | null = null;

	/** Point tcell's globals at this screen. Only one screen can be installed. */
	install(): void {
		const g = globalThis as Record<string, unknown>;
		g.resize = (w: number, h: number) => this.resize(w, h);
		g.clearScreen = () => this.clearScreen();
		g.drawCell = (x: number, y: number, s: string, fg: number, bg: number, attrs: number, us: number) =>
			this.drawCell(x, y, s, fg, bg, attrs, us);
		g.show = () => this.show();
		g.showCursor = () => {};
		g.setCursorStyle = () => {};
		g.beep = () => {};
		g.setTitle = () => {};
		for (const name of RECEIVERS) {
			if (typeof g[name] !== "function") g[name] = () => {};
		}
	}

	uninstall(): void {
		const g = globalThis as Record<string, unknown>;
		for (const name of GLOBALS) delete g[name];
		for (const name of RECEIVERS) g[name] = () => {};
	}

	resize(w: number, h: number): void {
		this.cols = w;
		this.rows = h;
		this.grid = [];
		for (let y = 0; y < h; y++) {
			const row: Cell[] = new Array(w);
			for (let x = 0; x < w; x++) row[x] = blank();
			this.grid.push(row);
		}
		this.dirty = true;
		this.cache = null;
	}

	clearScreen(): void {
		for (const row of this.grid) for (let x = 0; x < row.length; x++) row[x] = blank();
		this.dirty = true;
		this.cache = null;
	}

	drawCell(x: number, y: number, s: string, fg: number, bg: number, attrs: number, us: number): void {
		const row = this.grid[y];
		if (!row || x < 0 || x >= row.length) return;
		const text = s === "" ? " " : s;
		const c = row[x];
		// A paused game redraws the same frame forever; only a real change
		// should cost a render.
		if (c.s === text && c.fg === fg && c.bg === bg && c.attrs === attrs && c.us === us) return;
		row[x] = { s: text, fg, bg, attrs, us };
		this.dirty = true;
		this.cache = null;
	}

	show(): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.onShow?.();
	}

	/**
	 * The grid as rows of same-styled runs, for a host that draws styled
	 * text nodes instead of ANSI (opencode's OpenTUI). fg/bg are "#rrggbb",
	 * or undefined for the terminal's own default (StyleDefault cells and
	 * plain white text, same rule renderLines applies), so the host theme
	 * shows through.
	 */
	renderRuns(): Run[][] {
		const rows: Run[][] = [];
		for (const row of this.grid) {
			const runs: Run[] = [];
			let open: Cell | null = null;
			for (const c of row) {
				if (open && sameStyle(open, c)) {
					runs[runs.length - 1].text += c.s;
					continue;
				}
				open = c;
				runs.push({ text: c.s, ...runStyle(c) });
			}
			rows.push(runs);
		}
		return rows;
	}

	/** The grid as ANSI lines, each no wider than `width` cells. */
	renderLines(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const lines: string[] = [];
		const limit = Math.min(width, this.cols);
		for (const row of this.grid) {
			let out = "";
			let open: Cell | null = null;
			let x = 0;
			while (x < limit) {
				const c = row[x];
				const w = cellWidth(c.s);
				if (x + w > limit) break;
				if (!open || !sameStyle(open, c)) {
					out += sgr(c);
					open = c;
				}
				out += c.s;
				x += w;
			}
			if (x < width) out += `\x1b[0m${" ".repeat(width - x)}`;
			out += "\x1b[0m";
			lines.push(out);
		}
		this.cache = { width, lines };
		return lines;
	}
}
