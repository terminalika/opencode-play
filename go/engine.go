package main

import (
	"strings"
	"syscall/js"
	"time"
	"unicode"

	core "github.com/terminalika/terminalika-core"

	"github.com/gdamore/tcell/v2"
)

// releaseMod marks a key event as a key *release*. The host relays opencode's
// kitty-protocol release events through tcell's onKeyEvent with the "meta"
// argument set, which tcell's web screen turns into ModMeta; nothing in the
// games uses that modifier, so it is free to carry this meaning.
const releaseMod = tcell.ModMeta

const (
	// framePeriod paces update + draw. 16 ms (60 Hz) is plenty for the
	// games and halves the host's render work compared to the launcher's
	// 8 ms; the timeouts below are still comfortably above it.
	framePeriod = 16 * time.Millisecond

	// Key-release synthesis, ported from the launcher's engine. Without
	// kitty releases a held key only shows up as auto-repeated presses, so
	// a release is synthesised once a key has gone quiet: synthHold after
	// the first press, then a per-key timeout derived from the measured
	// repeat gap (dynamicHold). With releases, terminalHoldTimeout is only
	// a safety net for a multiplexer that claimed support it doesn't relay.
	synthHold           = 5 * time.Millisecond
	repeatGapMargin     = 1.15
	minDynamicHold      = 5 * time.Millisecond
	maxDynamicHold      = 120 * time.Millisecond
	terminalHoldTimeout = 1500 * time.Millisecond
)

func isRelease(ev *tcell.EventKey) bool { return ev.Modifiers()&releaseMod != 0 }

func unmark(ev *tcell.EventKey) *tcell.EventKey {
	return tcell.NewEventKey(ev.Key(), ev.Rune(), ev.Modifiers()&^releaseMod)
}

func dynamicHold(gap time.Duration) time.Duration {
	d := time.Duration(float64(gap) * repeatGapMargin)
	if d < minDynamicHold {
		return minDynamicHold
	}
	if d > maxDynamicHold {
		return maxDynamicHold
	}
	return d
}

// command is what the host's tkPause / tkResume turn into; the game loop
// applies them between frames so the game is never touched from a JS
// callback mid-draw.
type command struct {
	quit  bool
	pause bool
	agent string
	line  string
}

// notice is the one piece of text the engine draws over the game: an
// agent's pause, or the "too late, the game was already over" card. Only
// one is ever shown; setting it replaces whatever was there.
type notice struct {
	lines []string
	style tcell.Style
	// dismissOnKey blocks input and clears on the next real keypress,
	// swallowing it - for a pause that arrived after the game ended, where
	// missing the moment would mean missing the agent.
	dismissOnKey bool
}

// engine is a port of the launcher's internal/engine trimmed to what the
// opencode host needs: the game loop, the global keys (ESC leave, R reset, SPACE pause),
// press/release tracking, and external pause/resume with an attributed
// notice. No event bus, no WebSocket sidecar.
type engine struct {
	screen   tcell.Screen
	game     core.Game
	releases bool
	paused   bool
	quit     bool
	held     map[keyID]heldKey
	commands chan command
	notice   *notice
}

type keyID struct {
	key tcell.Key
	r   rune
}

type heldKey struct {
	ev      *tcell.EventKey
	last    time.Time
	timeout time.Duration
}

func newEngine(screen tcell.Screen, game core.Game, releases bool, mod string) *engine {
	// Space and R are handled here; ESC and alt+g never arrive: the host
	// parks the game on ESC and opens its game menu on alt+g
	// (src/tui.tsx), so that is what the hint says - with the host's name
	// for the alt key, "option" on a Mac.
	core.SetGlobalKeys(game, core.GlobalKeys{Pause: "Space", Reset: "R", Leave: "Esc", LeaveAction: "back to opencode", Switch: mod + "+g"})
	return &engine{
		screen:   screen,
		game:     game,
		releases: releases,
		held:     make(map[keyID]heldKey),
		commands: make(chan command, 16),
	}
}

