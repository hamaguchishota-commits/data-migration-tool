import { chromium, Browser, Page, BrowserContext, ElementHandle } from 'playwright';
import { config } from './config';
import * as fs from 'fs';
import * as path from 'path';

const KANNA_LOGIN_URL = 'https://kanna4u.com/signin';
const KANNA_PROJECTS_URL = 'https://kanna4u.com/projects';
const DOWNLOAD_DIR = './downloads';

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
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.actionTimeout);
    this.page.setDefaultNavigationTimeout(config.navigationTimeout);
    console.log('ブラウザ起動完了');

    // ダウンロードディレクトリを作成
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`ログインページにアクセス: ${KANNA_LOGIN_URL}`);
    await this.page.goto(KANNA_LOGIN_URL);

    console.log('メールアドレスを入力中...');
    await this.page.fill('input[type="email"]', config.kannaEmail);

    console.log('パスワードを入力中...');
    await this.page.fill('input[type="password"]', config.kannaPassword);

    console.log('ログインボタンをクリック...');
    await this.page.click('button:has-text("ログインする")');

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
    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage) {
      console.log(`ページ ${pageNum} を取得中...`);

      const projectElements = await this.page.$$('table tbody tr, [data-testid="project-row"], .project-item, .project-card');

      if (projectElements.length === 0) {
        const projectLinks = await this.page.$$('a[href*="/projects/"]');

        for (const link of projectLinks) {
          const href = await link.getAttribute('href');
          const name = await link.textContent();

          if (href && name) {
            const idMatch = href.match(/\/projects\/(\d+)/);
            if (idMatch) {
              const id = idMatch[1];
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

  // 1. 概要タブの全項目を自動検出して取得
  async getProjectDetails(project: Project): Promise<ProjectDetail> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    console.log(`\n案件詳細ページにアクセス: ${project.name}`);
    await this.page.goto(project.url);
    await this.page.waitForLoadState('networkidle');

    // 概要タブをクリック（既に選択されている場合もある）
    const overviewTab = await this.page.$('button:has-text("概要"), a:has-text("概要"), [role="tab"]:has-text("概要"), .tab:has-text("概要")');
    if (overviewTab) {
      await overviewTab.click();
      await this.page.waitForLoadState('networkidle');
    }

    const details: ProjectDetail = {};

    // ラベル：値のペアを自動検出（複数のパターンに対応）
    const patterns = [
      // パターン1: dl > dt + dd
      { container: 'dl', label: 'dt', value: 'dd' },
      // パターン2: table > tr > th + td
      { container: 'table', label: 'th', value: 'td' },
      // パターン3: div内のラベルと値
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

    // 汎用的なキー・バリュー検出（ラベル要素の次の兄弟要素）
    const labelElements = await this.page.$$('[class*="label"], [class*="Label"], label');
    for (const labelEl of labelElements) {
      const labelText = await labelEl.textContent();
      if (labelText && labelText.trim()) {
        const key = labelText.trim().replace(/[:：]$/, '');
        if (!details[key]) {
          // 次の兄弟要素から値を取得
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

  // 2. 写真タブからフォルダ一覧と写真をダウンロード
  async downloadPhotos(project: Project): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(project.name), 'photos');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  写真タブを開く...`);

    // 写真タブをクリック
    const photoTab = await this.page.$('button:has-text("写真"), a:has-text("写真"), [role="tab"]:has-text("写真"), .tab:has-text("写真")');
    if (!photoTab) {
      console.log('  写真タブが見つかりません');
      return [];
    }

    await photoTab.click();
    await this.page.waitForLoadState('networkidle');

    const folders: FolderItem[] = [];

    // フォルダ一覧を取得
    const folderElements = await this.page.$$('.folder, .folder-item, [data-testid="folder"], a[href*="folder"], .directory');

    if (folderElements.length === 0) {
      // フォルダがない場合、直接写真をダウンロード
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

        // フォルダをクリックして中身を表示
        await folderEl.click();
        await this.page.waitForLoadState('networkidle');

        const files = await this.downloadImagesFromCurrentView(folderDir, safeFolderName);
        folders.push({ name: safeFolderName, files });

        // 戻るボタンまたは写真タブを再クリック
        const backButton = await this.page.$('button:has-text("戻る"), a:has-text("戻る"), .back-button');
        if (backButton) {
          await backButton.click();
        } else {
          await photoTab.click();
        }
        await this.page.waitForLoadState('networkidle');
      }
    }

    const totalFiles = folders.reduce((sum, f) => sum + f.files.length, 0);
    console.log(`  写真: ${folders.length} フォルダ, ${totalFiles} ファイル`);
    return folders;
  }

  // 3. 資料タブからフォルダ一覧とファイルをダウンロード
  async downloadDocuments(project: Project): Promise<FolderItem[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(project.name), 'documents');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log(`  資料タブを開く...`);

    // 資料タブをクリック
    const docTab = await this.page.$('button:has-text("資料"), a:has-text("資料"), [role="tab"]:has-text("資料"), .tab:has-text("資料")');
    if (!docTab) {
      console.log('  資料タブが見つかりません');
      return [];
    }

    await docTab.click();
    await this.page.waitForLoadState('networkidle');

    const folders: FolderItem[] = [];

    // フォルダ一覧を取得
    const folderElements = await this.page.$$('.folder, .folder-item, [data-testid="folder"], a[href*="folder"], .directory');

    if (folderElements.length === 0) {
      // フォルダがない場合、直接ファイルをダウンロード
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

        // フォルダをクリックして中身を表示
        await folderEl.click();
        await this.page.waitForLoadState('networkidle');

        const files = await this.downloadFilesFromCurrentView(folderDir, safeFolderName);
        folders.push({ name: safeFolderName, files });

        // 戻るボタンまたは資料タブを再クリック
        const backButton = await this.page.$('button:has-text("戻る"), a:has-text("戻る"), .back-button');
        if (backButton) {
          await backButton.click();
        } else {
          await docTab.click();
        }
        await this.page.waitForLoadState('networkidle');
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

    // 画像要素を取得
    const imageElements = await this.page.$$('img[src*="/photo"], img[src*="/image"], img[src*="storage"], .photo-item img, .gallery-item img');

    // ダウンロードリンクも探す
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

            // 画像をダウンロード
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

    // ダウンロードリンクからもダウンロード
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
        // ダウンロードイベントがない場合はスキップ
      }
    }

    return downloadedFiles;
  }

  // ファイルをダウンロード
  private async downloadFilesFromCurrentView(dir: string, folderName: string): Promise<string[]> {
    if (!this.page) return [];

    const downloadedFiles: string[] = [];

    // ファイルリンクを取得
    const fileLinks = await this.page.$$('a[href*="download"], a[download], a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".xls"], a[href$=".xlsx"], .file-item a, .document-item a');

    // ダウンロードボタンも探す
    const downloadButtons = await this.page.$$('button:has-text("ダウンロード"), button[aria-label*="download"], .download-button');

    console.log(`      ${fileLinks.length} 個のファイルリンクを検出`);

    for (const link of fileLinks) {
      try {
        const href = await link.getAttribute('href');
        const linkText = await link.textContent();

        // ダウンロードを試行
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
        // ダウンロードに失敗した場合はfetchでダウンロード
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

    // ダウンロードボタンからもダウンロード
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

    // 案件一覧を取得
    const projects = await scraper.getProjects();
    console.log(`\n=== ${projects.length} 件の案件を処理します ===`);

    for (const project of projects) {
      console.log(`\n----------------------------------------`);
      console.log(`案件: [${project.id}] ${project.name}`);
      console.log(`----------------------------------------`);

      // 1. 概要タブの項目を取得
      const details = await scraper.getProjectDetails(project);
      console.log('  概要データ:');
      for (const [key, value] of Object.entries(details)) {
        console.log(`    ${key}: ${value}`);
      }

      // 2. 写真をダウンロード
      const photos = await scraper.downloadPhotos(project);

      // 3. 資料をダウンロード
      const documents = await scraper.downloadDocuments(project);

      // 結果をJSONで保存
      const resultDir = path.join(DOWNLOAD_DIR, scraper['sanitizeFilename'](project.name));
      if (!fs.existsSync(resultDir)) {
        fs.mkdirSync(resultDir, { recursive: true });
      }

      const result = {
        project,
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
