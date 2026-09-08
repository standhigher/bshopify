import type { ReverseReplacement } from "./types";

/**
 * Characters that continue the same scalar/token. A match is restored only
 * when both sides are outside this set, so `bestupsell-cart-drawer-discount`
 * is not treated as the handle `upsell-cart-drawer-discount`.
 */
const tokenContinuePattern = /[A-Za-z0-9_./:-]/;

/**
 * Restores one journalled injection by complete tokens on each line.
 *
 * Never globally replaces `value` as a substring. Quoted handles match;
 * a longer wasm path on another line does not. Surrounding whitespace,
 * comments, and newly inserted lines are kept.
 */
export function restoreJournalReplacement(content: string, replacement: ReverseReplacement): string {
  const withMarker = restoreAdjacentMarker(content, replacement);

  // Marker injections are restored from the file comment. Scanning every
  // line for the value would also rewrite user text that happens to equal
  // the injected scalar (for example a copy added during `shopify app dev`).
  if (
    replacement.marker !== undefined
    || replacement.value.length === 0
    || replacement.value === replacement.pattern
  ) {
    return withMarker;
  }

  return restoreCompleteTokensByLine(withMarker, replacement.value, replacement.pattern);
}

/**
 * Unparseable restore comments still sit flush after the value in older
 * journals. The concatenated span is unique because of the marker.
 */
function restoreAdjacentMarker(content: string, replacement: ReverseReplacement): string {
  const marker = replacement.marker;

  if (marker === undefined || marker.length === 0 || replacement.value.length === 0) {
    return content;
  }

  const adjacent = `${replacement.value}${marker}`;
  const start = indexOfUnique(content, adjacent);

  if (start === undefined) {
    return content;
  }

  return content.slice(0, start) + replacement.pattern + content.slice(start + adjacent.length);
}

function restoreCompleteTokensByLine(content: string, value: string, pattern: string): string {
  return content.split(/(\r\n|\n|\r)/).map((segment) => {
    if (segment === "\r\n" || segment === "\n" || segment === "\r") {
      return segment;
    }

    return restoreCompleteTokensInLine(segment, value, pattern);
  }).join("");
}

function restoreCompleteTokensInLine(line: string, value: string, pattern: string): string {
  let result = "";
  let from = 0;

  while (from <= line.length - value.length) {
    const found = line.indexOf(value, from);

    if (found === -1) {
      return result + line.slice(from);
    }

    const left = found === 0 ? undefined : line[found - 1];
    const right = found + value.length >= line.length ? undefined : line[found + value.length];

    if (!isTokenContinue(left) && !isTokenContinue(right)) {
      result += line.slice(from, found) + pattern;
      from = found + value.length;
      continue;
    }

    result += line.slice(from, found + 1);
    from = found + 1;
  }

  return result + line.slice(from);
}

function isTokenContinue(char: string | undefined): boolean {
  return char !== undefined && tokenContinuePattern.test(char);
}

function indexOfUnique(haystack: string, needle: string): number | undefined {
  if (needle.length === 0) {
    return undefined;
  }

  const first = haystack.indexOf(needle);

  if (first === -1 || haystack.indexOf(needle, first + 1) !== -1) {
    return undefined;
  }

  return first;
}
