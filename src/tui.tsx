/** @jsxImportSource @opentui/solid */
/**
 * terminalika for opencode: `/play` opens one of terminalika-core's games
 * as a full-screen route over the conversation; the moment the session
 * goes idle (the agent finished and is waiting for you) the game pauses
 * itself with a notice.
 *
 * Going back to opencode never ends the game: ESC parks it - paused, the
 * route navigates back, opencode has the keyboard again - and `/play`
 * brings it back exactly where it was. alt+g opens the game menu from
 * either side: the game that is on leads (Enter resumes), "Return to
 * opencode" right under it, then every other game. `/play-stop` ends the
 * game for good.
 *
 * The games are the wasm build of terminalika-core (see go/), driven
 * through tcell's web-screen protocol: screen.ts keeps the cell grid, this
 * file draws it as OpenTUI text runs and relays raw key input (keys.ts).
 * v1 runs the wasm on the TUI process itself - Go's wasm_exec schedules
 * through the event loop, so the UI stays live between game ticks.
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createSignal, For, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { isInterrupt, parseRawKey } from "./keys.ts"
import { type Run, WebScreen } from "./screen.ts"
import { GAMES, isRunning, pauseGame, quitGame, resumeGame, runGame } from "./runtime.ts"

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm")
const ROUTE = "terminalika.game"
const MOD = process.platform === "darwin" ? "option" : "alt"
const RETURN_HINT = `/play returns · ${MOD}+g opens the menu · /play-stop kills the game session`

/** kv key for the one setting: what a running game does on session.idle. */
const KV_AUTO_PAUSE = "terminalika.auto_pause"
type AutoPause = "pause" | "settle" | "no_pause"

