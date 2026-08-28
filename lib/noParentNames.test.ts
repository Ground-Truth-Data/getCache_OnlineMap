/**
 * A CHILD MAY NOT SAY THE NAME OF A PARENT.
 *
 * WHY THIS EXISTS ALONGSIDE THE ESCAPE CHECK
 * The build-time plugin in each parent asks "did this path leave the
 * workspace?" That misses the likeliest mistake by far: everything is checked
 * out side by side, so `../ReTreever/src/lib/foo` RESOLVES. It is inside the
 * workspace, it opens, the page renders — and it is meaningless the moment
 * this folder is published as its own repo, where no sibling named ReTreever
 * exists.
 *
 * So the rule here is about NAMES, not geometry. A child that writes the word
 * `ReTreever`, `rapper`, or `vercel` has hardcoded an assumption about who its
 * parent is. A child has TWO possible parents and must work under either, so
 * naming one is the defect regardless of whether the path currently resolves.
 *
 * WHY A TEST AND NOT A PLUGIN
 * A child ships no vite.config.ts — it is not an app, it is a folder a parent
 * builds. There is no build here to hook a plugin into. vitest needs no app,
 * so this runs in a bare clone of this folder alone: `npm test`. That is the
 * only enforcement an outside contributor can actually execute, which is
 * precisely the person this is for.
 *
 * WHAT IS ALLOWED
 * The alias. `$parent/siblings/...` names no parent — it is a seam each parent fills
 * in for itself, which is the whole mechanism. And this child's OWN name may
 * contain "ReTreever" (ReTreever_who_what), so a bare match on the word is
 * wrong; what is banned is naming a parent as a LOCATION.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("..", import.meta.url));
const EXT = new Set([".svelte", ".ts", ".js", ".css", ".json"]);

/**
 * TESTS ARE NOT SOURCES.
 *
 * The line this guard defends is the BUILD boundary: a file a parent bundles
 * must not name that parent. A `*.test.*` file never crosses it — vitest runs
 * it here, no parent ever bundles it — so it is on the guard's own side of the
 * line. Better than that: the contract and lockstep tests EXIST to look at the
 * parents (`lib/contract/oneComponent.test.ts` joins "ReTreever" and "rapper"
 * on purpose; `grid.lockstep.test.ts` reads ReTreever's Worker grid) and skip
 * when a parent is absent. Eight such lines went red on 28 Aug 2026 and every
 * one was a test doing its job.
 *
 * A test that DOES depend on a parent at runtime and forgets to skip fails
 * loud and red in a bare clone — the opposite of the silent "it resolves, the
 * page renders" hole this file is about. So tests are excluded by SHAPE, in
 * the walker, rather than each one being listed here.
 */
const isTest = (name: string) => /\.test\.[^.]+$/.test(name);

function sources(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "assets") continue;
		if (e.name.startsWith(".")) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) sources(full, out);
		else if (EXT.has(extname(e.name)) && !isTest(e.name)) out.push(full);
	}
	return out;
}

/**
 * A parent named as a PLACE: a path segment, an import, a URL host.
 *
 * Anchored on a path or protocol separator so it cannot fire on this child's
 * own folder name, or on prose in a comment explaining the rule.
 */
/**
 * A brand string is not a location.
 *
 * `Symbol.for("retreever.safeMarker.installed")` is a namespaced registry key —
 * it names nothing on disk and behaves identically under either parent, so it
 * is not the defect this test is about. Eight of them tripped the first
 * version, and a guard that cries wolf gets deleted, so they are exempt by
 * SHAPE (inside Symbol.for) rather than by listing them.
 */
