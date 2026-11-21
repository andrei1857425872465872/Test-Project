export default {
  name: 'Jest',
  resultsDir: './allure-results',
  output: './allure-report',
  historyPath: process.env.ALLURE_HISTORY_PATH ?? './allure-history/local.jsonl',
  appendHistory: process.env.ALLURE_APPEND_HISTORY !== 'false',
};
