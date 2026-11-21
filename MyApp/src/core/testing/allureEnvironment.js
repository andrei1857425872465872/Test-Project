const { createJestEnvironment } = require('allure-jest/factory');
const NativeEnvironment = require(require('jest-expo/ios/jest-preset').testEnvironment);

module.exports = createJestEnvironment(NativeEnvironment);
