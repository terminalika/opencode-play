# opencode-play

[terminalika](https://terminalika.dev) as an [opencode](https://opencode.ai)
TUI plugin: the retro games from terminalika-core, running on a full-screen
route inside opencode, that pause themselves the moment the agent finishes
and is waiting for you. No standalone binary, no second pane.

## install

Declare the plugin in your TUI config (`~/.config/opencode/tui.json` for
everywhere, or a project's `.opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-play"]
}
```

(From a local checkout, use the path instead:
`"plugin": ["/path/to/opencode-play/src/tui.tsx"]`.)

Needs opencode 1.18+.

Then:

```
/play            back to the parked game, or pick one
/play-menu       the game menu (also alt+g, from either side)
/play-stop       end the game - the only way out
```

In the game: arrows/`WASD` move, `SPACE` pauses, `R` resets, `ESC` **parks**
- the game freezes and hides, opencode has the keyboard again, and `/play`
brings it back exactly where it was. `alt+g` opens the menu: the game that
is on leads (Enter resumes it), "Return to opencode" right under it, then
every other game to swap to.

When the session goes idle (the agent finished and is waiting on you), what
happens to a running game is asked once, on the first `/play`, and
remembered in opencode's plugin storage:

- **Pause the game** — freeze it with a one-line notice; `SPACE` resumes
  (default),
- **Settle the game** — the game parks itself, keyboard back to opencode,
- **Don't pause** — keep playing.

## How it works

This is a thin opencode launcher for terminalika-core, the same way the
CLI and the pi extension are thin launchers: the games are written once,
in Go.

```
terminalika-core (Go) ──GOOS=js──▶ wasm/terminalika.wasm
                                        │  tcell's web-screen protocol:
                                        │  Go calls resize/clearScreen/drawCell/show,
                                        │  registers onKeyEvent, exposes tkPause/tkResume/tkQuit
                                        ▼
src/runtime.ts              runs the wasm with Go's own wasm_exec, on the
src/screen.ts               TUI process; screen.ts keeps the cell grid and
                            hands it out as same-styled runs (renderRuns)
                                        │
                                        ▼
src/tui.tsx                 the opencode TUI plugin: a full-screen route
  (src/keys.ts)             draws the runs as OpenTUI <text> nodes, a raw
                            input handler feeds keys to the wasm, and
                            session.idle → tkPause.
```

- **A route, not a pane.** `api.route.register` gives the plugin a
  full-screen view; `/play` navigates to it, parking navigates back to
  wherever you were. The game trims the grid to what it needs
  (`core.Sized`) and the view centers it.
- **Raw input, consumed.** While the game route is up, a prepended renderer
  input handler owns the keyboard: ESC parks, alt+g opens the menu,
  ctrl+c always falls through to opencode, everything else goes to the
  game - nothing leaks into prompts.
- **The idle event comes straight from opencode.** `api.event.on
  ("session.idle", ...)` is the moment the agent will not continue on its
  own - the counterpart of the pi extension's `agent_settled`.
- **Main thread, deliberately.** Go's wasm_exec schedules goroutines
  through the event loop, so the UI stays live between game ticks. If a
  streaming reply ever visibly starves the game, the worker-thread split
  pi-terminalika uses is the known fix.

Build the wasm from a sibling `terminalika-core` checkout (or the published
module) with `npm run build:wasm`; `npm run test:wasm` boots every game
headlessly. The built wasm is committed, so users never need Go.

Not yet: high scores (the wasm has no filesystem), key releases (kitty
protocol; releases are synthesised from auto-repeat).
