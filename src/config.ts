import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // KANNA credentials
  kannaEmail: process.env.KANNA_EMAIL || '',
  kannaPassword: process.env.KANNA_PASSWORD || '',

  // Browser settings
  headless: process.env.HEADLESS !== 'false',
  slowMo: parseInt(process.env.SLOW_MO || '0', 10),

  // Timeouts
  navigationTimeout: 30000,
  actionTimeout: 10000,
};