const tui: TuiPlugin = async (api) => {
	const screen = new WebScreen()
	const [frame, setFrame] = createSignal(0)
	screen.onShow = () => setFrame((n) => n + 1)

	/** The parked game's name, or null - drives the footer hint on both
	 * the home screen and inside a session, so a parked game stays
	 * visible no matter where the prompt takes you. */
	const [parked, setParked] = createSignal<string | null>(null)

	/** The one game that can be on: playing (route open) or parked. */
	let session: {
		game: string
		parked: boolean
		/** Where to navigate back to when parking. */
		back: { name: string; params?: Record<string, unknown> }
	} | null = null

	function currentRoute(): { name: string; params?: Record<string, unknown> } {
		const c = api.route.current
		return { name: c.name, params: "params" in c ? (c.params as Record<string, unknown>) : undefined }
	}

	function park(message?: string): boolean {
		if (!session || session.parked) return false
		session.parked = true
		setParked(session.game)
		pauseGame("", message ?? `Parked - ${RETURN_HINT}`)
		api.route.navigate(session.back.name, session.back.params)
		return true
	}

	function unpark(): void {
		if (!session || !session.parked) return
		session.parked = false
		session.back = currentRoute()
		setParked(null)
		// Still paused; the game's own hint line says what SPACE, Esc and
		// alt+g do.
		pauseGame("", "Paused")
		api.route.navigate(ROUTE)
	}

	async function startSession(game: string): Promise<void> {
		if (session) return
		if (api.kv.get(KV_AUTO_PAUSE) === undefined) {
			askAutoPause(() => void startSession(game))
			return
		}
		const cols = Math.max(40, (process.stdout.columns || 80) - 4)
		const rows = Math.max(12, (process.stdout.rows || 24) - 4)
		screen.install()
		session = { game, parked: false, back: currentRoute() }
		api.route.navigate(ROUTE)
		try {
			await runGame({
				wasmDir: WASM_DIR,
				game,
				cols,
				rows,
				releases: false,
				mod: MOD,
				onOutput: (text) => {
					const line = text.trim().split("\n")[0]
					if (line) api.ui.toast({ variant: "error", message: `terminalika: ${line}` })
				},
			})
		} finally {
			const wasParked = session?.parked
			session = null
			setParked(null)
			screen.uninstall()
			if (!wasParked) {
				const back = currentRoute()
				api.route.navigate(back.name === ROUTE ? "home" : back.name, back.params)
			}
		}
	}

	function stopSession(): void {
		if (!session) {
			api.ui.toast({ message: "no game on" })
			return
		}
		quitGame() // runGame's finally navigates back and tidies up
	}

	function askAutoPause(then?: () => void): void {
		let answered = false
		const pick = (mode: AutoPause) => {
			answered = true
			api.kv.set(KV_AUTO_PAUSE, mode)
			api.ui.dialog.clear()
			then?.()
		}
		api.ui.dialog.replace(
			() => (
				<api.ui.DialogSelect
					title={"Thanks for installing opencode-play.\nWhen the agent settles while you're playing, opencode-play should..."}
					options={[
						{ title: "Pause the game (default)", description: "freeze it; SPACE resumes", value: "pause", onSelect: () => pick("pause") },
						{ title: "Settle the game", description: "park it and hand the keyboard back", value: "settle", onSelect: () => pick("settle") },
						{ title: "Don't pause", description: "keep playing", value: "no_pause", onSelect: () => pick("no_pause") },
					]}
				/>
			),
			// Dismissed without an answer (Escape, clicking away): default
			// to pausing rather than leaving the choice unset forever.
			() => {
				if (!answered) pick("pause")
			},
		)
	}

	/**
	 * The game menu: the game that is on leads (Enter resumes it - the
	 * common case), "Return to opencode" right under it, then every other
	 * game. With nothing on, just the game list. Opening it from inside a
	 * game parks first; "Return to opencode" (or cancelling) leaves it
	 * parked.
	 */
	function openMenu(): void {
		park()
		const on = session?.game
		const options: { title: string; value: string; onSelect: () => void }[] = []
		const close = () => api.ui.dialog.clear()
		if (on) {
			options.push({ title: `${on}  (on)`, value: on, onSelect: () => (close(), unpark()) })
			options.push({ title: "Return to opencode", value: "return", onSelect: close })
		}
		for (const g of GAMES) {
			if (g === on) continue
			options.push({
				title: g,
				value: g,
				onSelect: () => {
					close()
					if (session) {
						quitGame()
						// Let the old game's finally run before booting the next.
						setTimeout(() => void startSession(g), 50)
					} else {
						void startSession(g)
					}
				},
			})
		}
		api.ui.dialog.replace(() => <api.ui.DialogSelect title="terminalika" options={options} />)
	}

	// Raw input while the game route is focused: ESC parks, alt+g opens the
	// menu, ctrl+c always falls through to opencode, everything else goes to
	// the wasm (and is consumed either way, so nothing leaks into prompts).
	const rendererAny = api.renderer as unknown as {
		prependInputHandler: (h: (data: string) => boolean) => void
		removeInputHandler: (h: (data: string) => boolean) => void
	}
	const onInput = (data: string): boolean => {
		if (!session || session.parked) return false
		if (api.route.current.name !== ROUTE) return false
		if (isInterrupt(data)) return false
		const k = parseRawKey(data)
		// Key releases (kitty protocol) don't drive anything yet - the
		// engine synthesises releases from auto-repeat - but they must not
		// park twice or leak through.
		if (k && !k.release) {
			if (k.key === "Escape" && !k.alt && !k.ctrl) {
				park()
				return true
			}
			if ((k.key === "g" || k.key === "G") && k.alt) {
				openMenu()
				return true
			}
			const fn = (globalThis as Record<string, unknown>).onKeyEvent
			if (typeof fn === "function") fn(k.key, k.shift, k.alt, k.ctrl, false)
		}
		return true
	}
	rendererAny.prependInputHandler(onInput)

	// The game route: the grid's styled runs, centered. Rebuilt only when a
	// frame actually changed (screen.onShow bumps the signal).
	api.route.register([
		{
			name: ROUTE,
			render: () => {
				const rows = () => {
					frame()
					return screen.renderRuns()
				}
				return (
					<box alignItems="center" justifyContent="center" flexGrow={1}>
						<box>
							<For each={rows()}>
								{(runs: Run[]) => (
									<box flexDirection="row">
										<For each={runs}>{(r: Run) => <text fg={r.fg} bg={r.bg}>{r.text}</text>}</For>
									</box>
								)}
							</For>
						</box>
					</box>
				)
			},
		},
	])

	api.keymap.registerLayer({
		commands: [
			{
				name: "opencode-play.play",
				title: "opencode-play: play (back to the parked game, or pick one)",
				category: "opencode-play",
				namespace: "palette",
				slashName: "play",
				run() {
					if (session?.parked) unpark()
					else if (session) api.route.navigate(ROUTE)
					else openMenu()
				},
			},
			{
				name: "opencode-play.menu",
				title: "opencode-play: game menu",
				category: "opencode-play",
				namespace: "palette",
				slashName: "play-menu",
				run: () => openMenu(),
			},
			{
				name: "opencode-play.stop",
				title: "opencode-play: stop the game",
				category: "opencode-play",
				namespace: "palette",
				slashName: "play-stop",
				run: () => stopSession(),
			},
		],
		// alt+g from the editor too - in the game the raw input handler
		// catches it first, so this only fires when opencode has the keyboard.
		bindings: [{ key: "alt+g", cmd: "opencode-play.menu" }],
	})

	// A footer hint, matching the host footer's key/label styling ("tab
	// agents  ctrl+p commands"), plus a note when a game is parked - it's
	// off-screen but still on, and this is the only place that says so.
	// home_footer never renders in 1.18.25, so home_bottom carries it on
	// the home screen; session_prompt_right carries the same hint once a
	// prompt's been sent and the view has moved off home_bottom entirely.
	type HintCtx = { theme: { current: { text: unknown; textMuted: unknown } } }
	const hint = (ctx: HintCtx) => (
		<box flexDirection="row" gap={1}>
			<text fg={ctx.theme.current.text as never}>alt+g</text>
			<text fg={ctx.theme.current.textMuted as never}>games</text>
			<Show when={parked()}>
				{(game: () => string) => (
					<box flexDirection="row" gap={1}>
						<text fg={ctx.theme.current.textMuted as never}>·</text>
						<text fg={ctx.theme.current.text as never}>{game()} parked</text>
						<text fg={ctx.theme.current.textMuted as never}>/play resumes</text>
					</box>
				)}
			</Show>
		</box>
	)
	api.slots.register({
		order: 400,
		slots: {
			home_bottom: (ctx: HintCtx, _props: unknown) => hint(ctx),
			session_prompt_right: (ctx: HintCtx, _props: unknown) => hint(ctx),
		},
	})

	// The agent needs you - either it's done (session.idle) or it's
	// blocked on a permission or a question - and what happens to a
	// running game is the player's one-time choice (see askAutoPause). A
	// parked game stays parked - the player is already with opencode.
	function onNeedsAttention(doneMessage: string): void {
		if (!session || session.parked) return
		switch (api.kv.get<AutoPause>(KV_AUTO_PAUSE, "pause")) {
			case "settle":
				if (park(doneMessage)) {
					api.ui.toast({ message: "Game parked - /play brings it back" })
				}
				break
			case "no_pause":
				break
			default:
				pauseGame("opencode", doneMessage)
		}
	}
	api.event.on("session.idle", () => onNeedsAttention("opencode's done - you're up."))
	api.event.on("permission.asked", () => onNeedsAttention("opencode needs a permission - you're up."))
	api.event.on("question.asked", () => onNeedsAttention("opencode has a question - you're up."))

	// Ask the auto-pause preference up front, at plugin init, instead of
	// waiting for the first /play - most players would never go looking
	// for the setting otherwise. Still a one-time choice: once kv has an
	// answer, this (and startSession's own check) never asks again.
	if (api.kv.get(KV_AUTO_PAUSE) === undefined) askAutoPause()

	api.lifecycle.onDispose(() => {
		if (isRunning()) quitGame()
		rendererAny.removeInputHandler(onInput)
	})
}

export default { id: "opencode-play.tui", tui }
