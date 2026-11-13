/** `x.y.z` (optionally with a leading `v`) as numbers; anything else is undefined. */
function parts(value: string) {
  return /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
}
/** Negative when `a` is older than `b`, positive when newer, 0 when equal; NaN when either is not `x.y.z`. */
export function compareVersions(a: string, b: string) {
  const left = parts(a),
    right = parts(b);
  if (!left || !right) return NaN;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
