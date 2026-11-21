const allPlatforms = process.env.JEST_ALL_PLATFORMS === 'true';
const common = {
  clearMocks: true,
  restoreMocks: true,
  testEnvironment: '<rootDir>/src/core/testing/allureEnvironment.js',
  testEnvironmentOptions: {
    customExportConditions: ['react-native'],
    resultsDir: 'allure-results',
  },
  setupFilesAfterEnv: [
    '<rootDir>/src/core/testing/setupTests.ts',
    '<rootDir>/src/core/testing/allurePlatform.ts',
  ],
};
const platformTests = [
  '**/*.platform.*test.[jt]s?(x)',
  '**/*.test.android.[jt]s?(x)',
  '**/*.test.native.[jt]s?(x)',
];

module.exports = {
  maxWorkers: 2,
  watchman: false,
  // The blank template keeps executable code at the root, including its entry point.
  collectCoverageFrom: [
    'App.tsx',
    'index.ts',
    'src/**/*.{ts,tsx}',
    '!**/*.test.*',
    '!**/*.styles.ts',
    '!**/*.d.ts',
    '!**/types.ts',
    '!**/constants.ts',
    '!src/app/**',
    '!src/core/testing/**',
  ],
  coverageReporters: [
    ['lcov', { projectRoot: require('node:path').resolve(__dirname, '..') }],
    'cobertura',
    'text-summary',
  ],
  projects: [
    { ...common, displayName: 'ios', preset: 'jest-expo/ios' },
    {
      ...common,
      displayName: 'android',
      preset: 'jest-expo/android',
      // Most tests run once; test:all-platforms runs every test on both platforms.
      ...(allPlatforms ? {} : { testMatch: platformTests }),
    },
  ],
};