// exposeCommands registers tkPause / tkResume / tkQuit for the host. They
// only enqueue; the loop applies them. tkQuit is the only way out: the host
// never forwards ESC, it parks the game instead, so nothing the player
// presses can end it.
func (e *engine) exposeCommands() {
	js.Global().Set("tkPause", js.FuncOf(func(this js.Value, args []js.Value) any {
		c := command{pause: true}
		if len(args) > 0 {
			c.agent = args[0].String()
		}
		if len(args) > 1 {
			c.line = args[1].String()
		}
		select {
		case e.commands <- c:
		default:
		}
		return nil
	}))
	js.Global().Set("tkResume", js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case e.commands <- command{}:
		default:
		}
		return nil
	}))
	js.Global().Set("tkQuit", js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case e.commands <- command{quit: true}:
		default:
		}
		return nil
	}))
}

func (e *engine) run() {
	if err := e.game.Init(e.screen); err != nil {
		return
	}
	e.paused = false
	e.quit = false

	ticker := time.NewTicker(framePeriod)
	defer ticker.Stop()

	for !e.quit {
		e.handleEvents()
		e.drainCommands()
		e.expireHeld()
		if e.quit {
			break
		}
		e.game.Update()
		e.game.Draw(e.screen)
		if e.notice != nil && e.noticeCurrent() {
			e.drawNotice(e.notice)
		}
		<-ticker.C
	}
}

func (e *engine) handleEvents() {
	for e.screen.HasPendingEvent() {
		ev := e.screen.PollEvent()
		if ev == nil {
			continue
		}
		switch ev := ev.(type) {
		case *tcell.EventResize:
			e.screen.Sync()
		case *tcell.EventKey:
			e.handleKey(ev)
		}
	}
}

func (e *engine) drainCommands() {
	for {
		select {
		case c := <-e.commands:
			e.apply(c)
		default:
			return
		}
	}
}

// apply pauses or resumes on the host's behalf. A pause that doesn't take
// (Pause() is a no-op once a game is over) still gets a notice, one that
// waits for a keypress, so the agent settling after the player already lost
// isn't silent.
func (e *engine) apply(c command) {
	if c.quit {
		e.quit = true
		return
	}
	if !c.pause {
		e.notice = nil
		if e.isPaused() {
			e.paused = false
			e.game.Resume()
		}
		return
	}
	line := c.line
	if line == "" {
		line = "Paused"
	}
	n := &notice{lines: []string{line}, style: styleForAgent(c.agent)}
	if e.isPaused() {
		e.notice = n
		return
	}
	e.paused = true
	e.game.Pause()
	if !e.isPaused() {
		// The game refused (already over): show the card until acknowledged.
		e.paused = false
		n.dismissOnKey = true
	}
	e.notice = n
}

// isPaused asks the game when it can say, else falls back to the engine's
// own flag.
func (e *engine) isPaused() bool {
	if ps, ok := e.game.(core.PauseState); ok {
		return ps.IsPaused()
	}
	return e.paused
}

// noticeCurrent reports whether the notice should still be drawn: a
// dismiss-on-key card always is (its own keypress clears it), a pause notice
// only for as long as the game stays paused.
func (e *engine) noticeCurrent() bool {
	if e.notice.dismissOnKey {
		return true
	}
	return e.isPaused()
}

