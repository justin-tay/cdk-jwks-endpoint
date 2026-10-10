module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest'],
  },
  // Mirrors the paths in tsconfig.json.
  moduleNameMapper: {
    '^cdk-jwks-endpoint$': '<rootDir>/src/constructs',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  collectCoverageFrom: ['src/**/*.ts', 'bin/**/*.ts', '!bin/main.ts'],
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 100, lines: 95 },
  },
};
