// Cheap comparisons for memoized components. The renderer's state keeps every object that did not change (see
// shared/state-sync.ts), so an unchanged value is the same object, and a copy made for display (`{ ...message, x }`)
// still holds the same parts: comparing one level by reference is enough, and never re-serializes anything.

/** The same keys holding the same values, by reference. */
export function shallowEqual(a: object | undefined, b: object | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && left[key] === right[key]);
}

/** The same items in the same order, by reference. */
export const sameItems = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a === b || (a.length === b.length && a.every((item, index) => item === b[index]));

/** For memo(): the same props by reference, where an array derived again counts as equal when its items are. */
export function sameProps(a: object, b: object) {
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const x = left[key],
        y = right[key];
      return x === y || (Array.isArray(x) && Array.isArray(y) && sameItems(x, y));
    })
  );
}
