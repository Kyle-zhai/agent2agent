// Test-only shim: lib/* modules import "server-only" which throws when
// loaded outside a server runtime. Tests run in plain Node — the shim
// turns the import into a no-op.
export {};
