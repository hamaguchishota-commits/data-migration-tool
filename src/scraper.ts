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
    await sleep(2000);

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

    console.log('案件一覧ページに遷移しました');
  }

  // 案件一覧から全案件の情報を取得
  async getProjects(): Promise<Project[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projects: Project[] = [];
    let hasNextPage = true;
    let pageNum = 1;
    const MAX_PAGES = 100; // 安全のため最大ページ数を制限
    let previousProjectCount = 0;
    let sameCountStreak = 0; // 同じ件数が続いた回数

    while (hasNextPage && pageNum <= MAX_PAGES) {
      console.log(`ページ ${pageNum} を取得中...`);

      // テーブルが表示されるまで待機
      await sleep(1000);

      const beforeCount = projects.length;

      // テーブルの各行から案件を取得
      const rows = await this.page.$$('table tbody tr, [class*="table"] [class*="row"], [class*="list"] [class*="item"]');

      if (rows.length > 0) {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const nameEl = await row.$('a, [class*="name"], [class*="title"], td:first-child');
          if (nameEl) {
            const name = await nameEl.textContent();
            const href = await nameEl.getAttribute('href');

            if (name && name.trim()) {
              let id = `${pageNum}-${i}`;
              if (href) {
                const idMatch = href.match(/\/(\d+)/) || href.match(/id=(\d+)/);
                if (idMatch) {
                  id = idMatch[1];
                }
              }

              if (!projects.find(p => p.name === name.trim())) {
                projects.push({
                  id,
                  name: name.trim(),
                  url: href ? `https://kanna4u.com${href}` : '',
                });
              }
            }
          }
        }
      } else {
        // テーブルがない場合、案件リンクを直接取得
        const links = await this.page.$$('a[href*="project"], a[href*="cms"]');
        for (const link of links) {
          const name = await link.textContent();
          const href = await link.getAttribute('href');
          if (name && name.trim() && !projects.find(p => p.name === name.trim())) {
            projects.push({
              id: `link-${projects.length}`,
              name: name.trim(),
              url: href ? `https://kanna4u.com${href}` : '',
            });
          }
        }
      }

      const afterCount = projects.length;
      const newProjectsFound = afterCount - beforeCount;
      console.log(`  → ${newProjectsFound} 件の新規案件を発見 (合計: ${afterCount} 件)`);

      // 新規案件が見つからなかった場合のチェック
      if (afterCount === previousProjectCount) {
        sameCountStreak++;
        console.log(`  → 新規案件なし (${sameCountStreak}回連続)`);
        if (sameCountStreak >= 3) {
          console.log('  → 3回連続で新規案件なし、ページネーション終了');
          hasNextPage = false;
          break;
        }
      } else {
        sameCountStreak = 0;
      }
      previousProjectCount = afterCount;

      // 次のページがあるかチェック
      const nextButton = await this.page.$('button:has-text("次へ"), a:has-text("次へ"), button:has-text("次のページ"), a:has-text("次のページ"), [aria-label="Next page"], .pagination-next:not([disabled])');
      if (nextButton) {
        const isDisabled = await nextButton.getAttribute('disabled');
        const ariaDisabled = await nextButton.getAttribute('aria-disabled');
        const isVisible = await nextButton.isVisible();

        console.log(`  → 次へボタン: visible=${isVisible}, disabled=${isDisabled}, aria-disabled=${ariaDisabled}`);

        if (isVisible && !isDisabled && ariaDisabled !== 'true') {
          const currentUrl = this.page.url();
          await nextButton.click();
          await sleep(1500); // SPA: 固定待機

          // URLが変わったかチェック
          const newUrl = this.page.url();
          if (currentUrl === newUrl) {
            console.log('  → URLが変わらず、ページネーション終了の可能性');
          }

          pageNum++;
        } else {
          console.log('  → 次へボタンが無効、ページネーション終了');
          hasNextPage = false;
        }
      } else {
        console.log('  → 次へボタンが見つからず、ページネーション終了');
        hasNextPage = false;
      }
    }

    if (pageNum > MAX_PAGES) {
      console.log(`警告: 最大ページ数 (${MAX_PAGES}) に達しました`);
    }

    console.log(`${projects.length} 件の案件を取得しました`);
    return projects;
  }

  // 案件一覧ページに戻る
  async backToProjectList(): Promise<void> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    // サイドバーから案件一覧をクリック
    await this.navigateToProjectList();
  }

  // 案件をクリックして詳細ページに遷移
  async clickProject(project: Project): Promise<void> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`\n案件をクリック: ${project.name}`);

    // Locator APIで案件名を探す
    const projectLink = this.page.locator(`a:has-text("${project.name}")`).first()
      .or(this.page.locator(`text="${project.name}"`).first());

    try {
      await projectLink.waitFor({ state: 'visible', timeout: 5000 });
      await projectLink.click();

      // 詳細ページへの遷移を待機（URLの変化またはタブの出現）
      await sleep(2000);

      console.log('案件詳細ページに遷移しました');
    } catch {
      if (project.url) {
        console.log('  リンクが見つからないためURLに直接遷移');
        await this.page.goto(project.url);
        await sleep(2000);
      }
    }
  }

  // 概要タブの全項目を自動検出して取得
  async getProjectDetails(): Promise<ProjectDetail> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  概要タブを開く...');

    // 概要タブを探してクリック
    const overviewTab = this.page.locator('button:has-text("概要"), a:has-text("概要"), [role="tab"]:has-text("概要")').first();

    try {
      const isVisible = await overviewTab.isVisible();
      if (isVisible) {
        await overviewTab.click();
        await sleep(1500);
      }
    } catch {
      // 概要タブがない場合はスキップ
    }

    // デバッグ用スクリーンショット
    await this.saveScreenshot('project_detail_page');

    const details: ProjectDetail = {};

    // KANNA専用: ページ内の全てのラベル・値ペアを抽出
    const extractedData = await this.page.evaluate(() => {
      const result: { [key: string]: string } = {};

      // 既知のKANNAラベル名リスト
      const knownLabels = [
        '案件名', '開始日', '終了日', '案件テンプレート', '案件フロー', '備考', '親案件',
        '物件名', '住所',
        '駐車スペース', '工事可能期間', '土日の工事', '喫煙ルール', 'その他',
        '区分', '氏名', '氏名(フリガナ)', '会社名または屋号名', '会社名または屋号名(フリガナ)',
        '担当者名', '電話番号1', '電話番号2', 'FAX', 'メールアドレス'
      ];

      // 方法1: テーブル構造（tr > td）を探す
      const rows = document.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const label = cells[0].textContent?.trim() || '';
          const value = cells[1].textContent?.trim() || '';
          if (label && !result[label]) {
            result[label] = value;
          }
        }
      });

      // 方法2: div行構造を探す（ラベルと値が横並び）
      const allElements = document.querySelectorAll('div, span, p');
      allElements.forEach(el => {
        const text = el.textContent?.trim() || '';
        // 既知のラベルに一致するか確認
        for (const knownLabel of knownLabels) {
          if (text === knownLabel || text === knownLabel + ':' || text === knownLabel + '：') {
            // 次の兄弟要素から値を取得
            let nextEl = el.nextElementSibling;
            if (nextEl) {
              const value = nextEl.textContent?.trim() || '';
              if (value && value !== '-' && !result[knownLabel]) {
                result[knownLabel] = value;
              }
            }
            // 親要素の次の子要素も確認
            const parent = el.parentElement;
            if (parent) {
              const children = Array.from(parent.children);
              const idx = children.indexOf(el);
              if (idx >= 0 && idx < children.length - 1) {
                const valueEl = children[idx + 1];
                const value = valueEl.textContent?.trim() || '';
                if (value && value !== '-' && !result[knownLabel]) {
                  result[knownLabel] = value;
                }
              }
            }
          }
        }
      });

      // 方法3: 特定のclass名パターンで探す
      const labelValuePairs = document.querySelectorAll('[class*="row"], [class*="item"], [class*="field"]');
      labelValuePairs.forEach(pair => {
        const children = pair.children;
        if (children.length >= 2) {
          const labelEl = children[0];
          const valueEl = children[1];
          const label = labelEl.textContent?.trim().replace(/[:：]$/, '') || '';
          const value = valueEl.textContent?.trim() || '';
          if (label && value && !result[label] && knownLabels.includes(label)) {
            result[label] = value;
          }
        }
      });

      return result;
    });

    // 抽出したデータをdetailsにマージ
    for (const [key, value] of Object.entries(extractedData)) {
      if (key && value && value !== '-') {
        details[key] = value;
      }
    }

    // フォールバック: 従来の方法も試す
    if (Object.keys(details).length < 3) {
      console.log('  → フォールバック: 従来の抽出方法を試行...');

      // dl/dt/dd パターン
      const dlElements: ElementHandle[] = await this.page!.$$('dl');
      for (const dl of dlElements) {
        const dts: ElementHandle[] = await dl.$$('dt');
        const dds: ElementHandle[] = await dl.$$('dd');
        for (let i = 0; i < dts.length; i++) {
          const labelText = await dts[i].textContent();
          const valueText = dds[i] ? await dds[i].textContent() : '';
          if (labelText && labelText.trim()) {
            const key = labelText.trim().replace(/[:：]$/, '');
            if (!details[key]) {
              details[key] = valueText?.trim() || '';
            }
          }
        }
      }

      // table/th/td パターン
      const tables: ElementHandle[] = await this.page!.$$('table');
      for (const table of tables) {
        const tableRows: ElementHandle[] = await table.$$('tr');
        for (const row of tableRows) {
          const th = await row.$('th');
          const td = await row.$('td');
          if (th && td) {
            const labelText = await th.textContent();
            const valueText = await td.textContent();
            if (labelText && labelText.trim()) {
              const key = labelText.trim().replace(/[:：]$/, '');
              if (!details[key]) {
                details[key] = valueText?.trim() || '';
              }
            }
          }
        }
      }
    }

    console.log(`  概要: ${Object.keys(details).length} 項目を取得`);

    // 取得した項目をログに出力
    for (const [key, value] of Object.entries(details)) {
      console.log(`    ${key}: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
    }

    return details;
  }

  // 写真タブからフォルダ一覧と写真をダウンロード
  async downloadPhotos(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'photos');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  写真タブを開く...`);

    // 写真タブを探す
    const photoTab = this.page.locator('button:has-text("写真"), a:has-text("写真"), [role="tab"]:has-text("写真")').first();

    try {
      const isVisible = await photoTab.isVisible();
      if (!isVisible) {
        console.log('  写真タブが見つかりません');
        return [];
      }

      await photoTab.click();
      await sleep(1500);
    } catch {
      console.log('  写真タブが見つかりません');
      return [];
    }

    const folders: FolderItem[] = [];

    // フォルダ一覧を取得
    const folderElements = await this.page.$$('.folder, .folder-item, [data-testid="folder"], a[href*="folder"], .directory');

    if (folderElements.length === 0) {
      console.log('  フォルダなし、直接写真を取得...');
      const files = await this.downloadImagesFromCurrentView(projectDir, 'root');
      if (files.length > 0) {
        folders.push({ name: 'root', files });
      }
    } else {
      console.log(`  ${folderElements.length} 個のフォルダを検出`);

      for (const folderEl of folderElements) {
        const folderName = await folderEl.textContent() || 'unnamed';
        const safeFolderName = this.sanitizeFilename(folderName.trim());
        const folderDir = path.join(projectDir, safeFolderName);

        if (!fs.existsSync(folderDir)) {
          fs.mkdirSync(folderDir, { recursive: true });
        }

        console.log(`    フォルダ: ${safeFolderName}`);

        await folderEl.click();
        await sleep(1000);

        const files = await this.downloadImagesFromCurrentView(folderDir, safeFolderName);
        folders.push({ name: safeFolderName, files });

        // 戻る
        const backButton = await this.page.$('button:has-text("戻る"), a:has-text("戻る"), .back-button');
        if (backButton) {
          await backButton.click();
          await sleep(500);
        } else {
          await photoTab.click();
          await sleep(500);
        }
      }
    }

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  写真: ${folders.length} フォルダ, ${totalFiles} ファイル`);
    return folders;
  }

  // 資料タブからフォルダ一覧とファイルをダウンロード
  async downloadDocuments(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'documents');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  資料タブを開く...`);

    // 資料タブを探す
    const docTab = this.page.locator('button:has-text("資料"), a:has-text("資料"), [role="tab"]:has-text("資料")').first();

    try {
      const isVisible = await docTab.isVisible();
      if (!isVisible) {
        console.log('  資料タブが見つかりません');
        return [];
      }

      await docTab.click();
      await sleep(1500);
    } catch {
      console.log('  資料タブが見つかりません');
      return [];
    }

    const folders: FolderItem[] = [];

    // フォルダ一覧を取得
    const folderElements = await this.page.$$('.folder, .folder-item, [data-testid="folder"], a[href*="folder"], .directory');

    if (folderElements.length === 0) {
      console.log('  フォルダなし、直接ファイルを取得...');
      const files = await this.downloadFilesFromCurrentView(projectDir, 'root');
      if (files.length > 0) {
        folders.push({ name: 'root', files });
      }
    } else {
      console.log(`  ${folderElements.length} 個のフォルダを検出`);

      for (const folderEl of folderElements) {
        const folderName = await folderEl.textContent() || 'unnamed';
        const safeFolderName = this.sanitizeFilename(folderName.trim());
        const folderDir = path.join(projectDir, safeFolderName);

        if (!fs.existsSync(folderDir)) {
          fs.mkdirSync(folderDir, { recursive: true });
        }

        console.log(`    フォルダ: ${safeFolderName}`);

        await folderEl.click();
        await sleep(1000);

        const files = await this.downloadFilesFromCurrentView(folderDir, safeFolderName);
        folders.push({ name: safeFolderName, files });

        // 戻る
        const backButton = await this.page.$('button:has-text("戻る"), a:has-text("戻る"), .back-button');
        if (backButton) {
          await backButton.click();
          await sleep(500);
        } else {
          await docTab.click();
          await sleep(500);
        }
      }
    }

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

  // 報告タブからデータを取得
  async getReports(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  報告タブを開く...');
    const reports: any[] = [];

    // 報告タブを探す
    const reportTab = this.page.locator('button:has-text("報告"), a:has-text("報告"), [role="tab"]:has-text("報告")').first();

    try {
      const isVisible = await reportTab.isVisible();
      if (!isVisible) {
        console.log('  報告タブが見つかりません');
        return [];
      }

      await reportTab.click();
      await sleep(1500);
    } catch {
      console.log('  報告タブが見つかりません');
      return [];
    }

    // 報告リストの行を取得
    const reportRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="report"] [class*="row"], [class*="row"]:has([class*="report"])');

    if (reportRows.length > 0) {
      console.log(`    ${reportRows.length} 件の報告を検出`);

      for (let i = 0; i < reportRows.length; i++) {
        try {
          const currentRows = await this.page.$$('table tbody tr, [class*="list"] [class*="item"], [class*="report"] [class*="row"], [class*="row"]:has([class*="report"])');
          if (i >= currentRows.length) break;

          const row = currentRows[i];
          const rowText = await row.textContent();
          console.log(`      [${i + 1}/${reportRows.length}] ${rowText?.trim().substring(0, 40)}...`);

          // 行をクリックして詳細を開く
          await row.click();
          await sleep(1500);

          // 詳細データを取得
          const reportDetail = await this.page.evaluate(() => {
            const detail: { [key: string]: string } = {};

            // モーダルまたは詳細ビューからデータを抽出
            const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="detail"], [class*="drawer"]');
            const container = modal || document;

            // テキストコンテンツを取得
            const title = container.querySelector('h1, h2, h3, [class*="title"]');
            if (title) detail['タイトル'] = title.textContent?.trim() || '';

            const date = container.querySelector('[class*="date"], time');
            if (date) detail['日時'] = date.textContent?.trim() || '';

            const content = container.querySelector('[class*="content"], [class*="body"], [class*="description"], p');
            if (content) detail['内容'] = content.textContent?.trim() || '';

            const author = container.querySelector('[class*="author"], [class*="user"], [class*="name"]');
            if (author) detail['作成者'] = author.textContent?.trim() || '';

            // ラベル・値ペアを探す
            const rows = container.querySelectorAll('[class*="row"], [class*="field"], tr');
            rows.forEach(row => {
              const children = row.children;
              if (children.length >= 2) {
                const label = children[0].textContent?.trim().replace(/[:：]$/, '') || '';
                const value = children[1].textContent?.trim() || '';
                if (label && value && !detail[label]) {
                  detail[label] = value;
                }
              }
            });

            return detail;
          });

          reports.push({ index: i + 1, ...reportDetail });

          // 閉じる
          const closeBtn = await this.page.$('button:has-text("閉じる"), button[aria-label="Close"], [class*="close"], button:has-text("×")');
          if (closeBtn) {
            await closeBtn.click();
          } else {
            await this.page.keyboard.press('Escape');
          }
          await sleep(500);

        } catch (e) {
          console.log(`      エラー: ${e}`);
        }
      }
    } else {
      // リストがない場合、ページ全体からテキストを取得
      const pageContent = await this.page.evaluate(() => {
        const container = document.querySelector('[class*="tab-content"], [class*="panel"], main, [role="tabpanel"]');
        return container?.textContent?.trim() || '';
      });
      if (pageContent) {
        reports.push({ content: pageContent });
      }
    }

    console.log(`  報告: ${reports.length} 件`);
    return reports;
  }

  // 工程表タブからデータを取得
  async getSchedule(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  工程表タブを開く...');
    const scheduleItems: any[] = [];

    // 工程表タブを探す
    const scheduleTab = this.page.locator('button:has-text("工程表"), a:has-text("工程表"), [role="tab"]:has-text("工程表")').first();

    try {
      const isVisible = await scheduleTab.isVisible();
      if (!isVisible) {
        console.log('  工程表タブが見つかりません');
        return [];
      }

      await scheduleTab.click();
      await sleep(1500);
    } catch {
      console.log('  工程表タブが見つかりません');
      return [];
    }

    // 工程表データを抽出
    const scheduleData = await this.page.evaluate(() => {
      const items: any[] = [];

      // テーブル形式
      const tables = document.querySelectorAll('table');
      tables.forEach(table => {
        const headers: string[] = [];
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
        headerCells.forEach(cell => {
          headers.push(cell.textContent?.trim() || '');
        });

        const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
        rows.forEach(row => {
          const item: { [key: string]: string } = {};
          const cells = row.querySelectorAll('td, th');
          cells.forEach((cell, idx) => {
            const key = headers[idx] || `column_${idx}`;
            item[key] = cell.textContent?.trim() || '';
          });
          if (Object.keys(item).length > 0 && Object.values(item).some(v => v)) {
            items.push(item);
          }
        });
      });

      // ガントチャートやタイムライン形式
      const ganttItems = document.querySelectorAll('[class*="gantt"] [class*="item"], [class*="timeline"] [class*="item"], [class*="schedule"] [class*="item"], [class*="task"]');
      ganttItems.forEach(item => {
        const name = item.querySelector('[class*="name"], [class*="title"]')?.textContent?.trim();
        const start = item.querySelector('[class*="start"]')?.textContent?.trim();
        const end = item.querySelector('[class*="end"]')?.textContent?.trim();
        const status = item.querySelector('[class*="status"]')?.textContent?.trim();

        if (name) {
          items.push({ name, start, end, status });
        }
      });

      // リスト形式
      const listItems = document.querySelectorAll('[class*="list"] [class*="item"], [class*="row"]:has([class*="schedule"])');
      listItems.forEach(item => {
        const text = item.textContent?.trim();
        if (text && !items.find(i => JSON.stringify(i).includes(text.substring(0, 20)))) {
          items.push({ content: text });
        }
      });

      return items;
    });

    scheduleItems.push(...scheduleData);
    console.log(`  工程表: ${scheduleItems.length} 件`);
    return scheduleItems;
  }

  // タスクタブからデータを取得
  async getTasks(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  タスクタブを開く...');
    const tasks: any[] = [];

    // タスクタブを探す
    const taskTab = this.page.locator('button:has-text("タスク"), a:has-text("タスク"), [role="tab"]:has-text("タスク")').first();

    try {
      const isVisible = await taskTab.isVisible();
      if (!isVisible) {
        console.log('  タスクタブが見つかりません');
        return [];
      }

      await taskTab.click();
      await sleep(1500);
    } catch {
      console.log('  タスクタブが見つかりません');
      return [];
    }

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

  // 帳票タブからデータをダウンロード
  async downloadForms(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'forms');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  帳票タブを開く...');

    // 帳票タブを探す
    const formsTab = this.page.locator('button:has-text("帳票"), a:has-text("帳票"), [role="tab"]:has-text("帳票")').first();

    try {
      const isVisible = await formsTab.isVisible();
      if (!isVisible) {
        console.log('  帳票タブが見つかりません');
        return [];
      }

      await formsTab.click();
      await sleep(1500);
    } catch {
      console.log('  帳票タブが見つかりません');
      return [];
    }

    const folders: FolderItem[] = [];
    const files = await this.downloadFilesFromCurrentView(projectDir, 'forms');

    if (files.length > 0) {
      folders.push({ name: 'forms', files });
    }

    console.log(`  帳票: ${files.length} ファイル`);
    return folders;
  }

  // 写真台帳タブからデータをダウンロード
  async downloadPhotoLedger(projectName: string): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'photo_ledger');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  写真台帳タブを開く...');

    // 写真台帳タブを探す
    const ledgerTab = this.page.locator('button:has-text("写真台帳"), a:has-text("写真台帳"), [role="tab"]:has-text("写真台帳")').first();

    try {
      const isVisible = await ledgerTab.isVisible();
      if (!isVisible) {
        console.log('  写真台帳タブが見つかりません');
        return [];
      }

      await ledgerTab.click();
      await sleep(1500);
    } catch {
      console.log('  写真台帳タブが見つかりません');
      return [];
    }

    const folders: FolderItem[] = [];

    // ダウンロードボタンがあるか確認（一括ダウンロード）
    const bulkDownloadBtn = await this.page.$('button:has-text("一括ダウンロード"), button:has-text("全てダウンロード"), a:has-text("ダウンロード"), button:has-text("PDF"), button:has-text("出力")');

    if (bulkDownloadBtn) {
      try {
        console.log('    一括ダウンロードボタンを検出');
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          bulkDownloadBtn.click(),
        ]);

        const suggestedName = download.suggestedFilename();
        const safeFilename = this.sanitizeFilename(suggestedName || 'photo_ledger.pdf');
        const filepath = path.join(projectDir, safeFilename);
        await download.saveAs(filepath);
        folders.push({ name: 'photo_ledger', files: [safeFilename] });
        console.log(`    ダウンロード完了: ${safeFilename}`);
      } catch {
        console.log('    一括ダウンロード失敗');
      }
    } else {
      // リスト形式の場合
      const files = await this.downloadFilesFromCurrentView(projectDir, 'photo_ledger');
      if (files.length > 0) {
        folders.push({ name: 'photo_ledger', files });
      }
    }

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  写真台帳: ${totalFiles} ファイル`);
    return folders;
  }

  // 担当タブからデータを取得
  async getStaff(projectName: string): Promise<any[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log('  担当タブを開く...');
    const staffList: any[] = [];

    // 担当タブを探す
    const staffTab = this.page.locator('button:has-text("担当"), a:has-text("担当"), [role="tab"]:has-text("担当")').first();

    try {
      const isVisible = await staffTab.isVisible();
      if (!isVisible) {
        console.log('  担当タブが見つかりません');
        return [];
      }

      await staffTab.click();
      await sleep(1500);
    } catch {
      console.log('  担当タブが見つかりません');
      return [];
    }

    // 担当者データを抽出
    const staffData = await this.page.evaluate(() => {
      const items: any[] = [];

      // テーブル形式
      const tables = document.querySelectorAll('table');
      tables.forEach(table => {
        const headers: string[] = [];
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td');
        headerCells.forEach(cell => {
          headers.push(cell.textContent?.trim() || '');
        });

        const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
        rows.forEach(row => {
          const item: { [key: string]: string } = {};
          const cells = row.querySelectorAll('td, th');
          cells.forEach((cell, idx) => {
            const key = headers[idx] || `column_${idx}`;
            item[key] = cell.textContent?.trim() || '';
          });
          if (Object.keys(item).length > 0 && Object.values(item).some(v => v)) {
            items.push(item);
          }
        });
      });

      // リスト/カード形式
      const listItems = document.querySelectorAll('[class*="list"] [class*="item"], [class*="user"], [class*="member"], [class*="staff"], [class*="card"]');
      listItems.forEach(item => {
        const staff: { [key: string]: string } = {};

        const name = item.querySelector('[class*="name"]')?.textContent?.trim();
        if (name) staff['名前'] = name;

        const role = item.querySelector('[class*="role"], [class*="position"]')?.textContent?.trim();
        if (role) staff['役割'] = role;

        const email = item.querySelector('[class*="email"], a[href^="mailto:"]')?.textContent?.trim();
        if (email) staff['メール'] = email;

        const phone = item.querySelector('[class*="phone"], [class*="tel"]')?.textContent?.trim();
        if (phone) staff['電話'] = phone;

        const company = item.querySelector('[class*="company"], [class*="organization"]')?.textContent?.trim();
        if (company) staff['会社'] = company;

        // フォールバック: テキスト全体
        if (Object.keys(staff).length === 0) {
          const text = item.textContent?.trim();
          if (text) staff['内容'] = text;
        }

        if (Object.keys(staff).length > 0 && !items.find(i => JSON.stringify(i) === JSON.stringify(staff))) {
          items.push(staff);
        }
      });

      // ラベル・値ペア形式
      const fields = document.querySelectorAll('[class*="field"], [class*="row"]:has([class*="label"])');
      const singleStaff: { [key: string]: string } = {};
      fields.forEach(field => {
        const label = field.querySelector('[class*="label"]')?.textContent?.trim().replace(/[:：]$/, '');
        const value = field.querySelector('[class*="value"]')?.textContent?.trim() || field.lastElementChild?.textContent?.trim();
        if (label && value && label !== value) {
          singleStaff[label] = value;
        }
      });
      if (Object.keys(singleStaff).length > 0) {
        items.push(singleStaff);
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
      const projectDir = path.join(DOWNLOAD_DIR, scraper['sanitizeFilename'](project.name));
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

      // 案件をクリックして詳細ページへ遷移
      await scraper.clickProject(project);

      // 概要タブの項目を取得
      const details = await scraper.getProjectDetails();
      console.log('  概要データ:');
      for (const [key, value] of Object.entries(details)) {
        console.log(`    ${key}: ${value}`);
      }

      // 報告タブからデータを取得
      const reports = await scraper.getReports(project.name);

      // 工程表タブからデータを取得
      const schedule = await scraper.getSchedule(project.name);

      // タスクタブからデータを取得
      const tasks = await scraper.getTasks(project.name);

      // 写真タブをクリックして写真をダウンロード
      const photos = await scraper.downloadPhotos(project.name);

      // 資料タブをクリックして資料をダウンロード
      const documents = await scraper.downloadDocuments(project.name);

      // 帳票タブからファイルをダウンロード
      const forms = await scraper.downloadForms(project.name);

      // 写真台帳タブからファイルをダウンロード
      const photoLedger = await scraper.downloadPhotoLedger(project.name);

      // 担当タブからデータを取得
      const staff = await scraper.getStaff(project.name);

      // 結果をJSONで保存
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const result = {
        project: { id: project.id, name: project.name, url: project.url },
        details,
        reports,
        schedule,
        tasks,
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

      // 案件一覧に戻る（最後の案件以外）
      if (i < projects.length - 1) {
        await scraper.backToProjectList();
      }
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
