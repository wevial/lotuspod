import { type TestInfo } from '@playwright/test';

// A test-only seam: fails the first attempt of the check that
// LOTUSPOD_TEST_FAIL_FIRST names, after it has run and written its state, so
// tests/test_check_retries.py can watch what CI's retry does next. Without the
// variable it does nothing.
export function failFirstAttempt(testInfo: TestInfo) {
  if (testInfo.retry === 0 && process.env.LOTUSPOD_TEST_FAIL_FIRST === testInfo.title) {
    throw new Error('failed on its first attempt by LOTUSPOD_TEST_FAIL_FIRST');
  }
}
