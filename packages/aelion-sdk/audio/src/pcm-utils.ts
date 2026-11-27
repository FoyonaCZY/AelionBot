export function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function concat(left: Float32Array, right: Float32Array): Float32Array<ArrayBuffer> {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const result = new Float32Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
