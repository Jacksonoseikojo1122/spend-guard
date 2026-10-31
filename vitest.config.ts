import { defineConfig } from "vitest/config";

// SQLite tests each get their own in-memory database, so files can run in parallel. The Postgres
// tests share one database and empty it before each test, so files must run one at a time or
// they wipe each other's rows mid-test.
export default defineConfig({
  test: {
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
