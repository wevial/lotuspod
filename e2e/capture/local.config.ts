import config from '../playwright.config';
export default { ...config, testDir: '.', testMatch: 'LOTUS-193.capture.ts' };
