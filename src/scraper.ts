import { chromium, Browser, Page, BrowserContext, ElementHandle, Locator } from 'playwright';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';

const KANNA_LOGIN_URL = 'https://kanna4u.com/signin';
const DOWNLOAD_DIR = './downloads';
const SCREENSHOT_DIR = './screenshots';

// ヘルパー: 指定秒数待機
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface Project {
  id: string;
  name: string;
  url: string;
}

export interface ProjectDetail {
  [key: string]: string;
}

export interface FolderItem {
  name: string;
  files: string[];
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
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
      ],
    });

    // Stealth mode: 人間らしいブラウザ設定
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });

    this.page = await this.context.newPage();

    // Stealth mode: webdriver検出を回避
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    this.page.setDefaultTimeout(config.actionTimeout);
    this.page.setDefaultNavigationTimeout(config.navigationTimeout);
    console.log('ブラウザ起動完了（Stealth mode有効）');

    // ディレクトリを作成
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  }

  // スクリーンショットを保存
  async saveScreenshot(name: string): Promise<void> {
    if (!this.page) return;
    const filename = `${name}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await this.page.screenshot({ path: filepath, fullPage: true });
    console.log(`  スクリーンショット保存: ${filepath}`);
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`ログインページにアクセス: ${KANNA_LOGIN_URL}`);
    await this.page.goto(KANNA_LOGIN_URL);

    // ログインフォームが表示されるまで待機
    await this.page.locator('input[type="email"]').waitFor({ state: 'visible' });

    console.log('メールアドレスを入力中...');
    await this.page.fill('input[type="email"]', config.kannaEmail);

    console.log('パスワードを入力中...');
    await this.page.fill('input[type="password"]', config.kannaPassword);

    console.log('ログインボタンをクリック...');
    await this.page.click('button:has-text("ログインする")');

    // SPA: URLがsigninから変わるまで待機
    console.log('ログイン処理を待機中...');
    await this.page.waitForURL((url) => !url.pathname.includes('/signin'), { timeout: 30000 });

    // ダッシュボードの要素が表示されるまで待機
    await sleep(1000);

    // デバッグ用スクリーンショット
    await this.saveScreenshot('after_login');

    console.log('ログイン完了');
    return true;
  }

  // 左サイドバーの「案件一覧」をクリックして案件一覧ページへ遷移
  async navigateToProjectList(): Promise<void> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('左サイドバーの「案件一覧」をクリック...');

    // クリック前のスクリーンショット
    await this.saveScreenshot('before_click_menu');

    const currentUrl = this.page.url();
    console.log(`  現在のURL: ${currentUrl}`);

    // サイドバー要素を特定（緑のサイドバー）
    const sidebar = this.page.locator('aside, nav, [role="navigation"], [class*="sidebar"], [class*="Sidebar"], [class*="side-menu"], [class*="sidenav"]').first();

    // サイドバー内の「案件一覧」リンク/ボタンを探す（exactで完全一致）
    const menuLink = sidebar.getByRole('link', { name: '案件一覧', exact: true })
      .or(sidebar.getByRole('button', { name: '案件一覧', exact: true }))
      .or(sidebar.getByText('案件一覧', { exact: true }));

    try {
      // 要素が表示されるまで待機
      console.log('  サイドバー内のメニューを探索中...');
      await menuLink.first().waitFor({ state: 'visible', timeout: 10000 });
      console.log('  サイドバー内の「案件一覧」を発見');

      // クリック
      await menuLink.first().click();
      console.log('  クリック成功');

      // SPA: URLが /cms を含むまで待機
      console.log('  URL変化を待機中...');
      await this.page.waitForURL(/\/cms/i, { timeout: 15000 });
      console.log('  案件一覧ページに遷移完了');

    } catch (e) {
      // フォールバック1: サイドバーをスコープせずに位置ベースで探す
      console.log('  Locatorで見つからず、位置ベースで探索...');
      console.log(`  エラー詳細: ${e}`);

      const allLinks = await this.page.$$('a');
      let clicked = false;

      console.log(`  全リンク数: ${allLinks.length}`);

      for (const link of allLinks) {
        const text = await link.textContent();
        if (text && text.trim() === '案件一覧') {
          const box = await link.boundingBox();
          const isVisible = await link.isVisible();
          console.log(`  「案件一覧」発見: visible=${isVisible}, x=${box?.x}, y=${box?.y}`);

          if (isVisible && box && box.x < 300) {
            console.log(`  位置ベースで発見 (x=${box.x})`);
            await link.click();
            clicked = true;

            // URLの変化を待機
            await this.page.waitForURL(/\/cms/i, { timeout: 15000 });
            break;
          }
        }
      }

      if (!clicked) {
        // フォールバック2: 部分一致で探す
        console.log('  完全一致で見つからず、部分一致で探索...');
        for (const link of allLinks) {
          const text = await link.textContent();
          if (text && text.includes('案件一覧')) {
            const box = await link.boundingBox();
            const isVisible = await link.isVisible();
            console.log(`  「案件一覧」含む要素: "${text.trim()}", visible=${isVisible}, x=${box?.x}`);

            if (isVisible && box && box.x < 300) {
              await link.click();
              clicked = true;
              await this.page.waitForURL(/\/cms/i, { timeout: 15000 });
              break;
            }
          }
        }
      }

      if (!clicked) {
        await this.saveScreenshot('error_menu_not_found');
        throw new Error('左サイドバーの「案件一覧」が見つかりません。スクリーンショットを確認してください。');
      }
    }

    // 遷移後少し待機してコンテンツの読み込みを待つ
    await sleep(1000);

    // 遷移後のスクリーンショット
    await this.saveScreenshot('after_click_menu');

    // 「すべての案件」を選択（案件テンプレートドロップダウン）
    await this.selectAllProjects();

    console.log('案件一覧ページに遷移しました');
  }

  // 案件テンプレートドロップダウンで「すべての案件」を選択
  private async selectAllProjects(): Promise<void> {
    if (!this.page) return;

    console.log('  「すべての案件」を選択中...');

    try {
      // ドロップダウントリガーを探す（「すべての案件」または他のテンプレート名が表示されている）
      const dropdownTrigger = this.page.locator('button:has-text("案件"), [class*="dropdown"] button, [class*="select"] button, [role="combobox"]').first();

      // または、現在のテンプレート名をクリック
      const templateSelector = this.page.locator('text=/すべての案件|自社案件|基本のテンプレート/').first();

      let clicked = false;

      // まずテンプレートセレクターを試す
      try {
        const isVisible = await templateSelector.isVisible({ timeout: 3000 });
        if (isVisible) {
          await templateSelector.click();
          clicked = true;
          console.log('  テンプレートセレクターをクリック');
        }
      } catch {
        // 見つからない場合は次へ
      }

      // ドロップダウントリガーを試す
      if (!clicked) {
        try {
          const isVisible = await dropdownTrigger.isVisible({ timeout: 3000 });
          if (isVisible) {
            await dropdownTrigger.click();
            clicked = true;
            console.log('  ドロップダウントリガーをクリック');
          }
        } catch {
          console.log('  ドロップダウンが見つかりません、スキップ');
          return;
        }
      }

      if (!clicked) {
        console.log('  テンプレート選択UIが見つかりません、スキップ');
        return;
      }

      await sleep(500);

      // ドロップダウンメニューから「すべての案件」を選択
      const allProjectsOption = this.page.locator('[role="option"]:has-text("すべての案件"), [role="menuitem"]:has-text("すべての案件"), li:has-text("すべての案件"), div:has-text("すべての案件")').first();

      try {
        await allProjectsOption.waitFor({ state: 'visible', timeout: 3000 });
        await allProjectsOption.click();
        console.log('  「すべての案件」を選択しました');
        await sleep(1000); // リスト再読み込みを待機
      } catch {
        // 既に「すべての案件」が選択されている場合、ESCで閉じる
        await this.page.keyboard.press('Escape');
        console.log('  既に「すべての案件」が選択済みか、オプションが見つかりません');
      }

    } catch (e) {
      console.log(`  テンプレート選択エラー: ${e}`);
    }

    // 「親案件」チェックボックスをオンにする
    await this.checkParentProjectFilter();
  }

  // 「親案件」チェックボックスをオンにする
  private async checkParentProjectFilter(): Promise<void> {
    if (!this.page) return;

    console.log('  「親案件」フィルターをオンにする...');

    try {
      // 親案件チェックボックスを探す（ラベルまたはinput要素）
      const parentCheckboxLabel = this.page.locator('label:has-text("親案件"), span:has-text("親案件")').first();
      const parentCheckboxInput = this.page.locator('input[type="checkbox"]').filter({ has: this.page.locator('xpath=..//text()[contains(., "親案件")]') });

      // まずラベルをクリックしてみる
      try {
        const isVisible = await parentCheckboxLabel.isVisible({ timeout: 3000 });
        if (isVisible) {
          // チェックボックスの状態を確認
          const checkbox = await this.page.$('input[type="checkbox"][name*="parent"], input[type="checkbox"][id*="parent"]');
          let isChecked = false;

          if (checkbox) {
            isChecked = await checkbox.isChecked();
          } else {
            // aria-checked属性をチェック
            const labelEl = await parentCheckboxLabel.elementHandle();
            if (labelEl) {
              const parentEl = await labelEl.$('xpath=..');
              if (parentEl) {
                const ariaChecked = await parentEl.getAttribute('aria-checked');
                isChecked = ariaChecked === 'true';
              }
            }
          }

          if (!isChecked) {
            await parentCheckboxLabel.click();
            console.log('  「親案件」チェックボックスをオンにしました');
            await sleep(1000); // リスト再読み込みを待機
          } else {
            console.log('  「親案件」チェックボックスは既にオン');
          }
          return;
        }
      } catch {
        // ラベルが見つからない場合
      }

      // 直接チェックボックス要素を探す
      const checkboxes = await this.page.$$('input[type="checkbox"]');
      for (const checkbox of checkboxes) {
        const parent = await checkbox.$('xpath=..');
        if (parent) {
          const text = await parent.textContent();
          if (text && text.includes('親案件')) {
            const isChecked = await checkbox.isChecked();
            if (!isChecked) {
              await checkbox.click();
              console.log('  「親案件」チェックボックスをオンにしました');
              await sleep(1000);
            } else {
              console.log('  「親案件」チェックボックスは既にオン');
            }
            return;
          }
        }
      }

      console.log('  「親案件」チェックボックスが見つかりません');

    } catch (e) {
      console.log(`  親案件フィルターエラー: ${e}`);
    }
  }

  // 案件一覧から全案件の情報を取得（無限スクロール対応）
  async getProjects(): Promise<Project[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projects: Project[] = [];
    const seenUrls = new Set<string>(); // URLで重複管理（より確実）
    const MAX_SCROLLS = 50;
    let scrollCount = 0;

    console.log('案件一覧を取得中（無限スクロール対応）...');

    // テーブルが表示されるまで待機
    await sleep(1000);

    // ページに表示されている総件数を取得（例: "86件"）
    let expectedTotal = 0;
    try {
      const countText = await this.page.textContent('text=/\\d+件/');
      if (countText) {
        const match = countText.match(/(\d+)件/);
        if (match) {
          expectedTotal = parseInt(match[1], 10);
          console.log(`  ページに表示されている総件数: ${expectedTotal} 件`);
        }
      }
    } catch {
      console.log('  総件数の取得に失敗、スクロールで全件取得します');
    }

    // まず、スクロールして全件を読み込む
    console.log('  全件読み込み中...');
    let lastRowCount = 0;
    let sameCountStreak = 0;

    while (scrollCount < MAX_SCROLLS) {
      // 現在のテーブル行数を確認
      const currentRows = await this.page.$$('table tbody tr');
      const currentRowCount = currentRows.length;

      if (currentRowCount === lastRowCount) {
        sameCountStreak++;
        if (sameCountStreak >= 3) {
          console.log(`  → スクロール完了（${currentRowCount} 行読み込み済み）`);
          break;
        }
      } else {
        sameCountStreak = 0;
        console.log(`  スクロール ${scrollCount + 1}: ${currentRowCount} 行表示中...`);
      }

      lastRowCount = currentRowCount;

      // 期待件数に達したら終了
      if (expectedTotal > 0 && currentRowCount >= expectedTotal) {
        console.log(`  → 期待件数 ${expectedTotal} 件に達しました`);
        break;
      }

      // ページ下部までスクロール
      await this.page.evaluate(() => {
        const table = document.querySelector('table');
        if (table) {
          let scrollContainer: HTMLElement | null = table.parentElement;
          while (scrollContainer && scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
            scrollContainer = scrollContainer.parentElement;
          }
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          } else {
            window.scrollTo(0, document.body.scrollHeight);
          }
        } else {
          window.scrollTo(0, document.body.scrollHeight);
        }
      });

      await sleep(800);
      scrollCount++;
    }

    // 全案件リンクを抽出（page.evaluateで一括取得）
    console.log('  案件データを抽出中...');

    const extractedData = await this.page.evaluate(() => {
      const results: { name: string; href: string }[] = [];
      const seen = new Set<string>();

      // 方法1: テーブル行から取得（様々なテーブル構造に対応）
      const rows = document.querySelectorAll('table tr, [role="row"]');
      console.log(`テーブル行数: ${rows.length}`);

      rows.forEach((row) => {
        const links = row.querySelectorAll('a');
        links.forEach((link) => {
          const href = link.getAttribute('href');
          // /cms/ を含むリンクが案件詳細へのリンク
          if (href && href.includes('/cms/') && !seen.has(href)) {
            const name = link.textContent?.trim();
            if (name && name.length > 0) {
              seen.add(href);
              results.push({ name, href });
            }
          }
        });
      });

      console.log(`テーブルから: ${results.length}`);

      // 方法2: テーブルから取れなかった場合、ページ全体から /cms/ リンクを探す
      if (results.length === 0) {
        console.log('テーブルから取得できず、全リンクを検索...');
        const allLinks = document.querySelectorAll('a[href*="/cms/"]');
        console.log(`/cms/リンク数: ${allLinks.length}`);

        allLinks.forEach((link) => {
          const href = link.getAttribute('href');
          if (href && !seen.has(href)) {
            const name = link.textContent?.trim();
            // 案件名らしいもの（短すぎず長すぎず）
            if (name && name.length > 1 && name.length < 100) {
              seen.add(href);
              results.push({ name, href });
            }
          }
        });
      }

      return results;
    });

    console.log(`  ページから ${extractedData.length} 件の案件リンクを検出`);

    for (let i = 0; i < extractedData.length; i++) {
      const { name, href } = extractedData[i];

      // URLで重複チェック
      const fullUrl = href.startsWith('http') ? href : `https://kanna4u.com${href}`;
      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);

      // IDを抽出（UUID形式にも対応）
      let id = `row-${i}`;
      const idMatch = href.match(/\/cms\/([a-zA-Z0-9\-]+)/);
      if (idMatch) {
        id = idMatch[1];
      }

      projects.push({
        id,
        name,
        url: fullUrl,
      });
    }

    if (scrollCount >= MAX_SCROLLS) {
      console.log(`警告: 最大スクロール回数 (${MAX_SCROLLS}) に達しました`);
    }

    console.log(`${projects.length} 件の案件を取得しました`);
    return projects;
  }

  // 案件詳細ページに直接遷移（URLを使用）
  async goToProject(project: Project): Promise<void> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`\n案件に遷移: ${project.name}`);
    console.log(`  URL: ${project.url}`);

    // URLに直接遷移（スクロール不要）
    await this.page.goto(project.url);

    // ページの読み込みを待機
    await sleep(2000);

    console.log('案件詳細ページに遷移しました');
  }

  // KANNA AIチャットボットを閉じる
  private async closeKannaAIChat(): Promise<void> {
    if (!this.page) return;

    try {
      // チャットボットのクローズボタンを探す
      const closeSelectors = [
        '[class*="chat"] button[aria-label*="close"]',
        '[class*="chat"] button[aria-label*="Close"]',
        '[class*="Chat"] [class*="close"]',
        '[class*="ai"] [class*="close"]',
        '[class*="assistant"] [class*="close"]',
        'button:has-text("×")',
        'button:has-text("✕")',
      ];

      for (const selector of closeSelectors) {
        const closeBtn = this.page.locator(selector).first();
        try {
          const isVisible = await closeBtn.isVisible({ timeout: 500 });
          if (isVisible) {
            await closeBtn.click();
            console.log('  KANNA AIチャットを閉じました');
            await sleep(300);
            return;
          }
        } catch {
          continue;
        }
      }

      // ESCキーでも閉じてみる
      await this.page.keyboard.press('Escape');
      await sleep(200);

    } catch {
      // チャットがない場合は何もしない
    }
  }

  // タブをクリックする共通関数（MUIボタン対応）
  private async clickTab(tabName: string): Promise<boolean> {
    if (!this.page) return false;

    // ページの読み込みを待機
    await sleep(500);

    try {
      // 方法1: page.evaluateでボタンを探してクリック（最も確実）
      const clicked = await this.page.evaluate((name) => {
        // 全てのボタン要素を取得
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          const btn = buttons[i];
          const text = btn.textContent?.trim();
          // 完全一致または含む
          if (text === name || text?.includes(name)) {
            // サイドバー内のボタンは除外（x座標が200px以下）
            const rect = btn.getBoundingClientRect();
            if (rect.x > 200 && rect.width > 0) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      }, tabName);

      if (clicked) {
        await sleep(1000);
        console.log(`  ${tabName}タブをクリック`);
        return true;
      }

      // 方法2: spanを含むボタンを探す（MUIボタン構造）
      const tabButton = this.page.locator(`button:has(span:text-is("${tabName}"))`).first();
      try {
        await tabButton.waitFor({ state: 'visible', timeout: 2000 });
        await tabButton.click();
        await sleep(1000);
        console.log(`  ${tabName}タブをクリック（span検索）`);
        return true;
      } catch {
        // 次の方法を試す
      }

      // 方法3: getByRole + name
      try {
        const roleTab = this.page.getByRole('button', { name: tabName });
        await roleTab.first().waitFor({ state: 'visible', timeout: 2000 });
        await roleTab.first().click();
        await sleep(1000);
        console.log(`  ${tabName}タブをクリック（role検索）`);
        return true;
      } catch {
        // 次の方法を試す
      }

      // 方法4: テキストで直接探す
      try {
        const textTab = this.page.getByText(tabName, { exact: true });
        const count = await textTab.count();
        for (let i = 0; i < count; i++) {
          const el = textTab.nth(i);
          const box = await el.boundingBox();
          // メインコンテンツ領域内のみ（x > 200）
          if (box && box.x > 200) {
            await el.click();
            await sleep(1000);
            console.log(`  ${tabName}タブをクリック（text検索）`);
            return true;
          }
        }
      } catch {
        // ignore
      }

      console.log(`  ${tabName}タブが見つかりません`);
      return false;

    } catch (e) {
      console.log(`  ${tabName}タブエラー: ${e}`);
      return false;
    }
  }

  // 概要タブからCSVをダウンロード
  async downloadOverviewCSV(projectName: string): Promise<string | null> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName));
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // KANNA AIチャットボットを閉じる（存在する場合）
    await this.closeKannaAIChat();

    console.log('  概要タブを開く...');

    // 概要タブをクリック（MUIボタン対応）
    await this.clickTab('概要');
    await sleep(1000);

    // デバッグ用スクリーンショット
    await this.saveScreenshot('project_detail_page');

    // ページをスクロールして「案件概要をCSVでダウンロード」ボタンを表示
    await this.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(500);

    // 「案件概要をCSVでダウンロード」ボタンを探してクリック
    const csvDownloadBtn = await this.page.$('button:has-text("案件概要をCSVでダウンロード"), a:has-text("案件概要をCSVでダウンロード"), button:has-text("CSVでダウンロード"), a:has-text("CSVでダウンロード")');

    if (csvDownloadBtn) {
      try {
        console.log('    CSVダウンロードボタンを検出');
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          csvDownloadBtn.click(),
        ]);

        const suggestedName = download.suggestedFilename();
        const safeFilename = this.sanitizeFilename(suggestedName || `${projectName}_概要.csv`);
        const filepath = path.join(projectDir, safeFilename);
        await download.saveAs(filepath);
        console.log(`    概要CSVダウンロード完了: ${safeFilename}`);
        return safeFilename;
      } catch (e) {
        console.log(`    概要CSVダウンロード失敗: ${e}`);
      }
    } else {
      console.log('    CSVダウンロードボタンが見つかりません');

      // フォールバック: page.evaluateでボタンを探す
      const clicked = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const btn of buttons) {
          const text = btn.textContent || '';
          if (text.includes('CSV') && text.includes('ダウンロード')) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        try {
          const download = await this.page.waitForEvent('download', { timeout: 30000 });
          const suggestedName = download.suggestedFilename();
          const safeFilename = this.sanitizeFilename(suggestedName || `${projectName}_概要.csv`);
          const filepath = path.join(projectDir, safeFilename);
          await download.saveAs(filepath);
          console.log(`    概要CSVダウンロード完了（フォールバック）: ${safeFilename}`);
          return safeFilename;
        } catch (e) {
          console.log(`    概要CSVダウンロード失敗（フォールバック）: ${e}`);
        }
      }
    }

    return null;
  }

  // 写真タブからカテゴリ一覧と写真をダウンロード（KANNA専用）
  // カテゴリは会社ごとにカスタマイズ可能なので動的に取得
  // フォルダの「...」メニューから一括ダウンロード
  async downloadPhotos(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'photos');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  写真タブを開く...`);

    // 写真タブをクリック
    const tabClicked = await this.clickTab('写真');
    if (!tabClicked) {
      return [];
    }

    // フォルダごとダウンロード
    const folders = await this.downloadFoldersFromTable(projectDir, '写真');

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  写真: ${folders.length} カテゴリ, ${totalFiles} ファイル`);
    return folders;
  }

  // テーブルのフォルダ行から「...」メニューでフォルダごとダウンロード（共通処理）
  private async downloadFoldersFromTable(projectDir: string, tabName: string): Promise<FolderItem[]> {
    if (!this.page) return [];

    const folders: FolderItem[] = [];

    // KANNA: カテゴリ（フォルダ）行を取得
    const categoryRows = await this.page.$$('table tbody tr');

    if (categoryRows.length === 0) {
      console.log(`  カテゴリが見つかりません`);
      return [];
    }

    console.log(`  ${categoryRows.length} 個のカテゴリを検出`);

    for (let i = 0; i < categoryRows.length; i++) {
      try {
        // ページが安定するのを待つ
        await sleep(500);

        // 再取得（SPAでDOM変わる可能性）
        const currentRows = await this.page.$$('table tbody tr');
        if (i >= currentRows.length) {
          console.log(`    行 ${i} が見つかりません、スキップ`);
          break;
        }

        const row = currentRows[i];

        // カテゴリ名を取得
        const categoryName = await row.evaluate((el) => {
          const nameCell = el.querySelector('td:first-child a, td:first-child, [class*="name"]');
          return nameCell?.textContent?.trim() || '';
        });

        if (!categoryName) continue;

        // 項目数を確認（0個ならスキップ）
        const itemCount = await row.evaluate((el) => {
          const cells = el.querySelectorAll('td');
          // 2番目のセルが項目数
          if (cells.length >= 2) {
            const text = cells[1].textContent?.trim() || '0';
            const match = text.match(/(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
          }
          return 0;
        });

        if (itemCount === 0) {
          console.log(`    カテゴリ: ${categoryName} (0件、スキップ)`);
          continue;
        }

        const safeCategoryName = this.sanitizeFilename(categoryName);
        console.log(`    カテゴリ: ${categoryName} (${itemCount}件)`);

        // 行の「...」メニューボタンをクリック
        const menuBtn = await row.$('td:last-child button, td:last-child [class*="menu"], td:last-child [class*="icon"], td:last-child svg');

        if (menuBtn) {
          console.log(`      メニューボタンをクリック...`);
          try {
            await menuBtn.click({ timeout: 5000 });
          } catch (clickError) {
            console.log(`      メニューボタンクリック失敗、スキップ`);
            continue;
          }
          await sleep(1500); // メニューが開くまで待つ

          // 「ダウンロード」メニュー項目をクリック
          // Material UIのMenuはrole="menu"の中にrole="menuitem"がある
          // または単純なdiv/liのリストの場合もある
          let downloadClicked = false;

          // 方法1: role="menuitem"を使う
          const menuItems = await this.page.$$('[role="menuitem"], [role="menu"] li, [class*="MuiMenuItem"], [class*="menu-item"]');
          console.log(`      メニューアイテム数: ${menuItems.length}`);
          for (const item of menuItems) {
            const text = await item.textContent();
            console.log(`        メニュー項目: "${text?.trim()}"`);
            if (text?.trim() === 'ダウンロード') {
              console.log(`      ダウンロードメニュー発見（menuitem）、クリック中...`);
              try {
                await item.click();
                downloadClicked = true;
                console.log(`      ダウンロード開始を待機中（最大2分）...`);

                const download = await this.page.waitForEvent('download', { timeout: 120000 });

                const suggestedName = download.suggestedFilename();
                const safeFilename = this.sanitizeFilename(suggestedName || `${safeCategoryName}.zip`);
                const filepath = path.join(projectDir, safeFilename);
                await download.saveAs(filepath);
                folders.push({ name: safeCategoryName, files: [safeFilename] });
                console.log(`      フォルダダウンロード完了: ${safeFilename}`);
                // メニューを閉じる
                await this.page.keyboard.press('Escape');
                await sleep(500);
              } catch (downloadError) {
                console.log(`      フォルダダウンロード失敗（タイムアウト）`);
                await this.page.keyboard.press('Escape');
                await sleep(500);
              }
              break;
            }
          }

          // 方法2: getByTextを使う（方法1で見つからなかった場合）
          if (!downloadClicked) {
            const downloadMenuItem = this.page.getByText('ダウンロード', { exact: true });
            const count = await downloadMenuItem.count();
            if (count > 0) {
              // 最後に表示されているもの（メニュー内のもの）をクリック
              const lastItem = downloadMenuItem.last();
              const isVisible = await lastItem.isVisible().catch(() => false);
              if (isVisible) {
                console.log(`      ダウンロードメニュー発見（getByText）、クリック中...`);
                try {
                  await lastItem.click();
                  downloadClicked = true;
                  console.log(`      ダウンロード開始を待機中（最大2分）...`);

                  const download = await this.page.waitForEvent('download', { timeout: 120000 });

                  const suggestedName = download.suggestedFilename();
                  const safeFilename = this.sanitizeFilename(suggestedName || `${safeCategoryName}.zip`);
                  const filepath = path.join(projectDir, safeFilename);
                  await download.saveAs(filepath);
                  folders.push({ name: safeCategoryName, files: [safeFilename] });
                  console.log(`      フォルダダウンロード完了: ${safeFilename}`);
                  // メニューを閉じる
                  await this.page.keyboard.press('Escape');
                  await sleep(500);
                } catch (downloadError) {
                  console.log(`      フォルダダウンロード失敗（タイムアウト）`);
                  await this.page.keyboard.press('Escape');
                  await sleep(500);
                }
              }
            }
          }

          if (!downloadClicked) {
            console.log(`      ダウンロードメニューが見つかりません - スキップ`);
            await this.page.keyboard.press('Escape');
            await sleep(500);
          }
        } else {
          console.log(`      メニューボタンが見つかりません`);
        }

        await sleep(500);

      } catch (e) {
        console.log(`    カテゴリ処理エラー: ${e}`);
        await this.page.keyboard.press('Escape');
        await sleep(300);
      }
    }

    return folders;
  }

  // フォルダ内のファイルを個別にダウンロード（フォールバック用）
  private async downloadFilesFromList(dir: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];

    // ファイルリストを取得
    const fileRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="file-row"], [class*="photo-item"]');

    if (fileRows.length === 0) {
      console.log(`        ファイルが見つかりません`);
      return [];
    }

    console.log(`        ${fileRows.length} 件のファイルを検出`);

    for (let i = 0; i < Math.min(fileRows.length, 50); i++) { // 最大50件まで
      try {
        const currentRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="file-row"], [class*="photo-item"]');
        if (i >= currentRows.length) break;

        const row = currentRows[i];

        // 行にチェックボックスがあれば選択
        const checkbox = await row.$('input[type="checkbox"]');
        if (checkbox) {
          await checkbox.click();
          continue; // 後でまとめてダウンロード
        }

        // 行をクリックして詳細を開く
        await row.click();
        await sleep(1500);

        // ダウンロードボタンを探す
        const downloadBtn = await this.page.$('button:has-text("ダウンロード"), a:has-text("ダウンロード"), a[download], [class*="download"]');

        if (downloadBtn) {
          try {
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 30000 }),
              downloadBtn.click(),
            ]);

            const suggestedName = download.suggestedFilename();
            const safeFilename = this.sanitizeFilename(suggestedName || `file_${i + 1}`);
            const filepath = path.join(dir, safeFilename);
            await download.saveAs(filepath);
            downloadedFiles.push(safeFilename);
            console.log(`          [${i + 1}] ${safeFilename}`);
          } catch {
            console.log(`          [${i + 1}] ダウンロード失敗`);
          }
        }

        // 閉じるボタンまたはESCで戻る
        const closeBtn = await this.page.$('button:has-text("閉じる"), button[class*="close"], [aria-label="close"]');
        if (closeBtn) {
          await closeBtn.click();
        } else {
          await this.page.keyboard.press('Escape');
        }
        await sleep(500);

      } catch (e) {
        console.log(`          ファイル処理エラー: ${e}`);
        await this.page.keyboard.press('Escape');
        await sleep(300);
      }
    }

    return downloadedFiles;
  }

  // 資料タブからフォルダ一覧とファイルをダウンロード（KANNA専用）
  // カテゴリは会社ごとにカスタマイズ可能なので動的に取得
  // フォルダの「...」メニューから一括ダウンロード
  async downloadDocuments(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'documents');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  資料タブを開く...`);

    // 資料タブをクリック
    const tabClicked = await this.clickTab('資料');
    if (!tabClicked) {
      return [];
    }

    // フォルダごとダウンロード
    const folders = await this.downloadFoldersFromTable(projectDir, '資料');

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  資料: ${folders.length} フォルダ, ${totalFiles} ファイル`);
    return folders;
  }

  // 画像をダウンロード
  private async downloadImagesFromCurrentView(dir: string, folderName: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];

    // KANNA専用: リスト表示から写真をダウンロード
    // 写真リストの行を取得（テーブル行またはリストアイテム）
    const photoRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="row"]:has([class*="file"]), [class*="row"]:has([class*="photo"])');

    if (photoRows.length > 0) {
      console.log(`      ${photoRows.length} 件のファイルを検出（リスト表示）`);

      for (let i = 0; i < photoRows.length; i++) {
        try {
          // 再取得（SPAでDOM変わる可能性）
          const currentRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="row"]:has([class*="file"]), [class*="row"]:has([class*="photo"])');
          if (i >= currentRows.length) break;

          const row = currentRows[i];
          const fileName = await row.textContent();
          console.log(`        [${i + 1}/${photoRows.length}] ${fileName?.trim().substring(0, 30)}...`);

          // 行をクリックして詳細/プレビューを開く
          await row.click();
          await sleep(1500);

          // ダウンロードボタンを探してクリック
          const downloadBtn = await this.page.$('button:has-text("ダウンロード"), a:has-text("ダウンロード"), [class*="download"], [aria-label*="download"]');

          if (downloadBtn) {
            try {
              const [download] = await Promise.all([
                this.page.waitForEvent('download', { timeout: 10000 }),
                downloadBtn.click(),
              ]);

              const suggestedName = download.suggestedFilename();
              const safeFilename = this.sanitizeFilename(suggestedName || `photo_${i + 1}.jpg`);
              const filepath = path.join(dir, safeFilename);
              await download.saveAs(filepath);
              downloadedFiles.push(safeFilename);
              console.log(`        ダウンロード完了: ${safeFilename}`);
            } catch (downloadError) {
              console.log(`        ダウンロード失敗（タイムアウト）`);
            }
          } else {
            // ダウンロードボタンがない場合、表示されてる画像を直接取得
            const displayedImg = await this.page.$('img[src*="storage"], img[src*="photo"], img[src*="image"], [class*="preview"] img, [class*="viewer"] img');
            if (displayedImg) {
              const src = await displayedImg.getAttribute('src');
              if (src) {
                try {
                  const response = await this.page.request.get(src);
                  const buffer = await response.body();
                  const filename = `photo_${i + 1}${this.getExtension(src, '.jpg')}`;
                  const filepath = path.join(dir, filename);
                  fs.writeFileSync(filepath, buffer);
                  downloadedFiles.push(filename);
                  console.log(`        画像取得完了: ${filename}`);
                } catch {
                  console.log(`        画像取得失敗`);
                }
              }
            }
          }

          // 詳細画面を閉じる（×ボタン、戻るボタン、または背景クリック）
          const closeBtn = await this.page.$('button:has-text("閉じる"), button[aria-label="Close"], [class*="close"], button:has-text("×"), button:has-text("✕")');
          if (closeBtn) {
            await closeBtn.click();
          } else {
            // ESCキーで閉じる
            await this.page.keyboard.press('Escape');
          }
          await sleep(500);

        } catch (e) {
          console.log(`        エラー: ${e}`);
        }
      }
    } else {
      // フォールバック: 従来の方法（直接表示されてる画像）
      const imageElements = await this.page.$$('img[src*="/photo"], img[src*="/image"], img[src*="storage"], .photo-item img, .gallery-item img');
      const downloadLinks = await this.page.$$('a[href*="download"], a[download], button:has-text("ダウンロード")');

      if (imageElements.length > 0) {
        console.log(`      ${imageElements.length} 枚の画像を検出（従来方式）`);

        for (let i = 0; i < imageElements.length; i++) {
          const img = imageElements[i];
          const src = await img.getAttribute('src');

          if (src) {
            try {
              const filename = `photo_${i + 1}${this.getExtension(src, '.jpg')}`;
              const filepath = path.join(dir, filename);

              const response = await this.page.request.get(src);
              const buffer = await response.body();
              fs.writeFileSync(filepath, buffer);

              downloadedFiles.push(filename);
            } catch (e) {
              console.log(`      画像ダウンロード失敗: ${src}`);
            }
          }
        }
      }

      for (const link of downloadLinks) {
        try {
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 5000 }),
            link.click(),
          ]);

          const filename = download.suggestedFilename() || `file_${downloadedFiles.length + 1}`;
          const filepath = path.join(dir, filename);
          await download.saveAs(filepath);
          downloadedFiles.push(filename);
        } catch {
          // スキップ
        }
      }
    }

    return downloadedFiles;
  }

  // ファイルをダウンロード
  private async downloadFilesFromCurrentView(dir: string, folderName: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];

    // KANNA専用: リスト表示から資料をダウンロード
    const fileRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="row"]:has([class*="file"]), [class*="row"]:has([class*="document"])');

    if (fileRows.length > 0) {
      console.log(`      ${fileRows.length} 件のファイルを検出（リスト表示）`);

      for (let i = 0; i < fileRows.length; i++) {
        try {
          // 再取得（SPAでDOM変わる可能性）
          const currentRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="row"]:has([class*="file"]), [class*="row"]:has([class*="document"])');
          if (i >= currentRows.length) break;

          const row = currentRows[i];
          const fileName = await row.textContent();
          console.log(`        [${i + 1}/${fileRows.length}] ${fileName?.trim().substring(0, 30)}...`);

          // 行をクリックして詳細/プレビューを開く
          await row.click();
          await sleep(1500);

          // ダウンロードボタンを探してクリック
          const downloadBtn = await this.page.$('button:has-text("ダウンロード"), a:has-text("ダウンロード"), [class*="download"], [aria-label*="download"]');

          if (downloadBtn) {
            try {
              const [download] = await Promise.all([
                this.page.waitForEvent('download', { timeout: 10000 }),
                downloadBtn.click(),
              ]);

              const suggestedName = download.suggestedFilename();
              const safeFilename = this.sanitizeFilename(suggestedName || `file_${i + 1}`);
              const filepath = path.join(dir, safeFilename);
              await download.saveAs(filepath);
              downloadedFiles.push(safeFilename);
              console.log(`        ダウンロード完了: ${safeFilename}`);
            } catch (downloadError) {
              console.log(`        ダウンロード失敗（タイムアウト）`);
            }
          }

          // 詳細画面を閉じる
          const closeBtn = await this.page.$('button:has-text("閉じる"), button[aria-label="Close"], [class*="close"], button:has-text("×"), button:has-text("✕")');
          if (closeBtn) {
            await closeBtn.click();
          } else {
            await this.page.keyboard.press('Escape');
          }
          await sleep(500);

        } catch (e) {
          console.log(`        エラー: ${e}`);
        }
      }
    } else {
      // フォールバック: 従来の方法
      const fileLinks = await this.page.$$('a[href*="download"], a[download], a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".xls"], a[href$=".xlsx"], .file-item a, .document-item a');

      console.log(`      ${fileLinks.length} 個のファイルリンクを検出（従来方式）`);

      for (const link of fileLinks) {
        try {
          const linkText = await link.textContent();

          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 10000 }),
            link.click(),
          ]);

          const filename = download.suggestedFilename() || linkText?.trim() || `file_${downloadedFiles.length + 1}`;
          const safeFilename = this.sanitizeFilename(filename);
          const filepath = path.join(dir, safeFilename);
          await download.saveAs(filepath);
          downloadedFiles.push(safeFilename);
          console.log(`        ダウンロード: ${safeFilename}`);
        } catch {
          // スキップ
        }
      }
    }

    return downloadedFiles;
  }

  // 報告タブからデータを取得（KANNA専用: カード形式 + 写真ダウンロード）
  async getReports(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'reports');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  報告タブを開く...');
    const reports: any[] = [];

    // 報告タブをクリック
    const tabClicked = await this.clickTab('報告');
    if (!tabClicked) {
      return [];
    }

    await sleep(1000);

    // KANNA: 報告カードを取得
    // 報告カードは特定の構造を持つ（報告者名、タイトル、内容、写真アイコン、時刻）
    // page.evaluateで実際の報告カードだけを検出
    const reportCardInfo = await this.page.evaluate(() => {
      const cards: { index: number; text: string }[] = [];

      // 「報告一覧」セクション内のカードを探す
      // 報告カードは通常、クリック可能な要素で、報告者名と内容を含む
      const allElements = document.querySelectorAll('div, article, section');

      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        const text = el.textContent || '';
        const rect = el.getBoundingClientRect();

        // 報告カードの特徴:
        // - メインコンテンツ領域内（x > 100）
        // - 適切なサイズ（width > 200, height > 30, height < 400）
        // - 報告種別のキーワードを含む
        // - または時刻っぽい文字列（XX:XX形式）を含む
        const hasReportKeyword = /開始報告|進捗報告|終了報告|完了報告|修正依頼|修正報告|検収報告|未入金報告|入金報告|着金報告|作業報告|日報|週報|月報|中間報告/.test(text);
        const hasTimeFormat = /\d{1,2}:\d{2}/.test(text);
        const isInMainArea = rect.x > 100 && rect.width > 200;
        const hasProperSize = rect.height > 30 && rect.height < 400 && rect.width < 900;

        if ((hasReportKeyword || hasTimeFormat) && isInMainArea && hasProperSize) {
          // 親要素と重複しないようにチェック
          const isDuplicate = cards.some(c => text.includes(c.text) || c.text.includes(text));
          if (!isDuplicate) {
            cards.push({ index: i, text: text.substring(0, 100) });
          }
        }
      }

      return cards;
    });

    console.log(`    ${reportCardInfo.length} 件の報告を検出`);

    if (reportCardInfo.length === 0) {
      // フォールバック: テーブル行を試す
      const tableRows = await this.page.$$('table tbody tr');
      if (tableRows.length > 0) {
        console.log(`    テーブル形式: ${tableRows.length} 行を検出`);
      }
      return [];
    }

    // 各報告カードを処理
    for (let i = 0; i < reportCardInfo.length; i++) {
      try {
        console.log(`      [${i + 1}/${reportCardInfo.length}] ${reportCardInfo[i].text.substring(0, 50)}...`);

        // 報告カードをクリック - Playwrightのlocatorを使用
        // 報告種別（開始報告、終了報告など）を含む要素を探してクリック
        const reportKeywords = ['開始報告', '進捗報告', '終了報告', '完了報告', '修正依頼', '修正報告', '検収報告', '未入金報告', '入金報告', '着金報告'];
        let clicked = false;

        for (const keyword of reportKeywords) {
          if (reportCardInfo[i].text.includes(keyword)) {
            // このキーワードを含むカードを探す
            const cards = this.page.locator(`text=${keyword}`);
            const count = await cards.count();
            console.log(`        "${keyword}" を含む要素: ${count} 件`);

            if (count > 0) {
              // 最初の可視要素をクリック
              for (let k = 0; k < count; k++) {
                const card = cards.nth(k);
                const isVisible = await card.isVisible().catch(() => false);
                if (isVisible) {
                  console.log(`        カードをクリック...`);
                  await card.click();
                  clicked = true;
                  break;
                }
              }
            }
            if (clicked) break;
          }
        }

        if (!clicked) {
          console.log(`        クリック失敗 - キーワードが見つかりません`);
          continue;
        }

        await sleep(2500); // 報告詳細ページへの遷移を待つ

        // URLが変わったか確認（報告詳細ページは /work-reports/{uuid} の形式）
        const currentUrl = this.page.url();
        console.log(`        現在のURL: ${currentUrl}`);

        // 報告詳細ページかどうかチェック（UUIDパターン: work-reports/で終わらない）
        const isDetailPage = /\/work-reports\/[a-f0-9-]+/.test(currentUrl);

        if (!isDetailPage) {
          console.log(`        報告詳細ページに遷移していません、スキップ`);
          continue;
        }

        const reportPhotoDir = path.join(projectDir, `report_${i + 1}`);
        if (!fs.existsSync(reportPhotoDir)) {
          fs.mkdirSync(reportPhotoDir, { recursive: true });
        }

        // 1. CSVダウンロードボタンをクリック
        const csvDownloadBtn = this.page.getByText('CSVダウンロード', { exact: false });
        const csvBtnVisible = await csvDownloadBtn.isVisible().catch(() => false);

        if (csvBtnVisible) {
          try {
            console.log(`        CSVダウンロード中...`);
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 30000 }),
              csvDownloadBtn.click(),
            ]);

            const suggestedName = download.suggestedFilename();
            const safeFilename = this.sanitizeFilename(suggestedName || `report_${i + 1}.csv`);
            const filepath = path.join(reportPhotoDir, safeFilename);
            await download.saveAs(filepath);
            console.log(`        CSVダウンロード完了: ${safeFilename}`);
          } catch (e) {
            console.log(`        CSVダウンロード失敗`);
          }
        }

        // 2. 写真があればクリックしてダウンロード
        // 写真セクション内の画像を探す（より広いセレクター）
        // KANNAの報告詳細では画像は様々な形式で表示される
        const allImages = await this.page.$$('img');

        // 適切なサイズの画像だけをフィルタリング（サムネイルや小さなアイコンを除外）
        const clickablePhotos: (typeof allImages)[number][] = [];
        for (const img of allImages) {
          try {
            const box = await img.boundingBox();
            const src = await img.getAttribute('src');
            // サイズが50x50以上で、data:URLやアイコンでない画像
            if (box && box.width >= 50 && box.height >= 50 && src && !src.startsWith('data:') && !src.includes('icon')) {
              clickablePhotos.push(img);
            }
          } catch {
            // 無視
          }
        }

        console.log(`        写真: ${clickablePhotos.length} 件検出（全img: ${allImages.length}件）`);

        for (let j = 0; j < clickablePhotos.length; j++) {
          try {
            console.log(`        写真 ${j + 1}/${clickablePhotos.length} を開く...`);
            await clickablePhotos[j].click();
            await sleep(1500);

            // 全画面表示の「ダウンロード」ボタンを探す
            const downloadBtn = this.page.getByText('ダウンロード', { exact: true });
            const downloadBtnVisible = await downloadBtn.isVisible().catch(() => false);

            if (downloadBtnVisible) {
              try {
                const [download] = await Promise.all([
                  this.page.waitForEvent('download', { timeout: 30000 }),
                  downloadBtn.click(),
                ]);

                const suggestedName = download.suggestedFilename();
                const safeFilename = this.sanitizeFilename(suggestedName || `photo_${j + 1}.jpg`);
                const filepath = path.join(reportPhotoDir, safeFilename);
                await download.saveAs(filepath);
                console.log(`        写真ダウンロード完了: ${safeFilename}`);
              } catch (e) {
                console.log(`        写真ダウンロード失敗`);
              }
            }

            // 全画面表示を閉じる（閉じるボタンまたはEscape）
            const closeBtn = await this.page.$('button:has-text("閉じる"), [aria-label="close"], [class*="close"]');
            if (closeBtn) {
              await closeBtn.click();
            } else {
              await this.page.keyboard.press('Escape');
            }
            await sleep(500);

          } catch (photoError) {
            console.log(`        写真処理エラー: ${photoError}`);
            await this.page.keyboard.press('Escape');
            await sleep(300);
          }
        }

        reports.push({ index: i + 1 });

        // 報告一覧に戻る
        const backLink = this.page.getByText('報告一覧に戻る', { exact: false });
        const backLinkVisible = await backLink.isVisible().catch(() => false);

        if (backLinkVisible) {
          await backLink.click();
          await sleep(1500);
        } else {
          await this.page.goBack();
          await sleep(1500);
        }

      } catch (e) {
        console.log(`      エラー: ${e}`);
        await this.page.keyboard.press('Escape');
        await sleep(300);
        // 報告タブに戻る
        await this.clickTab('報告');
        await sleep(1000);
      }
    }

    console.log(`  報告: ${reports.length} 件`);
    return reports;
  }

  // 工程表タブからExcelをダウンロード（日付範囲モーダル対応）
  async downloadSchedule(projectName: string): Promise<string[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'schedule');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  工程表タブを開く...');
    const downloadedFiles: string[] = [];

    // 工程表タブをクリック
    const tabClicked = await this.clickTab('工程表');
    if (!tabClicked) {
      return [];
    }

    await sleep(1000);

    // 工程表から全ての日付を取得（開始日・終了日）
    const dates = await this.page.evaluate(() => {
      const allDates: string[] = [];

      // 日付パターン: YYYY/MM/DD または YYYY-MM-DD
      const datePattern = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/g;

      // ページ内のテキストから日付を抽出
      const text = document.body.textContent || '';
      let match;
      while ((match = datePattern.exec(text)) !== null) {
        allDates.push(match[0]);
      }

      return allDates;
    });

    console.log(`    工程表の日付を検出: ${dates.length} 件`);

    // 日付をDateオブジェクトに変換してソート
    const parsedDates = dates.map(d => {
      const normalized = d.replace(/-/g, '/');
      return new Date(normalized);
    }).filter(d => !isNaN(d.getTime()));

    if (parsedDates.length === 0) {
      console.log('    日付が見つかりません');
      return [];
    }

    // 最小（一番若い）と最大（一番古い）を取得
    const minDate = new Date(Math.min(...parsedDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...parsedDates.map(d => d.getTime())));

    console.log(`    出力期間: ${minDate.toISOString().split('T')[0]} ~ ${maxDate.toISOString().split('T')[0]}`);

    // Excel出力ボタンを探してクリック
    const excelBtn = await this.page.$('button:has-text("Excel出力"), button:has-text("Excel"), a:has-text("Excel出力"), a:has-text("Excel")');

    if (!excelBtn) {
      console.log('    Excel出力ボタンが見つかりません');
      return [];
    }

    console.log('    Excel出力ボタンをクリック');
    await excelBtn.click();
    await sleep(1000);

    // モーダルが表示されるのを待つ
    try {
      await this.page.waitForSelector('[role="dialog"], [class*="modal"], [class*="Modal"]', { timeout: 5000 });
      console.log('    日付範囲モーダルを検出');

      // 日付フィールドをクリック（「未設定」または既存の日付形式）
      // モーダル内の日付フィールドを取得
      const modal = this.page.locator('[role="dialog"], [class*="modal"], [class*="Modal"]').first();

      // 未設定テキストの数を確認
      const allUnset = modal.getByText('未設定', { exact: true });
      const unsetCount = await allUnset.count();
      console.log(`    「未設定」の数: ${unsetCount}`);

      // 既存の日付フィールド（YYYY/MM/DD形式）を取得
      const existingDates = modal.getByText(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
      const existingCount = await existingDates.count();
      console.log(`    既存日付の数: ${existingCount}`);

      // 開始日を設定
      console.log('    開始日を設定中...');
      let startDateClicked = false;

      try {
        if (unsetCount >= 1) {
          // 「未設定」がある場合は最初のものをクリック
          await allUnset.first().click({ timeout: 3000 });
          console.log('    開始日フィールドをクリック（未設定）');
          startDateClicked = true;
        } else if (existingCount >= 1) {
          // 既存の日付がある場合は最初のものをクリック
          await existingDates.first().click({ timeout: 3000 });
          console.log('    開始日フィールドをクリック（既存日付）');
          startDateClicked = true;
        }

        if (startDateClicked) {
          await sleep(1000);
          const startSelected = await this.selectDateInCalendar(minDate);
          if (!startSelected) {
            console.log('    開始日の選択に失敗');
          }
          // カレンダーを閉じるためにモーダル外をクリックするか、Escapeキーを押す
          await this.page.keyboard.press('Escape');
          await sleep(500);
        } else {
          console.log('    開始日フィールドが見つかりません');
        }
      } catch (e) {
        console.log(`    開始日フィールドのクリック失敗: ${e}`);
        // エラー時もカレンダーが開いている可能性があるので閉じる
        await this.page.keyboard.press('Escape');
        await sleep(300);
      }

      await sleep(500);

      // 終了日を設定
      console.log('    終了日を設定中...');

      // 再度カウントを取得（開始日設定後に変わっている可能性）
      const remainingUnset = modal.getByText('未設定', { exact: true });
      const remainingUnsetCount = await remainingUnset.count();
      const remainingDates = modal.getByText(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
      const remainingDatesCount = await remainingDates.count();
      console.log(`    残りの「未設定」: ${remainingUnsetCount}, 残りの日付: ${remainingDatesCount}`);

      try {
        let endDateClicked = false;

        if (remainingUnsetCount >= 1) {
          // 「未設定」がまだある場合（終了日が未設定）
          await remainingUnset.first().click({ timeout: 3000 });
          console.log('    終了日フィールドをクリック（未設定）');
          endDateClicked = true;
        } else if (remainingDatesCount >= 2) {
          // 2つ以上の日付がある場合、2番目が終了日
          await remainingDates.nth(1).click({ timeout: 3000 });
          console.log('    終了日フィールドをクリック（既存日付）');
          endDateClicked = true;
        } else if (remainingDatesCount === 1) {
          // 1つしかない場合でも終了日として扱う
          await remainingDates.first().click({ timeout: 3000 });
          console.log('    終了日フィールドをクリック（単一日付）');
          endDateClicked = true;
        }

        if (endDateClicked) {
          await sleep(1000);
          const endSelected = await this.selectDateInCalendar(maxDate);
          if (!endSelected) {
            console.log('    終了日の選択に失敗');
          }
          // カレンダーを閉じる
          await this.page.keyboard.press('Escape');
          await sleep(500);
        } else {
          console.log('    終了日フィールドが見つかりません');
        }
      } catch (e) {
        console.log(`    終了日フィールドのクリック失敗: ${e}`);
        // エラー時もカレンダーを閉じる
        await this.page.keyboard.press('Escape');
        await sleep(300);
      }

      await sleep(500);

      // カレンダーやポップアップが開いていたら閉じる
      await this.page.keyboard.press('Escape');
      await sleep(300);

      // 「出力する」ボタンをクリック
      // モーダル内のボタンを優先的に探す
      const exportBtnLocator = modal.locator('button:has-text("出力する"), button:has-text("出力")');
      const exportBtnCount = await exportBtnLocator.count();

      if (exportBtnCount > 0) {
        console.log('    出力するボタンをクリック');

        try {
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 60000 }),
            exportBtnLocator.first().click({ force: true }),
          ]);

          const suggestedName = download.suggestedFilename();
          const safeFilename = this.sanitizeFilename(suggestedName || 'schedule.xlsx');
          const filepath = path.join(projectDir, safeFilename);
          await download.saveAs(filepath);
          downloadedFiles.push(safeFilename);
          console.log(`    ダウンロード完了: ${safeFilename}`);
        } catch (e) {
          console.log(`    ダウンロード失敗: ${e}`);
          // フォールバック: ページ全体から出力ボタンを探す
          try {
            const fallbackBtn = this.page.locator('button:has-text("出力する"), button:has-text("出力")').first();
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 30000 }),
              fallbackBtn.click({ force: true }),
            ]);

            const suggestedName = download.suggestedFilename();
            const safeFilename = this.sanitizeFilename(suggestedName || 'schedule.xlsx');
            const filepath = path.join(projectDir, safeFilename);
            await download.saveAs(filepath);
            downloadedFiles.push(safeFilename);
            console.log(`    ダウンロード完了（フォールバック）: ${safeFilename}`);
          } catch (e2) {
            console.log(`    フォールバックダウンロードも失敗: ${e2}`);
          }
        }
      } else {
        console.log('    出力するボタンが見つかりません');
      }

    } catch (e) {
      console.log(`    モーダルが表示されませんでした: ${e}`);

      // モーダルなしで直接ダウンロードを試みる
      try {
        const download = await this.page.waitForEvent('download', { timeout: 10000 });
        const suggestedName = download.suggestedFilename();
        const safeFilename = this.sanitizeFilename(suggestedName || 'schedule.xlsx');
        const filepath = path.join(projectDir, safeFilename);
        await download.saveAs(filepath);
        downloadedFiles.push(safeFilename);
        console.log(`    ダウンロード完了（直接）: ${safeFilename}`);
      } catch {
        console.log('    Excelダウンロード失敗');
      }
    }

    console.log(`  工程表: ${downloadedFiles.length} ファイル`);
    return downloadedFiles;
  }

  // カレンダーから日付を選択するヘルパー関数
  private async selectDateInCalendar(targetDate: Date): Promise<boolean> {
    if (!this.page) return false;

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth() + 1; // 1-indexed
    const targetDay = targetDate.getDate();

    try {
      // カレンダーが表示されるのを待つ
      await sleep(500);

      // 年月を移動（必要に応じて）
      // カレンダーの現在の年月を取得
      const MAX_NAVIGATION = 24; // 最大2年分
      for (let i = 0; i < MAX_NAVIGATION; i++) {
        const currentYearMonth = await this.page.evaluate(() => {
          // カレンダーのヘッダーから年月を取得
          const header = document.querySelector('[class*="calendar"] [class*="header"], [class*="picker"] [class*="header"], [class*="MuiPickersCalendarHeader"]');
          if (header) {
            return header.textContent || '';
          }
          // フォールバック: 年月を含むテキストを探す
          const yearMonthPattern = /(\d{4})年(\d{1,2})月/;
          const bodyText = document.body.textContent || '';
          const match = bodyText.match(yearMonthPattern);
          if (match) {
            return `${match[1]}年${match[2]}月`;
          }
          return '';
        });

        // 現在の年月をパース
        const yearMonthMatch = currentYearMonth.match(/(\d{4})年(\d{1,2})月/);
        if (!yearMonthMatch) {
          console.log(`      カレンダーの年月を取得できません: ${currentYearMonth}`);
          break;
        }

        const currentYear = parseInt(yearMonthMatch[1]);
        const currentMonth = parseInt(yearMonthMatch[2]);

        if (currentYear === targetYear && currentMonth === targetMonth) {
          // 目標の月に到達
          break;
        }

        // 前後の月に移動
        const diff = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
        const navButton = diff < 0
          ? await this.page.$('button[aria-label*="前"], button:has-text("<"), [class*="prev"], [class*="Prev"]')
          : await this.page.$('button[aria-label*="次"], button:has-text(">"), [class*="next"], [class*="Next"]');

        if (navButton) {
          await navButton.click();
          await sleep(300);
        } else {
          break;
        }
      }

      // 日付をクリック
      await sleep(300);
      const dayClicked = await this.page.evaluate((day) => {
        // 日付ボタンを探す（MUIカレンダー対応）
        const dayButtons = Array.from(document.querySelectorAll('button[class*="MuiPickersDay"], [class*="day"], [role="gridcell"] button, [class*="calendar"] button'));

        for (let i = 0; i < dayButtons.length; i++) {
          const btn = dayButtons[i];
          const text = btn.textContent?.trim();
          if (text === String(day)) {
            // 無効化されていないか確認
            const isDisabled = btn.hasAttribute('disabled') || btn.classList.contains('disabled');
            if (!isDisabled) {
              (btn as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      }, targetDay);

      if (dayClicked) {
        console.log(`      日付選択: ${targetYear}/${targetMonth}/${targetDay}`);
        await sleep(300);

        // OKボタンがあればクリック
        const okBtn = await this.page.$('button:has-text("OK"), button:has-text("確定")');
        if (okBtn) {
          await okBtn.click();
          await sleep(300);
        }

        return true;
      } else {
        console.log(`      日付が見つかりません: ${targetDay}`);
        return false;
      }

    } catch (e) {
      console.log(`      カレンダー操作エラー: ${e}`);
      return false;
    }
  }

  // タスクタブからデータを取得
  async getTasks(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  タスクタブを開く...');
    const tasks: any[] = [];

    // タスクタブをクリック
    const tabClicked = await this.clickTab('タスク');
    if (!tabClicked) {
      return [];
    }

    await sleep(500);

    // タスクリストの行を取得
    const taskRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="task"] [class*="row"], [class*="row"]:has([class*="task"]), [class*="todo"], [class*="checklist"] [class*="item"]');

    if (taskRows.length > 0) {
      console.log(`    ${taskRows.length} 件のタスクを検出`);

      for (let i = 0; i < taskRows.length; i++) {
        try {
          const currentRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="task"] [class*="row"], [class*="row"]:has([class*="task"]), [class*="todo"], [class*="checklist"] [class*="item"]');
          if (i >= currentRows.length) break;

          const row = currentRows[i];

          // 行から直接データを抽出
          const taskData = await row.evaluate((el) => {
            const task: { [key: string]: string } = {};

            // タイトル/名前
            const title = el.querySelector('[class*="title"], [class*="name"], a, td:first-child');
            if (title) task['タイトル'] = title.textContent?.trim() || '';

            // ステータス
            const status = el.querySelector('[class*="status"], [class*="state"]');
            if (status) task['ステータス'] = status.textContent?.trim() || '';

            // チェックボックス
            const checkbox = el.querySelector('input[type="checkbox"]');
            if (checkbox) task['完了'] = (checkbox as HTMLInputElement).checked ? '完了' : '未完了';

            // 担当者
            const assignee = el.querySelector('[class*="assignee"], [class*="user"], [class*="owner"]');
            if (assignee) task['担当者'] = assignee.textContent?.trim() || '';

            // 期限
            const dueDate = el.querySelector('[class*="due"], [class*="deadline"], [class*="date"]');
            if (dueDate) task['期限'] = dueDate.textContent?.trim() || '';

            // テーブル行の場合
            const cells = el.querySelectorAll('td');
            if (cells.length > 0) {
              cells.forEach((cell, idx) => {
                const text = cell.textContent?.trim();
                if (text && !Object.values(task).includes(text)) {
                  task[`列${idx + 1}`] = text;
                }
              });
            }

            // 全テキスト（フォールバック）
            if (Object.keys(task).length === 0) {
              task['内容'] = el.textContent?.trim() || '';
            }

            return task;
          });

          tasks.push({ index: i + 1, ...taskData });
          console.log(`      [${i + 1}/${taskRows.length}] ${taskData['タイトル'] || taskData['内容']?.substring(0, 30) || 'タスク'}...`);

        } catch (e) {
          console.log(`      エラー: ${e}`);
        }
      }
    } else {
      // リストがない場合
      const pageContent = await this.page.evaluate(() => {
        const container = document.querySelector('[class*="tab-content"], [class*="panel"], main, [role="tabpanel"]');
        return container?.textContent?.trim() || '';
      });
      if (pageContent && pageContent !== '') {
        tasks.push({ content: pageContent });
      }
    }

    console.log(`  タスク: ${tasks.length} 件`);
    return tasks;
  }

  // 帳票タブからデータをダウンロード（KANNA専用）
  // フォルダは一括ダウンロード不可→フォルダに入って個別ダウンロード
  async downloadForms(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'forms');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  帳票タブを開く...');

    // 帳票タブをクリック
    const tabClicked = await this.clickTab('帳票');
    if (!tabClicked) {
      return [];
    }

    await sleep(500);

    const folders: FolderItem[] = [];

    // ルートレベルの帳票ファイルをダウンロード
    const rootFiles = await this.downloadFormsFromCurrentView(projectDir);
    if (rootFiles.length > 0) {
      folders.push({ name: 'root', files: rootFiles });
    }

    // フォルダ一覧を取得
    const folderNames: string[] = [];
    const formRows = await this.page.$$('table tbody tr');

    for (const row of formRows) {
      // フォルダ行かどうか確認（入力率%がないのがフォルダ）
      const rowInfo = await row.evaluate((el) => {
        const cells = el.querySelectorAll('td');
        const hasInputRate = Array.from(cells).some(cell => cell.textContent?.includes('%'));
        const nameCell = el.querySelector('td:first-child a, td:first-child');
        const name = nameCell?.textContent?.trim() || '';
        return { isFolder: !hasInputRate, name };
      });

      if (rowInfo.isFolder && rowInfo.name) {
        folderNames.push(rowInfo.name);
      }
    }

    console.log(`  ${folderNames.length} 個のフォルダを検出`);

    // 各フォルダに入ってダウンロード
    for (const folderName of folderNames) {
      console.log(`    フォルダ: ${folderName}`);

      try {
        // フォルダをクリック
        const folderLink = this.page.locator(`table tbody tr:has-text("${folderName}") td:first-child`).first();
        await folderLink.click();
        await sleep(1500);

        // フォルダ用ディレクトリ
        const safeFolderName = this.sanitizeFilename(folderName);
        const folderDir = path.join(projectDir, safeFolderName);
        if (!fs.existsSync(folderDir)) {
          fs.mkdirSync(folderDir, { recursive: true });
        }

        // フォルダ内の帳票をダウンロード
        const folderFiles = await this.downloadFormsFromCurrentView(folderDir);
        if (folderFiles.length > 0) {
          folders.push({ name: safeFolderName, files: folderFiles });
        }

        // TOPに戻る
        const topLink = await this.page.$('a:has-text("TOP"), [class*="breadcrumb"] a:first-child');
        if (topLink) {
          await topLink.click();
        } else {
          await this.clickTab('帳票');
        }
        await sleep(1000);

      } catch (e) {
        console.log(`      フォルダ処理エラー: ${e}`);
        try {
          await this.clickTab('帳票');
          await sleep(500);
        } catch {}
      }
    }

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  帳票: ${folders.length} フォルダ, ${totalFiles} ファイル`);
    return folders;
  }

  // 現在のビューから帳票ファイルをダウンロード
  private async downloadFormsFromCurrentView(dir: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];
    const formRows = await this.page.$$('table tbody tr');

    for (let i = 0; i < formRows.length; i++) {
      try {
        const currentRows = await this.page.$$('table tbody tr');
        if (i >= currentRows.length) break;

        const row = currentRows[i];

        // ファイル行かどうか確認（入力率%があるのがファイル）
        const rowInfo = await row.evaluate((el) => {
          const cells = el.querySelectorAll('td');
          const hasInputRate = Array.from(cells).some(cell => cell.textContent?.includes('%'));
          const nameCell = el.querySelector('td:first-child a, td:first-child');
          const name = nameCell?.textContent?.trim() || '';
          return { isFile: hasInputRate, name };
        });

        if (!rowInfo.isFile) continue;

        console.log(`      [${i + 1}] ${rowInfo.name}`);

        // 「...」メニューをクリック
        const menuBtn = await row.$('td:last-child button, td:last-child [class*="menu"], td:last-child');

        if (menuBtn) {
          await menuBtn.click();
          await sleep(500);

          const downloadMenuItem = await this.page.$('[role="menuitem"]:has-text("Excelをダウンロード"), [role="menu"] :has-text("Excelをダウンロード"), [class*="menu"] :has-text("Excelをダウンロード"), button:has-text("Excelをダウンロード")');

          if (downloadMenuItem) {
            try {
              const [download] = await Promise.all([
                this.page.waitForEvent('download', { timeout: 30000 }),
                downloadMenuItem.click(),
              ]);

              const suggestedName = download.suggestedFilename();
              const safeFilename = this.sanitizeFilename(suggestedName || `${rowInfo.name}.xlsx`);
              const filepath = path.join(dir, safeFilename);
              await download.saveAs(filepath);
              downloadedFiles.push(safeFilename);
              console.log(`        ダウンロード完了: ${safeFilename}`);
            } catch {
              console.log(`        ダウンロード失敗`);
              await this.page.keyboard.press('Escape');
            }
          } else {
            await this.page.keyboard.press('Escape');
          }
        }

        await sleep(300);

      } catch (e) {
        console.log(`      エラー: ${e}`);
        await this.page.keyboard.press('Escape');
        await sleep(200);
      }
    }

    return downloadedFiles;
  }

  // 写真台帳タブからデータをダウンロード（KANNA専用）
  // 各行のPDFボタンをクリックしてダウンロード
  async downloadPhotoLedger(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'photo_ledger');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  写真台帳タブを開く...');

    // 写真台帳タブをクリック
    const tabClicked = await this.clickTab('写真台帳');
    if (!tabClicked) {
      return [];
    }

    await sleep(500);

    const downloadedFiles: string[] = [];

    // 写真台帳一覧の行を取得
    const ledgerRows = await this.page.$$('table tbody tr');

    if (ledgerRows.length === 0) {
      console.log('  写真台帳が見つかりません');
      return [];
    }

    console.log(`  ${ledgerRows.length} 件の写真台帳を検出`);

    for (let i = 0; i < ledgerRows.length; i++) {
      try {
        const currentRows = await this.page.$$('table tbody tr');
        if (i >= currentRows.length) break;

        const row = currentRows[i];

        // 写真台帳名を取得
        const ledgerName = await row.evaluate((el) => {
          const nameCell = el.querySelector('td:first-child a, td:first-child');
          return nameCell?.textContent?.trim() || '';
        });

        console.log(`    [${i + 1}/${ledgerRows.length}] ${ledgerName}`);

        // PDFボタンをクリック
        const pdfBtn = await row.$('button:has-text("PDF"), a:has-text("PDF"), [class*="pdf"]');

        if (pdfBtn) {
          try {
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 30000 }),
              pdfBtn.click(),
            ]);

            const suggestedName = download.suggestedFilename();
            const safeFilename = this.sanitizeFilename(suggestedName || `${ledgerName}.pdf`);
            const filepath = path.join(projectDir, safeFilename);
            await download.saveAs(filepath);
            downloadedFiles.push(safeFilename);
            console.log(`      ダウンロード完了: ${safeFilename}`);
          } catch {
            console.log(`      ダウンロード失敗（タイムアウト）`);
          }
        } else {
          console.log(`      PDFボタンが見つかりません`);
        }

        await sleep(300);

      } catch (e) {
        console.log(`    エラー: ${e}`);
      }
    }

    const folders: FolderItem[] = [];
    if (downloadedFiles.length > 0) {
      folders.push({ name: 'photo_ledger', files: downloadedFiles });
    }

    console.log(`  写真台帳: ${downloadedFiles.length} ファイル`);
    return folders;
  }

  // 担当タブからデータを取得
  async getStaff(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  担当タブを開く...');
    const staffList: any[] = [];

    // 担当タブをクリック
    const tabClicked = await this.clickTab('担当');
    if (!tabClicked) {
      return [];
    }

    await sleep(500);

    // 担当者データを抽出（カード形式：名前、会社|役割、電話番号）
    const staffData = await this.page.evaluate(() => {
      const items: any[] = [];

      // カード形式の担当者一覧を探す
      // 各カードは複数のテキスト行を持つ（名前、会社|役割、電話番号）

      // 電話番号のパターン
      const phonePattern = /^[0-9\-（）()]+$/;
      // 会社|役割のパターン
      const companyRolePattern = /[｜|]/;

      // まず、カード/リストアイテムを探す
      const cardSelectors = [
        '[class*="card"]',
        '[class*="member"]',
        '[class*="staff"]',
        '[class*="user-item"]',
        '[class*="list-item"]',
        'li[class*="item"]',
        // divベースのカード
        'div[class*="item"]',
      ];

      let cards: Element[] = [];
      for (const selector of cardSelectors) {
        const found = document.querySelectorAll(selector);
        if (found.length > 0) {
          cards = Array.from(found);
          break;
        }
      }

      // カードが見つからない場合、担当一覧の子要素を探す
      if (cards.length === 0) {
        const container = document.querySelector('[class*="list"], [class*="members"], [class*="staff"]');
        if (container) {
          cards = Array.from(container.children);
        }
      }

      // 各カードからデータを抽出
      cards.forEach(card => {
        const staff: { [key: string]: string } = {};

        // カード内の全テキストノードを取得
        const textNodes: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent?.trim();
            if (text && text.length > 0) {
              textNodes.push(text);
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            // 不要な要素はスキップ（アイコン、ボタンなど）
            const el = node as Element;
            const tagName = el.tagName.toLowerCase();
            if (tagName === 'svg' || tagName === 'img' || tagName === 'button') {
              return;
            }
            node.childNodes.forEach(child => walk(child));
          }
        };
        walk(card);

        // 重複を除去してユニークなテキストを取得
        const uniqueTexts = [...new Set(textNodes)].filter(t => t.length > 0);

        // テキストを分類
        uniqueTexts.forEach(text => {
          if (phonePattern.test(text.replace(/\s/g, ''))) {
            // 電話番号
            staff['電話番号'] = text;
          } else if (companyRolePattern.test(text)) {
            // 会社|役割 形式
            const parts = text.split(/[｜|]/);
            if (parts.length >= 2) {
              staff['会社'] = parts[0].trim();
              staff['役割'] = parts[1].trim();
            } else {
              staff['会社・役割'] = text;
            }
          } else if (!staff['名前'] && text.length > 0 && text.length < 30) {
            // 最初の短いテキストを名前として扱う
            staff['名前'] = text;
          }
        });

        // 有効なデータがあれば追加（少なくとも名前があること）
        if (staff['名前'] && !items.find(i => i['名前'] === staff['名前'])) {
          items.push(staff);
        }
      });

      // カード形式で取得できなかった場合、ページ全体からパターンを探す
      if (items.length === 0) {
        // 全ての表示テキストを収集
        const allText = document.body.innerText;
        const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        let currentStaff: { [key: string]: string } = {};
        lines.forEach(line => {
          if (phonePattern.test(line.replace(/\s/g, ''))) {
            currentStaff['電話番号'] = line;
            // 電話番号が見つかったら1件の担当者として確定
            if (currentStaff['名前']) {
              items.push({ ...currentStaff });
              currentStaff = {};
            }
          } else if (companyRolePattern.test(line)) {
            const parts = line.split(/[｜|]/);
            if (parts.length >= 2) {
              currentStaff['会社'] = parts[0].trim();
              currentStaff['役割'] = parts[1].trim();
            }
          } else if (line.length > 1 && line.length < 20 && !line.includes('担当') && !line.includes('一覧')) {
            // 名前候補
            if (!currentStaff['名前']) {
              currentStaff['名前'] = line;
            }
          }
        });

        // 最後の担当者を追加
        if (currentStaff['名前']) {
          items.push(currentStaff);
        }
      }

      return items;
    });

    staffList.push(...staffData);
    console.log(`  担当: ${staffList.length} 件`);
    return staffList;
  }

  // ファイル名をサニタイズ
  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
  }

  // URLから拡張子を取得
  private getExtension(url: string, defaultExt: string): string {
    const match = url.match(/\.([a-zA-Z0-9]+)(\?|$)/);
    return match ? `.${match[1]}` : defaultExt;
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

    // 1. 左メニューの「案件一覧」をクリック
    await scraper.navigateToProjectList();

    // 2. 案件一覧から全案件を取得
    const projects = await scraper.getProjects();
    console.log(`\n=== ${projects.length} 件の案件を処理します ===`);

    // 3. 各案件を順番に処理
    let skippedCount = 0;
    let processedCount = 0;

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      // フォルダ名にIDを含めて同名案件も区別（例: 案件名_12345）
      const folderName = `${scraper['sanitizeFilename'](project.name)}_${project.id}`;
      const projectDir = path.join(DOWNLOAD_DIR, folderName);
      const projectDataFile = path.join(projectDir, 'project_data.json');

      console.log(`\n========================================`);
      console.log(`案件 ${i + 1}/${projects.length}: [${project.id}] ${project.name}`);
      console.log(`========================================`);

      // ダウンロード済みチェック: project_data.json が存在すればスキップ
      if (fs.existsSync(projectDataFile)) {
        console.log(`  → 既にダウンロード済み。スキップします。`);
        skippedCount++;
        continue;
      }

      // 案件詳細ページに直接遷移（URL使用、スクロール不要）
      await scraper.goToProject(project);

      // タブ順序に従って処理: 概要→工程表→タスク→報告→写真→資料→帳票→写真台帳→担当

      // 1. 概要タブ - CSVダウンロード
      const overviewCSV = await scraper.downloadOverviewCSV(project.name);

      // 2. 工程表タブ - スキップ（メール送信方式のため自動取得不可）
      // const schedule = await scraper.downloadSchedule(project.name);
      const schedule: string[] = [];

      // 3. タスクタブはスキップ（必要に応じて追加可能）

      // 4. 報告タブからデータを取得
      const reports = await scraper.getReports(project.name);

      // 5. 写真タブをクリックして写真をダウンロード
      const photos = await scraper.downloadPhotos(project.name);

      // 6. 資料タブをクリックして資料をダウンロード
      const documents = await scraper.downloadDocuments(project.name);

      // 7. 帳票タブからファイルをダウンロード
      const forms = await scraper.downloadForms(project.name);

      // 8. 写真台帳タブからファイルをダウンロード
      const photoLedger = await scraper.downloadPhotoLedger(project.name);

      // 9. 担当タブからデータを取得
      const staff = await scraper.getStaff(project.name);

      // 結果をJSONで保存
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const result = {
        project: { id: project.id, name: project.name, url: project.url },
        overviewCSV,
        schedule,
        reports,
        photos,
        documents,
        forms,
        photoLedger,
        staff,
        exportedAt: new Date().toISOString(),
      };

      fs.writeFileSync(
        projectDataFile,
        JSON.stringify(result, null, 2),
        'utf-8'
      );
      console.log(`  データをproject_data.jsonに保存しました`);
      processedCount++;

      // 次の案件はURL直接アクセスなので、案件一覧に戻る必要なし
    }

    console.log(`\n=== 処理完了 ===`);
    console.log(`  処理した案件: ${processedCount} 件`);
    console.log(`  スキップした案件: ${skippedCount} 件`);
    console.log(`  合計: ${projects.length} 件`);

    console.log('\n=== 全ての処理が完了しました ===');
  } catch (error) {
    console.error('エラーが発生しました:', error);
    throw error;
  } finally {
    await scraper.close();
  }
}

main();
