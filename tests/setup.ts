// Test environment — must run before any module that imports src/config/env.ts.
// WISECV_ENV_LOADED stops env.ts from reading a developer's real .env file.
process.env.WISECV_ENV_LOADED = '1'
process.env.DATABASE_URL ??= 'postgres://wisecv:wisecv@localhost:5432/wisecv_test'
process.env.CV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
process.env.LOG_LEVEL ??= 'error'