func (e *engine) handleKey(ev *tcell.EventKey) {
	if isRelease(ev) {
		unmarked := unmark(ev)
		if ks, ok := e.game.(core.KeyStateHandler); ok {
			ks.HandleKeyState(unmarked, false)
		}
		delete(e.held, idOf(unmarked))
		return
	}

	if e.notice != nil && e.notice.dismissOnKey {
		e.notice = nil
		return
	}

	// No ESC here, unlike the CLI: the host keeps it (it parks the game),
	// and the game only ends through tkQuit.
	if ev.Key() == tcell.KeyRune {
		switch ev.Rune() {
		case 'r', 'R':
			e.paused = false
			e.notice = nil
			e.game.Reset()
			return
		case ' ':
			e.togglePause()
			return
		}
	}

	if ks, ok := e.game.(core.KeyStateHandler); ok && ks.HandleKeyState(ev, true) {
		id := idOf(ev)
		now := time.Now()
		prev, held := e.held[id]
		timeout := synthHold
		switch {
		case e.releases:
			timeout = terminalHoldTimeout
		case held:
			if gap := now.Sub(prev.last); gap > 0 {
				timeout = dynamicHold(gap)
			}
		}
		e.held[id] = heldKey{ev: ev, last: now, timeout: timeout}
		return
	}
	e.game.HandleInput(ev)
}

func (e *engine) expireHeld() {
	if len(e.held) == 0 {
		return
	}
	ks, ok := e.game.(core.KeyStateHandler)
	now := time.Now()
	for id, h := range e.held {
		if now.Sub(h.last) < h.timeout {
			continue
		}
		delete(e.held, id)
		if ok {
			ks.HandleKeyState(h.ev, false)
		}
	}
}

func (e *engine) togglePause() {
	if e.isPaused() {
		e.paused = false
		e.notice = nil
		e.game.Resume()
		return
	}
	e.paused = true
	e.game.Pause()
}

func idOf(ev *tcell.EventKey) keyID {
	if ev.Key() == tcell.KeyRune {
		return keyID{key: tcell.KeyRune, r: unicode.ToLower(ev.Rune())}
	}
	return keyID{key: ev.Key()}
}

// styleForAgent mirrors the launcher's agent colours; anything untagged
// gets terminalika's own aqua.
func styleForAgent(agent string) tcell.Style {
	switch agent {
	case "claude":
		return tcell.StyleDefault.Foreground(tcell.ColorBlack).Background(tcell.ColorOrange).Bold(true)
	case "opencode":
		return tcell.StyleDefault.Foreground(tcell.ColorWhite).Background(tcell.ColorDarkCyan).Bold(true)
	default:
		return tcell.StyleDefault.Foreground(tcell.ColorBlack).Background(tcell.ColorAqua).Bold(true)
	}
}

// drawNotice overlays n on the game's own pause/game-over band - the game
// says where it is (core.OverlayReporter) - widened to cover it completely
// so the two never show side by side; with no band up, centered on the
// screen.
func (e *engine) drawNotice(n *notice) {
	w, h := e.screen.Size()
	startY := h / 2
	left, right := -1, -1
	if band, ok := core.OverlayAreaOf(e.game); ok {
		startY = band.Y
		left, right = band.X, band.X+band.W-1
	}
	lines := n.lines
	if len(lines) > 1 {
		lines = padBlock(lines)
	}
	for i, line := range lines {
		x := w/2 - len([]rune(line))/2
		if i == 0 || len(lines) > 1 {
			if left >= 0 && left < x {
				line = strings.Repeat(" ", x-left) + line
				x = left
			}
			if end := x + len([]rune(line)); right >= 0 && right+1 > end {
				line += strings.Repeat(" ", right+1-end)
			}
		}
		for j, r := range []rune(line) {
			e.screen.SetContent(x+j, startY+i, r, nil, n.style)
		}
	}
	e.screen.Show()
}

func padBlock(lines []string) []string {
	width := 0
	for _, l := range lines {
		if n := len([]rune(l)); n > width {
			width = n
		}
	}
	width += 2
	out := make([]string, len(lines))
	for i, l := range lines {
		n := len([]rune(l))
		left := (width - n) / 2
		right := width - n - left
		out[i] = strings.Repeat(" ", left) + l + strings.Repeat(" ", right)
	}
	return out
}
