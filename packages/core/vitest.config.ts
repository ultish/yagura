import { defineConfig } from "vitest/config";

// Engine and landing tests drive real git and fake agent processes; on a loaded machine one can outlast vitest's 5 s default.
export default defineConfig({ test: { testTimeout: 20_000 } });
