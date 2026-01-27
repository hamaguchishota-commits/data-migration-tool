import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Login settings
  loginUrl: process.env.LOGIN_URL || '',
  username: process.env.USERNAME || '',
  password: process.env.PASSWORD || '',

  // Target settings
  targetUrl: process.env.TARGET_URL || '',

  // Browser settings
  headless: process.env.HEADLESS !== 'false',
  slowMo: parseInt(process.env.SLOW_MO || '0', 10),

  // Timeouts
  navigationTimeout: 30000,
  actionTimeout: 10000,
};
