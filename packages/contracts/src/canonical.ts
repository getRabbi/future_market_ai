/**
 * Canonical JSON serialisation used for hashing (audit chain, action hashes, approval binding).
 * Object keys are sorted recursively; `undefined` members are dropped (as JSON.stringify does);
 * Dates become ISO strings; non-finite numbers and bigint are rejected so that two semantically
 * different inputs can never produce the same canonical string.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not supported; encode as string');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : serialise(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialise(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
