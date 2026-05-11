// Test-only shim for next/headers — minimal cookies()/headers() that
// don't actually integrate with a request. Used only by tests that
// touch lib/auth.ts; most lib tests should NOT import auth.

const _cookies = new Map<string, string>();
const _headers = new Map<string, string>();

export async function cookies() {
  return {
    get: (name: string) =>
      _cookies.has(name) ? { value: _cookies.get(name)! } : undefined,
    set: (name: string, value: string) => {
      _cookies.set(name, value);
    },
    delete: (name: string) => {
      _cookies.delete(name);
    },
  };
}

export async function headers() {
  return {
    get: (name: string) => _headers.get(name.toLowerCase()) ?? null,
  };
}

export const __test = {
  setCookie: (name: string, value: string) => _cookies.set(name, value),
  setHeader: (name: string, value: string) =>
    _headers.set(name.toLowerCase(), value),
  reset: () => {
    _cookies.clear();
    _headers.clear();
  },
};
