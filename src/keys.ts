/**
 * Turns the raw stdin chunks opencode's renderer hands an input handler
 * (see tui.tsx) into the (KeyboardEvent.key-style) arguments tcell's web
 * screen expects from `onKeyEvent(key, shift, alt, ctrl, meta)`.
 *
 * Two encodings arrive, depending on the terminal: legacy sequences
 * (`\x1b[A`, bare `\x1b`, `\x1bg`), and kitty-keyboard CSI-u (`\x1b[27u`
 * for ESC, `\x1b[103;3u` for alt+g) - opencode enables the kitty protocol
 * where the terminal speaks it, which re-encodes ESC and alt+letters
 * while arrows keep their legacy form. The games only use a small
 * vocabulary, so this parses just that; anything else (mouse reports,
 * focus events) comes back undefined and is swallowed while a game is on.
 */

export interface WebKey {
	key: string;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** A kitty-protocol key release (event type 3). */
	release: boolean;
}

const CSI_SPECIAL: Record<string, string> = {
	A: "ArrowUp",
	B: "ArrowDown",
	C: "ArrowRight",
	D: "ArrowLeft",
	H: "Home",
	F: "End",
};

const CSI_TILDE: Record<string, string> = {
	"1": "Home",
	"2": "Insert",
	"3": "Delete",
	"4": "End",
	"5": "PgUp",
	"6": "PgDn",
};

/** Kitty CSI-u codepoints for keys that are not plain printables. */
const KITTY_SPECIAL: Record<number, string> = {
	27: "Escape",
	13: "Enter",
	9: "Tab",
	127: "Backspace",
	57352: "Delete", // kitty functional-key codepoints (PUA)
	57348: "Insert",
	57356: "ArrowLeft",
	57357: "ArrowRight",
	57358: "ArrowUp",
	57359: "ArrowDown",
	57360: "PgUp",
	57361: "PgDn",
	57362: "Home",
	57363: "End",
};

function plain(key: string): WebKey {
	return { key, shift: false, alt: false, ctrl: false, release: false };
}

function mods(n: number): { shift: boolean; alt: boolean; ctrl: boolean } {
	const m = n - 1;
	return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
}

/** Map one raw input chunk to a web key, or undefined for input the games can't use. */
export function parseRawKey(data: string): WebKey | undefined {
	if (data.length === 0) return undefined;

	// Bare escape, or alt+<printable> (legacy ESC-prefixed).
	if (data === "\x1b") return plain("Escape");
	if (data.length === 2 && data[0] === "\x1b") {
		const k = parseRawKey(data[1]);
		if (k && !k.alt) return { ...k, alt: true };
		return undefined;
	}

	if (data.startsWith("\x1b[")) {
		const body = data.slice(2);

		// Kitty CSI-u: codepoint[:alternates] [; modifiers[:event]] u
		const u = /^(\d+)(?::[\d:]*)?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u$/.exec(body);
		if (u) {
			const cp = Number(u[1]);
			const m = u[2] ? mods(Number(u[2])) : { shift: false, alt: false, ctrl: false };
			const release = u[3] === "3";
			const special = KITTY_SPECIAL[cp];
			if (special) return { key: special, ...m, release };
			if (cp >= 32 && cp <= 0x10ffff) {
				let key = String.fromCodePoint(cp);
				if (m.shift) key = key.toUpperCase();
				return { key, ...m, release };
			}
			return undefined;
		}

		// Legacy arrows and friends, with an optional 1;<mods> prefix.
		const m = /^(?:1;(\d+))?([A-DHF])$/.exec(body);
		if (m) {
			const base = m[1] ? mods(Number(m[1])) : { shift: false, alt: false, ctrl: false };
			return { key: CSI_SPECIAL[m[2]], ...base, release: false };
		}
		const t = /^(\d+)(?:;(\d+))?~$/.exec(body);
		if (t && CSI_TILDE[t[1]]) {
			const base = t[2] ? mods(Number(t[2])) : { shift: false, alt: false, ctrl: false };
			return { key: CSI_TILDE[t[1]], ...base, release: false };
		}
		return undefined;
	}

	if (data === "\r" || data === "\n") return plain("Enter");
	if (data === "\t") return plain("Tab");
	if (data === "\x7f" || data === "\x08") return plain("Backspace");

	// A single printable character; shift inferred from case.
	if ([...data].length === 1 && data >= " ") {
		const shift = data !== data.toLowerCase();
		return { key: data, shift, alt: false, ctrl: false, release: false };
	}

	return undefined;
}

/** True for input that must always reach opencode: ctrl+c, in either encoding. */
export function isInterrupt(data: string): boolean {
	if (data === "\x03") return true;
	const k = parseRawKey(data);
	return !!k && k.ctrl && (k.key === "c" || k.key === "C");
}