const BRAND_STRING = /Symbol\.for\(/;

/**
 * THE TRAILING DELIMITER USED TO BE `[/.]`, AND THAT WAS THE HOLE.
 *
 * Requiring a `/` or `.` AFTER the name only matches a parent in the MIDDLE of
 * a path — `../ReTreever/src/...`. A parent at the END of a string sailed
 * straight through, so all of these passed a green guard:
 *
 *     href="{GH}/rapper"
 *     "https://github.com/Ground-Truth-Data/rapper"
 *     <span>retreever</span>
 *
 * The GitHub link and the visible tier labels in routes/+layout.svelte are the
 * most flagrant parent-naming in this repo and the guard reported zero.
 *
 * WHY IT SURVIVED: the self-test below proved exactly one shape — the same
 * mid-path shape the regex was written from — so the blind spot could not be
 * caught by the thing meant to catch it. A check that only tests the case it
 * was designed for is a check that tests nothing. It now asserts a TERMINAL
 * name too, which is the case that was missing.
 *
 * So the name may now be followed by a path separator, a string/JSX terminator,
 * whitespace, or the end of the line.
 *
 * The LEADING side needed widening for the same reason. `href="{GH}/rapper"`
 * puts a template-interpolation close — `}` — immediately before the slash, so
 * a prefix list of only `../`, a quote or `(` did not match it either. Both
 * ends of the pattern were written from path examples; a link built by
 * interpolation is neither a path nor a bare literal, and it was the actual
 * offender sitting in this repo.
 */
const PARENT_AS_LOCATION =
	/(?:\.\.?\/|["'`({]\/?|\}\/|https?:\/\/[^"'`\s]*)(?:ReTreever|rapper|vercel)(?:[/.]|["'`)\s<]|$)/gi;

describe("the child names no parent", () => {
	it("no path, import or URL names ReTreever, rapper or vercel", () => {
		const offenders: string[] = [];

		for (const file of sources(CHILD)) {
			const text = readFileSync(file, "utf8");
			// Joined over two lines so a Symbol.for(...) that WRAPS is still
			// recognised — the first version tested one line at a time and
			// missed `Symbol.for(\n  "retreever.safeCoveringTiles.installed")`.
			const lines = text.split("\n");
			/**
			 * BLOCK COMMENTS SPAN LINES, so "is this line a comment?" cannot be
			 * answered by looking at the line. `startsWith("*")` catches the
			 * conventionally-starred middle of a JSDoc block and nothing else:
			 * a CSS or prose block whose continuation lines are plainly indented
			 * — as .pill's comment in routes/+layout.svelte is — reads as code
			 * and its prose gets reported as a violation.
			 *
			 * That is the "cries wolf" failure this file's own BRAND_STRING note
			 * warns about, so the state is tracked across lines instead. Prose
			 * may name a parent; only a dependency may not.
			 */
			let inBlockComment = false;
			for (const [i, line] of lines.entries()) {
				const stmt = `${lines[i - 1] ?? ""}\n${line}`;
				const t = line.trim();
				const wasInComment = inBlockComment;
				// Opens and closes counted on THIS line, so a one-line /* */ is
				// not treated as opening a block, and a line that closes one is
				// still skipped (its text is comment up to the close).
				const opens = (line.match(/\/\*/g) ?? []).length;
				const closes = (line.match(/\*\//g) ?? []).length;
				if (opens > closes) inBlockComment = true;
				else if (closes > opens) inBlockComment = false;

				if (wasInComment || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
					continue; // documentation, not a dependency
				}
				if (BRAND_STRING.test(stmt)) continue;
				for (const m of line.matchAll(PARENT_AS_LOCATION)) {
					offenders.push(`${relative(CHILD, file)}:${i + 1}  ${m[0]}`);
				}
			}
		}

		expect(
			offenders,
			`These name a PARENT as a location:\n\n` +
				offenders.map((o) => `  ${o}`).join("\n") +
				`\n\nA child has two possible parents and must run under either, so ` +
				`naming one is a defect even when the path resolves — and side by ` +
				`side on one machine, it DOES resolve. It stops resolving the ` +
				`moment this folder is published on its own, which is the point ` +
				`of the folder.\n\n` +
				`Reach a parent through the alias ($parent/siblings/...), or take what you ` +
				`need as a prop. Never by name.`,
		).toEqual([]);
	});

	it("the check bites — a parent-named path is detected", () => {
		// Without this, a broken regex silently passes everything above.
		const ok = 'import x from "$parent/siblings/getCache_OnlineMap/lib/foo";';
		expect([...ok.matchAll(PARENT_AS_LOCATION)].length).toBe(0);

		/**
		 * BOTH SHAPES. The mid-path one is what the regex was born from; the
		 * TERMINAL ones are what it silently missed for as long as it existed.
		 * Losing either case re-opens the hole, so both are asserted by name.
		 */
		const bad = [
			'import x from "../ReTreever/src/lib/foo";', // mid-path
			'href="{GH}/rapper"', // terminal, in a string
			'"https://github.com/Ground-Truth-Data/rapper"', // terminal, full URL
		];
		for (const b of bad) {
			expect(
				[...b.matchAll(PARENT_AS_LOCATION)].length,
				`should have been flagged: ${b}`,
			).toBeGreaterThan(0);
		}
	});
});
