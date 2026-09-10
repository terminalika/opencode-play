/**
 * Runs the wasm build of terminalika (see go/) inside Node/Bun with Go's
 * own wasm_exec.js. One game per run; the returned promise settles when the
 * Go program exits (the player left the game).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GAMES = ["snake", "tetris", "2048", "mines", "sudoku"] as const;
export type GameName = (typeof GAMES)[number];

export interface RunOptions {
	wasmDir: string;
	game: string;
	cols: number;
	rows: number;
	/** The terminal reports key releases (kitty protocol), so Go can wait for them. */
	releases: boolean;
	/** What the hints call the alt key: "alt", or "option" on a Mac. */
	mod: string;
	/** Receives whatever the Go program writes to stdout/stderr (panics, mostly). */
	onOutput?: (text: string) => void;
	/**
	 * Called once, right after the game has trimmed the grid to what it
	 * needs (board, status line, hint line) - the moment a host that sizes
	 * itself to the game can open its surface.
	 */
	onGrid?: (cols: number, rows: number) => void;
}

interface GoRuntime {
	argv: string[];
	env: Record<string, string>;
	importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
	_scheduledTimeouts?: Map<number, ReturnType<typeof setTimeout>>;
	_resume?: () => void;
}

type GoCtor = new () => GoRuntime;

let goCtor: GoCtor | null = null;
let compiled: Promise<WebAssembly.Module> | null = null;
let running = false;

/** Whether a game is on right now. */
export function isRunning(): boolean {
	return running;
}

function loadGo(wasmDir: string, onOutput?: (text: string) => void): GoCtor {
	if (!goCtor) {
		// wasm_exec.js is a plain script that assigns globalThis.Go; evaluate
		// it as such (not through the extension loader's TS transform).
		const code = readFileSync(join(wasmDir, "wasm_exec.js"), "utf8");
		new Function(code)();
		goCtor = (globalThis as { Go?: GoCtor }).Go ?? null;
		if (!goCtor) throw new Error("wasm_exec.js did not define Go");
	}
	// wasm_exec's fs polyfill prints Go's stdout/stderr with console.log,
	// which would land in the middle of pi's screen; route it to the caller.
	const fs = (globalThis as { fs?: { writeSync?: unknown; write?: unknown } }).fs;
	if (fs) {
		const decoder = new TextDecoder();
		fs.writeSync = (_fd: number, buf: Uint8Array) => {
			onOutput?.(decoder.decode(buf));
			return buf.length;
		};
		fs.write = (
			_fd: number,
			buf: Uint8Array,
			_offset: number,
			length: number,
			_position: unknown,
			cb: (err: Error | null, n: number) => void,
		) => {
			onOutput?.(decoder.decode(buf.subarray(0, length)));
			cb(null, length);
		};
	}
	return goCtor;
}

function compile(wasmDir: string): Promise<WebAssembly.Module> {
	if (!compiled) {
		compiled = WebAssembly.compile(readFileSync(join(wasmDir, "terminalika.wasm"))).catch((err) => {
			compiled = null;
			throw err;
		});
	}
	return compiled;
}

/**
 * wasm_exec.js leaves timers it scheduled for the Go runtime pending after
 * the program exits; when one fires it throws "Go program has already
 * exited". Clear them so an exit is silent.
 */
function settle(go: GoRuntime): void {
	try {
		if (go._scheduledTimeouts instanceof Map) {
			for (const id of go._scheduledTimeouts.values()) clearTimeout(id);
			go._scheduledTimeouts.clear();
		}
		go._resume = () => {};
	} catch {
		/* private fields moved; nothing to do */
	}
}

/**
 * Start a game. The screen globals (see WebScreen.install) must already be
 * in place. Resolves when the Go program exits.
 */
export async function runGame(opts: RunOptions): Promise<void> {
	if (running) throw new Error("terminalika is already running");
	running = true;
	const g = globalThis as Record<string, unknown>;
	let go: GoRuntime | null = null;
	try {
		const Go = loadGo(opts.wasmDir, opts.onOutput);
		g.tkTermSize = { cols: opts.cols, rows: opts.rows };
		// tcell only calls resize when the size differs from its 80x24
		// default, so the grid is sized here, like the browser host does.
		(g.resize as ((w: number, h: number) => void) | undefined)?.(opts.cols, opts.rows);
		g.tkGrid = (cols: number, rows: number) => {
			// tcell skips its resize call when the game's size happens to be
			// its 80x24 default, so make sure the grid matches either way.
			const screen = g.resize as ((w: number, h: number) => void) | undefined;
			screen?.(cols, rows);
			opts.onGrid?.(cols, rows);
		};
		go = new Go();
		go.argv = ["terminalika", `--game=${opts.game}`, `--releases=${opts.releases}`, `--mod=${opts.mod}`];
		const instance = await WebAssembly.instantiate(await compile(opts.wasmDir), go.importObject);
		await go.run(instance);
	} finally {
		if (go) settle(go);
		delete g.tkTermSize;
		delete g.tkPause;
		delete g.tkResume;
		delete g.tkQuit;
		delete g.tkGrid;
		running = false;
	}
}

/** Pause the running game with an attributed notice; no-op when none is on. */
export function pauseGame(agent: string, line: string): void {
	const fn = (globalThis as { tkPause?: (a: string, l: string) => void }).tkPause;
	fn?.(agent, line);
}

/** End the running game; runGame's promise then resolves. No-op when none is on. */
export function quitGame(): void {
	const fn = (globalThis as { tkQuit?: () => void }).tkQuit;
	fn?.();
}

/** Resume the running game and clear its notice; no-op when none is on. */
export function resumeGame(): void {
	const fn = (globalThis as { tkResume?: () => void }).tkResume;
	fn?.();
}
