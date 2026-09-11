export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

export function compareSemver(left: string, right: string): number {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  const coreDelta = compareVersionParts(leftVersion.core, rightVersion.core);

  if (coreDelta !== 0) {
    return coreDelta;
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

function parseSemver(version: string): ParsedSemver {
  const withoutBuild = version.trim().replace(/^v/i, "").split("+")[0] ?? "0.0.0";
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const [major, minor, patch] = core.split(".");

  return {
    core: [toVersionNumber(major), toVersionNumber(minor), toVersionNumber(patch)],
    prerelease: pre.length === 0 ? [] : pre.split(".").map(parsePrereleaseId),
  };
}

function compareVersionParts(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

function comparePrerelease(
  left: Array<number | string>,
  right: Array<number | string>,
): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) {
      return -1;
    }
    if (rightId === undefined) {
      return 1;
    }
    const delta = comparePrereleaseId(leftId, rightId);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function comparePrereleaseId(left: number | string, right: number | string): number {
  if (left === right) {
    return 0;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left > right ? 1 : -1;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return left > right ? 1 : -1;
}

function parsePrereleaseId(value: string): number | string {
  return /^[0-9]+$/.test(value) ? Number.parseInt(value, 10) : value;
}

function toVersionNumber(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
