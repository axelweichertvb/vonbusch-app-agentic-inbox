// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Consolidated date formatting utilities.
 *
 * Previously spread across `app/lib/utils.ts` (4 functions) and
 * `workers/lib/html.ts` (`formatEmailDate`). Now one canonical set
 * imported by both the frontend and backend.
 */

/** Parse safely — returns null on invalid dates instead of NaN-date. */
function safeParse(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	try {
		const d = new Date(dateStr);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

/**
 * Locale for all user-visible dates. Explicit so SSR (Cloudflare Workers)
 * and the browser render identical, German output — no hydration mismatch
 * and no runtime-default fallback to en-US ("3:42 PM").
 */
const UI_LOCALE = "de-DE";

/**
 * Email list rows.
 * - Today: "15:42"
 * - This year: "15. Apr."
 * - Older: "15. Apr. 2024"
 */
export function formatListDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(UI_LOCALE, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	if (date.getFullYear() === now.getFullYear()) {
		return date.toLocaleDateString(UI_LOCALE, {
			month: "short",
			day: "numeric",
		});
	}
	return date.toLocaleDateString(UI_LOCALE, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Email detail header.
 * "Di., 15. Apr., 15:42"
 */
export function formatDetailDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleDateString(UI_LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Thread message headers — time only.
 * "15:42"
 */
export function formatShortDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleTimeString(UI_LOCALE, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Compose quoted replies & backend quoted blocks.
 * "Di., 15. Apr. 2026, 15:42"
 *
 * Uses explicit "de-DE" locale for deterministic German output on both
 * browser and Cloudflare Workers (which support `toLocaleString`).
 */
export function formatQuotedDate(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleString(UI_LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
