// Registers the @/* path alias for the CommonJS test runner.
// TypeScript compiles tests to out/ but leaves `require('@/...')` literals
// intact; this shim resolves them to out/ at runtime.
const path = require('path');
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, 'out'),
  paths: { '@/*': ['./*'] },
});
