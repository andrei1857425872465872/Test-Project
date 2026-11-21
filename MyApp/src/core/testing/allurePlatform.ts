import * as allure from 'allure-js-commons';
import { Platform } from 'react-native';

beforeEach(async () => {
  await allure.parameter('platform', Platform.OS);
});
