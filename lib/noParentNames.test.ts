/** A child may not name a parent (ReTreever, rapper, vercel) as a location — only by package name (@ground-truth/<child>/...)... is allowed. A child has two possible parents, so naming one is a defect even when the path currently resolves (everything is checked out side by side locally). */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("..", import.meta.url));
const EXT = new Set([".svelte", ".ts", ".js", ".css", ".json"]);

// Tests are excluded by shape (not listed by name) — a *.test.* file never crosses the build boundary a parent bundles.
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

// A parent named as a PLACE: a path segment, import, or URL host — anchored on a separator so it can't fire on this child's own folder name or on prose.
// Symbol.for(...) keys name nothing on disk and are exempt by SHAPE, not oversight — a guard that cries wolf gets deleted.
const BRAND_STRING = /Symbol\.for\(/;

// PARENT_AS_LOCATION must catch a parent at the END of a string too, not just mid-path — a narrower regex once let `href="{GH}/rapper"` sail through a green guard.
const PARENT_AS_LOCATION =
	/(?:\.\.?\/|["'`({]\/?|\}\/|https?:\/\/[^"'`\s]*)(?:ReTreever|rapper|vercel)(?:[/.]|["'`)\s<]|$)/gi;

describe("the child names no parent", () => {
	it("no path, import or URL names ReTreever, rapper or vercel", () => {
		const offenders: string[] = [];

		for (const file of sources(CHILD)) {
			const text = readFileSync(file, "utf8");
			// stmt joins two lines so a wrapped Symbol.for(...) is still recognised — a prior version tested one line at a time and missed multi-line calls.
			const lines = text.split("\n");
			// Block comments SPAN LINES — startsWith("*") alone false-positives on non-JSDoc continuation lines (e.g. indented CSS/prose), so comment state is tracked across lines instead.
			let inBlockComment = false;
			for (const [i, line] of lines.entries()) {
				const stmt = `${lines[i - 1] ?? ""}\n${line}`;
				const t = line.trim();
				const wasInComment = inBlockComment;
				// Opens/closes counted on THIS line only — a one-line /* */ doesn't toggle block-comment state, and a closing line is still skipped up to the close.
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
				`Import a sibling by its package name (@ground-truth/<child>/...), or take what you ` +
				`need as a prop. Never by name.`,
		).toEqual([]);
	});

	it("the check bites — a parent-named path is detected", () => {
		// Without this, a broken regex silently passes everything above.
		const ok = 'import x from "@ground-truth/getcache-onlinemap/lib/foo";';
		expect([...ok.matchAll(PARENT_AS_LOCATION)].length).toBe(0);

		// BOTH shapes are asserted by name — losing either case (mid-path or terminal) re-opens the hole the regex was fixed for.
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
