import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { config } from './config';

const KANNA_LOGIN_URL = 'https://kanna4u.com/signin';

class KannaScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    console.log('ブラウザを起動中...');
    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.actionTimeout);
    this.page.setDefaultNavigationTimeout(config.navigationTimeout);
    console.log('ブラウザ起動完了');
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`ログインページにアクセス: ${KANNA_LOGIN_URL}`);
    await this.page.goto(KANNA_LOGIN_URL);

    // メールアドレスを入力
    console.log('メールアドレスを入力中...');
    await this.page.fill('input[type="email"]', config.kannaEmail);

    // パスワードを入力
    console.log('パスワードを入力中...');
    await this.page.fill('input[type="password"]', config.kannaPassword);

    // ログインボタンをクリック
    console.log('ログインボタンをクリック...');
    await this.page.click('button:has-text("ログインする")');

    // ログイン後のページ遷移を待機
    await this.page.waitForLoadState('networkidle');

    console.log('ログイン完了');
    return true;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      console.log('ブラウザを終了しました');
    }
  }
}

async function main(): Promise<void> {
  const scraper = new KannaScraper();

  try {
    await scraper.init();
    await scraper.login();
    console.log('ログイン成功！');
  } catch (error) {
    console.error('エラーが発生しました:', error);
    throw error;
  } finally {
    await scraper.close();
  }
}

main();
