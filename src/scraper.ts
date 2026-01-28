import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { config } from './config';

const KANNA_LOGIN_URL = 'https://kanna4u.com/signin';
const KANNA_PROJECTS_URL = 'https://kanna4u.com/projects';

export interface Project {
  id: string;
  name: string;
  url: string;
}

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

  async getProjects(): Promise<Project[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`案件一覧ページにアクセス: ${KANNA_PROJECTS_URL}`);
    await this.page.goto(KANNA_PROJECTS_URL);
    await this.page.waitForLoadState('networkidle');

    const projects: Project[] = [];

    // ページネーションがある場合は全ページ取得
    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage) {
      console.log(`ページ ${pageNum} を取得中...`);

      // 案件リストの各行を取得
      const projectElements = await this.page.$$('table tbody tr, [data-testid="project-row"], .project-item, .project-card');

      if (projectElements.length === 0) {
        // 別のセレクタを試す（リンクベース）
        const projectLinks = await this.page.$$('a[href*="/projects/"]');

        for (const link of projectLinks) {
          const href = await link.getAttribute('href');
          const name = await link.textContent();

          if (href && name) {
            const idMatch = href.match(/\/projects\/(\d+)/);
            if (idMatch) {
              const id = idMatch[1];
              // 重複チェック
              if (!projects.find(p => p.id === id)) {
                projects.push({
                  id,
                  name: name.trim(),
                  url: `https://kanna4u.com${href}`,
                });
              }
            }
          }
        }
      } else {
        for (const element of projectElements) {
          // 行内のリンクから情報を取得
          const link = await element.$('a[href*="/projects/"]');
          if (link) {
            const href = await link.getAttribute('href');
            const name = await link.textContent();

            if (href && name) {
              const idMatch = href.match(/\/projects\/(\d+)/);
              if (idMatch) {
                projects.push({
                  id: idMatch[1],
                  name: name.trim(),
                  url: `https://kanna4u.com${href}`,
                });
              }
            }
          }
        }
      }

      // 次のページがあるかチェック
      const nextButton = await this.page.$('button:has-text("次"), a:has-text("次"), [aria-label="Next"], .pagination-next:not([disabled])');
      if (nextButton) {
        const isDisabled = await nextButton.getAttribute('disabled');
        if (!isDisabled) {
          await nextButton.click();
          await this.page.waitForLoadState('networkidle');
          pageNum++;
        } else {
          hasNextPage = false;
        }
      } else {
        hasNextPage = false;
      }
    }

    console.log(`${projects.length} 件の案件を取得しました`);
    return projects;
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

    // 案件一覧を取得
    const projects = await scraper.getProjects();
    console.log('\n=== 案件一覧 ===');
    for (const project of projects) {
      console.log(`[${project.id}] ${project.name}`);
      console.log(`    URL: ${project.url}`);
    }
  } catch (error) {
    console.error('エラーが発生しました:', error);
    throw error;
  } finally {
    await scraper.close();
  }
}

main();
