import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';

class WebScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    console.log('Initializing browser...');
    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.actionTimeout);
    this.page.setDefaultNavigationTimeout(config.navigationTimeout);
    console.log('Browser initialized.');
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Navigating to login page: ${config.loginUrl}`);
    await this.page.goto(config.loginUrl);

    // TODO: Customize selectors based on target site
    // Example login flow:
    // await this.page.fill('input[name="username"]', config.username);
    // await this.page.fill('input[name="password"]', config.password);
    // await this.page.click('button[type="submit"]');
    // await this.page.waitForNavigation();

    console.log('Login flow - customize selectors for your target site');
    return true;
  }

  async scrapeData(): Promise<unknown[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Navigating to target: ${config.targetUrl}`);
    await this.page.goto(config.targetUrl);

    // TODO: Customize data extraction based on target site
    // Example:
    // const data = await this.page.$$eval('.data-item', (items) =>
    //   items.map((item) => ({
    //     title: item.querySelector('.title')?.textContent?.trim(),
    //     value: item.querySelector('.value')?.textContent?.trim(),
    //   }))
    // );

    const data: unknown[] = [];
    console.log('Data extraction - customize selectors for your target site');
    return data;
  }

  async saveData(data: unknown[], filename: string): Promise<void> {
    const outputDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`Data saved to: ${filepath}`);
  }

  async screenshot(filename: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    const outputDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, filename);
    await this.page.screenshot({ path: filepath, fullPage: true });
    console.log(`Screenshot saved to: ${filepath}`);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      console.log('Browser closed.');
    }
  }
}

async function main(): Promise<void> {
  const scraper = new WebScraper();

  try {
    await scraper.init();
    await scraper.login();
    const data = await scraper.scrapeData();
    await scraper.saveData(data, 'scraped_data.json');
    await scraper.screenshot('final_state.png');
  } catch (error) {
    console.error('Scraping failed:', error);
    throw error;
  } finally {
    await scraper.close();
  }
}

main();
