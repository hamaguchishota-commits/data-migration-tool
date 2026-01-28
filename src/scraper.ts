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
        await sleep(1500); // リスト再読み込みを待機
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
            await sleep(1500); // リスト再読み込みを待機
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
              await sleep(1500);
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
    await sleep(1500);

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

  // 概要タブの全項目を自動検出して取得（会社ごとの設定に対応）
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

    // KANNA専用: メインコンテンツ領域からラベル・値ペアを抽出
    const extractedData = await this.page.evaluate(() => {
      const result: { [key: string]: string } = {};

      // 除外するテキスト（UI要素、タブ名など）
      const excludeTexts = [
        '概要', '関連案件', '工程表', 'タスク', '報告', '写真', '資料', '帳票', '写真台帳', '担当',
        '案件情報', '物件情報', '施工に関する注意点', '顧客情報',
        '編集する', 'チャット開始', 'ビュー表示', '詳細検索', '表示設定',
        'KANNA', 'AIベータ版', 'こんにちは', '案件作成', '案件ボード', '案件カレンダー',
        '顧客一覧', '物件一覧', 'エクスポート', '設定', 'メンバー管理', '料金プラン',
        'お問い合わせ', '運営からのお知らせ', 'よくあるご質問', '操作マニュアル', '利用規約', 'プライバシーポリシー',
        '案件概要をCSVでダウンロード'
      ];

      // 概要ページの既知のフィールドラベル（これらを探す）
      const knownLabels = [
        '案件名', '開始日', '終了日', '案件テンプレート', '案件フロー', '備考', '親案件',
        '物件名', '住所',
        '駐車スペース', '工事可能期間', '土日の工事', '現場ルール', 'その他',
        '区分', '氏名', '氏名(フリガナ)', '会社名または屋号名', '会社名または屋号名(フリガナ)', '担当者名', '電話番号1', '電話番号2', 'メールアドレス'
      ];

      // メインコンテンツエリアを特定（サイドバーを除外）
      // KANNAの構造: サイドバーは左側、メインコンテンツは右側
      const mainContent = document.querySelector('main, [role="main"], [class*="content"], [class*="main"]')
                        || document.body;

      // ラベルと値のペアを探す
      // パターン: 同じ行にラベル（短いテキスト）と値がある
      const allElements = mainContent.querySelectorAll('*');
      const processedTexts = new Set<string>();

      allElements.forEach(el => {
        const children = Array.from(el.children);

        // 直接の子要素が2〜3個で、最初が短いテキスト（ラベル）の場合
        if (children.length >= 2 && children.length <= 4) {
          const firstChild = children[0];
          const secondChild = children[1];

          const labelText = firstChild.textContent?.trim().replace(/[:：]$/, '') || '';
          let valueText = secondChild.textContent?.trim() || '';

          // ラベルが既知のフィールドか、または短いテキストでUI要素でない
          const isKnownLabel = knownLabels.includes(labelText);
          const isValidLabel = labelText.length > 0 && labelText.length < 30 &&
                              !excludeTexts.some(ex => labelText.includes(ex)) &&
                              !labelText.includes('件') && // "277件" のような表示を除外
                              !/^\d+$/.test(labelText); // 数字のみは除外

          if ((isKnownLabel || isValidLabel) && !processedTexts.has(labelText) && !result[labelText]) {
            // 値が「-」や空の場合
            if (valueText === '-' || valueText === '') {
              valueText = '';
            }
            // 値がラベルと同じ場合はスキップ（誤検出）
            if (valueText !== labelText && !excludeTexts.includes(valueText)) {
              // 値が長すぎる場合は誤検出の可能性
              if (valueText.length < 200) {
                result[labelText] = valueText;
                processedTexts.add(labelText);
              }
            }
          }
        }
      });

      return result;
    });

    // 結果を整理
    const details: ProjectDetail = {};
    for (const [key, value] of Object.entries(extractedData)) {
      // 空でないキーのみ追加（値は空でもOK）
      if (key && key.trim()) {
        details[key] = value;
      }
    }

    console.log(`  概要: ${Object.keys(details).length} 項目を取得`);

    // 取得した項目をログに出力
    for (const [key, value] of Object.entries(details)) {
      const displayValue = value || '(空)';
      console.log(`    ${key}: ${displayValue.substring(0, 50)}${displayValue.length > 50 ? '...' : ''}`);
    }

    return details;
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
        // 再取得（SPAでDOM変わる可能性）
        const currentRows = await this.page.$$('table tbody tr');
        if (i >= currentRows.length) break;

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
        const menuBtn = await row.$('td:last-child button, td:last-child [class*="menu"], td:last-child');

        if (menuBtn) {
          await menuBtn.click();
          await sleep(500);

          // 「ダウンロード」メニュー項目をクリック
          const downloadMenuItem = await this.page.$('[role="menuitem"]:has-text("ダウンロード"), [role="menu"] :has-text("ダウンロード"), [class*="menu"] :has-text("ダウンロード"), [class*="dropdown"] :has-text("ダウンロード"), li:has-text("ダウンロード"), button:has-text("ダウンロード"), a:has-text("ダウンロード")');

          if (downloadMenuItem) {
            try {
              const [download] = await Promise.all([
                this.page.waitForEvent('download', { timeout: 60000 }), // フォルダダウンロードは時間がかかる
                downloadMenuItem.click(),
              ]);

              const suggestedName = download.suggestedFilename();
              const safeFilename = this.sanitizeFilename(suggestedName || `${safeCategoryName}.zip`);
              const filepath = path.join(projectDir, safeFilename);
              await download.saveAs(filepath);
              folders.push({ name: safeCategoryName, files: [safeFilename] });
              console.log(`      フォルダダウンロード完了: ${safeFilename}`);
            } catch {
              console.log(`      フォルダダウンロード失敗（タイムアウト）`);
              await this.page.keyboard.press('Escape');
            }
          } else {
            console.log(`      ダウンロードメニューが見つかりません`);
            await this.page.keyboard.press('Escape');
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

    // KANNA: 報告カードを取得（カード形式のリスト）
    // カードには: 報告者名、タイトル（進捗報告など）、内容、写真アイコン+件数、時刻が表示
    const reportCards = await this.page.$$('[class*="card"], [class*="list-item"], [class*="report-item"], [class*="item"]:has([class*="report"]), table tbody tr');

    if (reportCards.length > 0) {
      console.log(`    ${reportCards.length} 件の報告を検出`);

      for (let i = 0; i < reportCards.length; i++) {
        try {
          // 再取得（SPAでDOM変わる可能性）
          const currentCards = await this.page.$$('[class*="card"], [class*="list-item"], [class*="report-item"], [class*="item"]:has([class*="report"]), table tbody tr');
          if (i >= currentCards.length) break;

          const card = currentCards[i];

          // カードから基本情報を抽出
          const cardData = await card.evaluate((el) => {
            const data: { [key: string]: string } = {};

            // テキスト全体
            const fullText = el.textContent?.trim() || '';

            // 報告者名（通常は上部に表示）
            const nameEl = el.querySelector('[class*="name"], [class*="author"], [class*="user"], [class*="reporter"]');
            if (nameEl) data['報告者'] = nameEl.textContent?.trim() || '';

            // タイトル（進捗報告など）
            const titleEl = el.querySelector('[class*="title"], h3, h4, strong');
            if (titleEl) data['タイトル'] = titleEl.textContent?.trim() || '';

            // 内容/本文
            const contentEl = el.querySelector('[class*="content"], [class*="body"], [class*="text"], [class*="description"], p');
            if (contentEl) data['内容'] = contentEl.textContent?.trim() || '';

            // 時刻
            const timeEl = el.querySelector('[class*="time"], [class*="date"], time');
            if (timeEl) data['時刻'] = timeEl.textContent?.trim() || '';

            // 写真件数（アイコン付きの数字を探す）
            const photoCountEl = el.querySelector('[class*="photo-count"], [class*="image-count"], [class*="count"]');
            if (photoCountEl) {
              const countText = photoCountEl.textContent?.trim() || '';
              const countMatch = countText.match(/\d+/);
              if (countMatch) data['写真件数'] = countMatch[0];
            }

            // フォールバック: 全テキストから情報を抽出
            if (Object.keys(data).length === 0) {
              data['内容'] = fullText.substring(0, 500);
            }

            return data;
          });

          console.log(`      [${i + 1}/${reportCards.length}] ${cardData['タイトル'] || cardData['内容']?.substring(0, 30) || '報告'}...`);

          // カードをクリックして詳細を開く
          await card.click();
          await sleep(1500);

          // 詳細画面からより詳しい情報を取得
          const detailData = await this.page.evaluate(() => {
            const detail: { [key: string]: string } = {};

            // モーダルまたは詳細パネルを探す
            const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="detail"], [class*="drawer"], [class*="panel"]');
            const container = modal || document;

            // ラベル・値ペアを探す
            const rows = container.querySelectorAll('[class*="row"], [class*="field"], div > div');
            rows.forEach(row => {
              const children = Array.from(row.children);
              if (children.length === 2) {
                const label = children[0].textContent?.trim().replace(/[:：]$/, '') || '';
                const value = children[1].textContent?.trim() || '';
                if (label && value && label.length < 30 && !detail[label]) {
                  detail[label] = value;
                }
              }
            });

            return detail;
          });

          // カード情報と詳細情報をマージ
          const reportData: { [key: string]: any } = { index: i + 1, ...cardData, ...detailData };

          // 写真をダウンロード
          const downloadedPhotos: string[] = [];
          const reportPhotoDir = path.join(projectDir, `report_${i + 1}`);

          // 写真要素を探す（サムネイルまたはリスト）
          const photoElements = await this.page.$$('[class*="photo"], [class*="image"], [class*="thumbnail"], img[src*="photo"], img[src*="image"], img[src*="storage"]');

          if (photoElements.length > 0) {
            if (!fs.existsSync(reportPhotoDir)) {
              fs.mkdirSync(reportPhotoDir, { recursive: true });
            }
            console.log(`        ${photoElements.length} 枚の写真を検出`);

            for (let j = 0; j < photoElements.length; j++) {
              try {
                // 再取得
                const currentPhotos = await this.page.$$('[class*="photo"], [class*="image"], [class*="thumbnail"], img[src*="photo"], img[src*="image"], img[src*="storage"]');
                if (j >= currentPhotos.length) break;

                const photoEl = currentPhotos[j];

                // 写真をクリックして詳細パネルを開く
                await photoEl.click();
                await sleep(1000);

                // ダウンロードボタンを探す
                const downloadBtn = await this.page.$('button:has-text("ダウンロード"), a:has-text("ダウンロード"), [class*="download"]');

                if (downloadBtn) {
                  try {
                    const [download] = await Promise.all([
                      this.page.waitForEvent('download', { timeout: 10000 }),
                      downloadBtn.click(),
                    ]);

                    const suggestedName = download.suggestedFilename();
                    const safeFilename = this.sanitizeFilename(suggestedName || `photo_${j + 1}.jpg`);
                    const filepath = path.join(reportPhotoDir, safeFilename);
                    await download.saveAs(filepath);
                    downloadedPhotos.push(safeFilename);
                    console.log(`          写真ダウンロード: ${safeFilename}`);
                  } catch {
                    console.log(`          写真ダウンロード失敗（タイムアウト）`);
                  }
                } else {
                  // ダウンロードボタンがない場合、画像を直接取得
                  const displayedImg = await this.page.$('img[src*="storage"], img[src*="photo"], [class*="preview"] img, [class*="viewer"] img');
                  if (displayedImg) {
                    const src = await displayedImg.getAttribute('src');
                    if (src) {
                      try {
                        const response = await this.page.request.get(src);
                        const buffer = await response.body();
                        const filename = `photo_${j + 1}${this.getExtension(src, '.jpg')}`;
                        const filepath = path.join(reportPhotoDir, filename);
                        fs.writeFileSync(filepath, buffer);
                        downloadedPhotos.push(filename);
                        console.log(`          画像取得: ${filename}`);
                      } catch {
                        console.log(`          画像取得失敗`);
                      }
                    }
                  }
                }

                // 写真詳細パネルを閉じる（ESCキーまたは閉じるボタン）
                const closeBtn = await this.page.$('button:has-text("閉じる"), button[aria-label="Close"], [class*="close"]:not([class*="photo"]):not([class*="image"]), button:has-text("×")');
                if (closeBtn) {
                  await closeBtn.click();
                } else {
                  await this.page.keyboard.press('Escape');
                }
                await sleep(500);

              } catch (photoError) {
                console.log(`          写真処理エラー: ${photoError}`);
                // ESCで閉じてみる
                await this.page.keyboard.press('Escape');
                await sleep(300);
              }
            }
          }

          reportData['downloadedPhotos'] = downloadedPhotos.join(', ');
          reports.push(reportData);

          // 報告詳細画面を閉じる
          const closeDetailBtn = await this.page.$('button:has-text("閉じる"), button[aria-label="Close"], [class*="close"], button:has-text("×"), button:has-text("✕")');
          if (closeDetailBtn) {
            await closeDetailBtn.click();
          } else {
            await this.page.keyboard.press('Escape');
          }
          await sleep(500);

        } catch (e) {
          console.log(`      エラー: ${e}`);
          // ESCで閉じる試み
          await this.page.keyboard.press('Escape');
          await sleep(300);
        }
      }
    } else {
      // 報告がない場合
      console.log('    報告が見つかりません');
    }

    console.log(`  報告: ${reports.length} 件`);
    return reports;
  }

  // 工程表タブからExcelをダウンロード
  async downloadSchedule(projectName: string): Promise<string[]> {
    if (!this.page) throw new Error('ブラウザが初期化されていません');

    const projectDir = path.join(DOWNLOAD_DIR, this.sanitizeFilename(projectName), 'schedule');
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    console.log('  工程表タブを開く...');
    const downloadedFiles: string[] = [];

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

    // Excel出力ボタンを探してクリック
    const excelBtn = await this.page.$('button:has-text("Excel出力"), button:has-text("Excel"), a:has-text("Excel出力"), a:has-text("Excel")');

    if (excelBtn) {
      try {
        console.log('    Excel出力ボタンを検出');
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          excelBtn.click(),
        ]);

        const suggestedName = download.suggestedFilename();
        const safeFilename = this.sanitizeFilename(suggestedName || 'schedule.xlsx');
        const filepath = path.join(projectDir, safeFilename);
        await download.saveAs(filepath);
        downloadedFiles.push(safeFilename);
        console.log(`    ダウンロード完了: ${safeFilename}`);
      } catch (e) {
        console.log(`    Excelダウンロード失敗: ${e}`);
      }
    } else {
      console.log('    Excel出力ボタンが見つかりません');
    }

    console.log(`  工程表: ${downloadedFiles.length} ファイル`);
    return downloadedFiles;
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

  // 帳票タブからデータをダウンロード（KANNA専用）
  // フォルダは一括ダウンロード不可→フォルダに入って個別ダウンロード
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
          await formsTab.click();
        }
        await sleep(1000);

      } catch (e) {
        console.log(`      フォルダ処理エラー: ${e}`);
        try {
          await formsTab.click();
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

      // 工程表タブからExcelをダウンロード
      const schedule = await scraper.downloadSchedule(project.name);

      // タスクタブはスキップ

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
