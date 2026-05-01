export default {
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 15000,
  use: {
    baseURL: 'http://localhost:5042',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  outputDir: 'tests/playwright-results',
};
