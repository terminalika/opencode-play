/**
 * Headless check of the wasm + host without opencode, through v1's real
 * path (the game on the main thread, screen.ts installed on globalThis):
 * run each game for a moment, press a few keys, pause it, make sure frames
 * come out, then leave through quit and make sure runGame resolves.
 *
 *   npm run test:wasm
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebScreen } from "../src/screen.ts";
import { GAMES, pauseGame, quitGame, runGame } from "../src/runtime.ts";

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendKey(key: string): void {
	const fn = (globalThis as Record<string, unknown>).onKeyEvent;
	if (typeof fn === "function") fn(key, false, false, false, false);
}

function text(screen: WebScreen): string {
	return screen
		.renderRuns()
		.map((runs) => runs.map((r) => r.text).join(""))
		.join("\n");
}

async function runOne(game: string): Promise<void> {
	const screen = new WebScreen();
	let frames = 0;
	screen.onShow = () => frames++;
	screen.install();

	let grid: { cols: number; rows: number } | null = null;
	const done = runGame({
		wasmDir: WASM_DIR,
		game,
		cols: 80,
		rows: 24,
		releases: false,
		mod: "alt",
		onGrid: (cols, rows) => {
			grid = { cols, rows };
		},
	});

	try {
		for (let i = 0; i < 30 && !grid; i++) await sleep(100);
		if (!grid) throw new Error(`${game}: grid never announced`);
		const g = grid as { cols: number; rows: number };
		if (g.cols > 80 || g.rows > 24) throw new Error(`${game}: grid ${g.cols}x${g.rows} exceeds the terminal`);

		await sleep(400);
		sendKey("ArrowLeft");
		sendKey("ArrowRight");
		await sleep(300);
		if (frames === 0) throw new Error(`${game}: no frames`);

		pauseGame("opencode", "opencode's done - you're up.");
		let t = "";
		for (let i = 0; i < 10 && !t.includes("opencode's done"); i++) {
			await sleep(100);
			t = text(screen);
		}
		if (!t.includes("opencode's done")) throw new Error(`${game}: pause notice not drawn:\n${t}`);

		// ESC never reaches the wasm here (the host parks instead), and even
		// a stray one is ignored by the engine; only quit gets out.
		sendKey("Escape");
		await sleep(100);

		quitGame();
		const exited = await Promise.race([done.then(() => true), sleep(3000).then(() => false)]);
		if (!exited) throw new Error(`${game}: did not exit on quit`);
		console.log(`${game.padEnd(9)} ok  (${g.cols}x${g.rows}, ${frames} frames)`);
	} finally {
		quitGame();
		await Promise.race([done, sleep(1000)]);
		screen.uninstall();
	}
}

for (const game of GAMES) {
	await runOne(game);
}
console.log("all games ok");
