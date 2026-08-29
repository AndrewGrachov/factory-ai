import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [
            'core/test/**/*.test.ts',
            'server/test/**/*.test.ts',
            // Every docker call and every board request is injected, so this suite spawns nothing.
            'driver/test/**/*.test.ts',
            // Renders panels with react-dom/server, so no DOM and no browser is needed.
            'web/test/**/*.test.tsx',
        ],
        pool: 'forks',
    },
});
