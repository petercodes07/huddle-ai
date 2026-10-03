export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function assert(condition, status, code, message) { if (!condition) throw new AppError(status, code, message); }
export function text(value, name, max, min = 1) {
  assert(typeof value === 'string' && value.trim().length >= min && value.trim().length <= max, 400, 'invalid_input', `${name} must be ${min}–${max} characters`);
  return value.trim();
}
export function integer(value, name, min, max, fallback) {
  const result = value === undefined ? fallback : value;
  assert(Number.isSafeInteger(result) && result >= min && result <= max, 400, 'invalid_input', `${name} must be an integer from ${min} to ${max}`);
  return result;
}
export function object(value) { assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_input', 'Expected a JSON object'); return value; }
