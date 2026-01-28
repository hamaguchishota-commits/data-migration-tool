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

    // Locator APIを使用してサイドバー内のメニューを探す
    // サイドバー要素を特定
    const sidebar = this.page.locator('aside, nav, [role="navigation"], [class*="sidebar"], [class*="Sidebar"]').first();

    // サイドバー内の「案件一覧」リンクを探す
    const menuLink = sidebar.getByRole('link', { name: '案件一覧' })
      .or(sidebar.getByText('案件一覧', { exact: true }))
      .or(sidebar.locator('a:has-text("案件一覧")'));

    try {
      // 要素が表示されるまで待機
      await menuLink.first().waitFor({ state: 'visible', timeout: 10000 });
      console.log('  サイドバー内の「案件一覧」を発見');

      // クリック
      await menuLink.first().click();
      console.log('  クリック成功');

      // SPA: URLが /cms を含むまで待機
      await this.page.waitForURL(/\/cms/i, { timeout: 15000 });
      console.log('  案件一覧ページに遷移完了');

    } catch (e) {
      // フォールバック: 位置ベースで探す
      console.log('  Locatorで見つからず、位置ベースで探索...');

      const allLinks = await this.page.$$('a');
      let clicked = false;

      for (const link of allLinks) {
        const text = await link.textContent();
        if (text && text.includes('案件一覧')) {
          const box = await link.boundingBox();
          const isVisible = await link.isVisible();
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
        await this.saveScreenshot('error_menu_not_found');
        throw new Error('左サイドバーの「案件一覧」が見つかりません');
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

    while (hasNextPage) {
      console.log(`ページ ${pageNum} を取得中...`);

      // テーブルが表示されるまで待機
      await sleep(1000);

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

      // 次のページがあるかチェック
      const nextButton = await this.page.$('button:has-text("次"), a:has-text("次"), [aria-label="Next"], .pagination-next:not([disabled]), [class*="next"]:not([disabled])');
      if (nextButton) {
        const isDisabled = await nextButton.getAttribute('disabled');
        const ariaDisabled = await nextButton.getAttribute('aria-disabled');
        if (!isDisabled && ariaDisabled !== 'true') {
          await nextButton.click();
          await sleep(1000); // SPA: 固定待機
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
        await sleep(1000);
      }
    } catch {
      // 概要タブがない場合はスキップ
    }

    const details: ProjectDetail = {};

    // ラベル：値のペアを自動検出
    const patterns = [
      { container: 'dl', label: 'dt', value: 'dd' },
      { container: 'table', label: 'th', value: 'td' },
      { container: '.detail-item, .info-item, .field-group', label: '.label, .field-label, .item-label', value: '.value, .field-value, .item-value' },
    ];

    for (const pattern of patterns) {
      const containers: ElementHandle[] = await this.page!.$$(pattern.container);
      for (const container of containers) {
        const labels: ElementHandle[] = await container.$$(pattern.label);
        const values: ElementHandle[] = await container.$$(pattern.value);

        for (let i = 0; i < labels.length; i++) {
          const labelText: string | null = await labels[i].textContent();
          const valueText: string | null = values[i] ? await values[i].textContent() : '';

          if (labelText && labelText.trim()) {
            const key = labelText.trim().replace(/[:：]$/, '');
            details[key] = valueText?.trim() || '';
          }
        }
      }
    }

    // 汎用的なキー・バリュー検出
    const labelElements = await this.page.$$('[class*="label"], [class*="Label"], label');
    for (const labelEl of labelElements) {
      const labelText = await labelEl.textContent();
      if (labelText && labelText.trim()) {
        const key = labelText.trim().replace(/[:：]$/, '');
        if (!details[key]) {
          const valueText = await labelEl.evaluate((el) => {
            const next = el.nextElementSibling;
            return next ? next.textContent : '';
          });
          if (valueText) {
            details[key] = valueText.trim();
          }
        }
      }
    }

    console.log(`  概要: ${Object.keys(details).length} 項目を取得`);
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

    const imageElements = await this.page.$$('img[src*="/photo"], img[src*="/image"], img[src*="storage"], .photo-item img, .gallery-item img');
    const downloadLinks = await this.page.$$('a[href*="download"], a[download], button:has-text("ダウンロード")');

    if (imageElements.length > 0) {
      console.log(`      ${imageElements.length} 枚の画像を検出`);

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

    return downloadedFiles;
  }

  // ファイルをダウンロード
  private async downloadFilesFromCurrentView(dir: string, folderName: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];

    const fileLinks = await this.page.$$('a[href*="download"], a[download], a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".xls"], a[href$=".xlsx"], .file-item a, .document-item a');
    const downloadButtons = await this.page.$$('button:has-text("ダウンロード"), button[aria-label*="download"], .download-button');

    console.log(`      ${fileLinks.length} 個のファイルリンクを検出`);

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
        const href = await link.getAttribute('href');
        if (href) {
          try {
            const response = await this.page.request.get(href);
            const buffer = await response.body();
            const filename = `file_${downloadedFiles.length + 1}${this.getExtension(href, '')}`;
            const filepath = path.join(dir, filename);
            fs.writeFileSync(filepath, buffer);
            downloadedFiles.push(filename);
          } catch {
            // スキップ
          }
        }
      }
    }

    for (const btn of downloadButtons) {
      try {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 5000 }),
          btn.click(),
        ]);

        const filename = download.suggestedFilename() || `file_${downloadedFiles.length + 1}`;
        const safeFilename = this.sanitizeFilename(filename);
        const filepath = path.join(dir, safeFilename);
        await download.saveAs(filepath);
        downloadedFiles.push(safeFilename);
      } catch {
        // スキップ
      }
    }

    return downloadedFiles;
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
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      console.log(`\n========================================`);
      console.log(`案件 ${i + 1}/${projects.length}: [${project.id}] ${project.name}`);
      console.log(`========================================`);

      // 案件をクリックして詳細ページへ遷移
      await scraper.clickProject(project);

      // 概要タブの項目を取得
      const details = await scraper.getProjectDetails();
      console.log('  概要データ:');
      for (const [key, value] of Object.entries(details)) {
        console.log(`    ${key}: ${value}`);
      }

      // 写真タブをクリックして写真をダウンロード
      const photos = await scraper.downloadPhotos(project.name);

      // 資料タブをクリックして資料をダウンロード
      const documents = await scraper.downloadDocuments(project.name);

      // 結果をJSONで保存
      const resultDir = path.join(DOWNLOAD_DIR, scraper['sanitizeFilename'](project.name));
      if (!fs.existsSync(resultDir)) {
        fs.mkdirSync(resultDir, { recursive: true });
      }

      const result = {
        project: { id: project.id, name: project.name, url: project.url },
        details,
        photos,
        documents,
        exportedAt: new Date().toISOString(),
      };

      fs.writeFileSync(
        path.join(resultDir, 'project_data.json'),
        JSON.stringify(result, null, 2),
        'utf-8'
      );
      console.log(`  データをproject_data.jsonに保存しました`);

      // 案件一覧に戻る（最後の案件以外）
      if (i < projects.length - 1) {
        await scraper.backToProjectList();
      }
    }

    console.log('\n=== 全ての処理が完了しました ===');
  } catch (error) {
    console.error('エラーが発生しました:', error);
    throw error;
  } finally {
    await scraper.close();
  }
}

main();
