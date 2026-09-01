/**
 * hospitalCost.test.ts — the hospital layer must never load the world.
 *
 * WHY A *COST* TEST: the original shape was CORRECT — it rendered the right
 * pins while loading a country-sized object graph on every map mount and
 * retaining it for the process lifetime. Correctness tests cannot see that.
 * The radius filter now runs on the tiles Worker (its hospitals.test.ts
 * guards it); what is left to guard HERE is the request's shape:
 *
 *   1. no anchor ⇒ no request at all (there is no "nearby" to ask about)
 *   2. no endpoint ⇒ no request (the app never configured one — a child
 *      installed by a stranger must not fetch from anywhere by default)
 *   3. the child sends the app's URL VERBATIM — it adds no host, no route
 *      name, no params of its own (childBoundary RULE 7)
 */

import { describe, expect, it } from "vitest";
import { __testing } from "./mapInit";

const { hospitalsRequestUrl } = __testing;

const ANCHOR: [number, number] = [-122.75, 53.92];

describe("hospital layer — request-shape guards", () => {
	it("no anchor ⇒ no request", () => {
		expect(hospitalsRequestUrl(null, () => "https://example.test/x")).toBeNull();
	});

	it("no endpoint ⇒ no request", () => {
		expect(hospitalsRequestUrl(ANCHOR, null)).toBeNull();
		expect(hospitalsRequestUrl(ANCHOR, undefined)).toBeNull();
	});

	it("uses the app's URL verbatim, built from the anchor", () => {
		const urlFor = (a: [number, number]) =>
			`https://example.test/h?lng=${a[0]}&lat=${a[1]}`;
		expect(hospitalsRequestUrl(ANCHOR, urlFor)).toBe(
			"https://example.test/h?lng=-122.75&lat=53.92",
		);
	});

	it("app answering null (unconfigured host) ⇒ no request", () => {
		expect(hospitalsRequestUrl(ANCHOR, () => null)).toBeNull();
	});
});
