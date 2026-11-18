import base from "../../vitest.config";

export default {
  ...base,
  test: { ...base.test, browser: { enabled: false }, include: ["tests/mcp/**/*.test.ts"] }
};
