// Command go is the opencode build of terminalika: the real games from
// terminalika-core, run by a small port of the launcher's engine and drawn
// through tcell's WebAssembly screen. The plugin (src/tui.tsx) hosts it
// inside opencode's TUI process, supplies the JS side of tcell's
// web-screen protocol and relays opencode's key input.
//
// Build (see scripts/build-wasm.sh):
//
//	GOOS=js GOARCH=wasm go build -o ../wasm/terminalika.wasm .
//
// The host passes the game and the terminal's release support through argv,
// like the real binary's flags:
//
//	terminalika --game=snake --releases=true --mod=alt
//
// (--mod is what the host calls the alt key in the hints: "option" on a Mac.)
//
// and sets window.tkTermSize = {cols, rows} to the terminal's size before
// running; the program then shrinks the grid to what the game says it needs
// (core.Sized) and reports it through tkGrid(cols, rows), the host's cue to
// open a surface of exactly that size. While a game is on, the host can call
// the globals this program registers:
//
//	tkPause(agent, line)  pause the game with an attributed notice
//	tkResume()            resume it and clear the notice
//
// The program exits when the player leaves the game (ESC).
package main

import (
	"flag"
	"os"
	"strings"
	"syscall/js"

	core "github.com/terminalika/terminalika-core"
	"github.com/terminalika/terminalika-core/games"
	"github.com/terminalika/terminalika-core/highscore"

	"github.com/gdamore/tcell/v2"
)

func main() {
	// No filesystem in wasm: scores live for the session and the games keep
	// BEST off the screen.
	registry := games.WithStore(highscore.NewInMemory())

	fs := flag.NewFlagSet("terminalika", flag.ContinueOnError)
	gameFlag := fs.String("game", "", "game to run ("+strings.Join(registry.Names(), ", ")+")")
	releases := fs.Bool("releases", false, "the host terminal reports key releases")
	mod := fs.String("mod", "alt", "what the host calls the alt key in hints: alt, or option on a Mac")
	_ = fs.Parse(os.Args[1:])

	game, ok := registry.Get(*gameFlag)
	if !ok {
		return
	}

	screen, err := tcell.NewScreen()
	if err != nil {
		return
	}
	if err := screen.Init(); err != nil {
		return
	}
	defer screen.Fini()

	eng := newEngine(screen, game, *releases, *mod) // sets the game's key labels first
	cols, rows := gridSize(game)
	screen.SetSize(cols, rows)
	if fn := js.Global().Get("tkGrid"); fn.Type() == js.TypeFunction {
		fn.Invoke(cols, rows)
	}
	eng.exposeCommands()
	eng.run()
}

// gridSize is the grid the game gets: exactly what it asks for - board,
// status line, hint lines - and no more, within the terminal. The game is
// told how much there is, so in a narrow terminal it wraps its hint and asks
// for the rows instead. A game that doesn't say gets the whole terminal.
func gridSize(game core.Game) (int, int) {
	cols, rows := termSize()
	if s, ok := game.(core.Sized); ok {
		need := s.NeededSize(core.Size{Cols: cols, Rows: rows})
		cols, rows = min(cols, need.Cols), min(rows, need.Rows)
	}
	return cols, rows
}

// termSize reads the cell grid the host prepared (tkTermSize = {cols,
// rows}); tcell's web screen defaults to 80x24 otherwise.
func termSize() (int, int) {
	cols, rows := 80, 24
	v := js.Global().Get("tkTermSize")
	if v.Type() == js.TypeObject {
		if c := v.Get("cols"); c.Type() == js.TypeNumber && c.Int() > 0 {
			cols = c.Int()
		}
		if r := v.Get("rows"); r.Type() == js.TypeNumber && r.Int() > 0 {
			rows = r.Int()
		}
	}
	return cols, rows
}
