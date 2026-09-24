import { randomUUID } from "node:crypto";
import { extname } from "node:path";

/**
 * Marker prefix for temporary injection restores.
 *
 * The marker embeds everything a restore needs without external state:
 * the placeholder pattern (base64url-encoded so it can never break the
 * surrounding comment syntax), the length of the injected value, the length
 * of any gap between the value and the marker (when the marker had to be
 * moved outside a string literal), and a checksum. Git clean filters and
 * crash recovery both rely on this self-describing form.
 */
export const restoreMarkerPrefix = "bshopify-restore";

/**
 * Creates the self-describing restore marker core for an injection.
 *
 * Injected files contain the injected `value` followed by the marker comment
 * (with an optional `gap` of untouched source text in between, when the
 * placeholder sat inside a string literal and the comment had to be moved
 * outside it), so the marker records enough to reverse the replacement from
 * the file content alone:
 * `bshopify-restore:<b64url(pattern)>:<valueLength>:<gapLength>:<checksum>:<nonce>`.
 * The checksum is over the injected value: restore only trusts the recorded
 * value length when the preceding text actually hashes to it, so marker-like
 * text in user content and hand-edited values are never "restored" into
 * garbage. Markers written before `gapLength` existed (4-field core) are
 * still parsed by the restorers with an implicit gap of zero.
 */
export function createRestoreMarker(
  pattern: string,
  value: string,
  gap: string = "",
  nonce: string = randomUUID(),
): string {
  return `${restoreMarkerPrefix}:${encodeBase64Url(pattern)}:${value.length}:${gap.length}:${createValueChecksum(value)}:${nonce}`;
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/**
 * 64-bit FNV-1a-style checksum over UTF-16 code units.
 *
 * Deliberately dependency-free and identical in the generated git filter
 * script: the marker format must be verifiable without any import, which
 * keeps the script valid as both CommonJS and ESM. Collision resistance is
 * only needed against accidental marker-shaped text, not adversaries.
 */
export function createValueChecksum(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let index = 0; index < value.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(index))) * prime);
  }

  return hash.toString(16).padStart(16, "0");
}

export function createFileMarker(path: string, marker: string): string {
  switch (getMarkerSyntax(path)) {
    case "liquid":
      return `{% comment %} ${marker} {% endcomment %}`;
    case "html":
      return `<!-- ${marker} -->`;
    case "jsx":
      return `{/* ${marker} */}`;
    case "toml":
      // TOML has no block comments, so the marker is a `#` line comment. The
      // leading space keeps the `#` legal right after a value or a closing
      // string delimiter; the marker itself never contains a newline, so it
      // always occupies exactly the rest of its own line.
      return ` # ${marker}`;
    case "block":
      return `/* ${marker} */`;
  }
}

type MarkerSyntax = "block" | "html" | "jsx" | "liquid" | "toml";

function getMarkerSyntax(path: string): MarkerSyntax {
  switch (extname(path).toLowerCase()) {
    case ".liquid":
      return "liquid";
    case ".html":
    case ".htm":
      return "html";
    case ".toml":
      return "toml";
    case ".jsx":
    case ".tsx":
      return "jsx";
    case ".css":
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".scss":
    case ".sass":
    case ".less":
      return "block";
    default:
      return "block";
  }
}

/**
 * File extensions whose files can carry an injection restore marker. Used to
 * scope the leftover-marker scan to the text files bshopify actually injects
 * into, skipping binaries and build artifacts. This mirrors the explicit
 * cases of `getMarkerSyntax`; the `default` there only ever writes a block
 * marker into unknown extensions, which are not injected in practice.
 */
const markerFileExtensions = new Set([
  ".liquid",
  ".html",
  ".htm",
  ".toml",
  ".jsx",
  ".tsx",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".scss",
  ".sass",
  ".less",
]);

export function isInjectionMarkerFile(path: string): boolean {
  return markerFileExtensions.has(extname(path).toLowerCase());
}
