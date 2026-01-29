# Data Migration Tool

Playwright を使用した Web スクレイピングツールです。ブラウザ自動化によるログイン認証とデータ抽出を行います。

## 機能

- ウェブサイトへの自動ログイン
- ページからのデータ抽出
- JSON 形式でのデータ保存
- スクリーンショット撮影

## 必要環境

- Node.js 18 以上
- npm

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. ブラウザのインストール

```bash
npm run install:browsers
```

### 3. 環境変数の設定

`.env.example` をコピーして `.env` を作成：

```bash
cp .env.example .env
```

`.env` を編集して実際の値を設定：

```env
# ログイン情報
LOGIN_URL=https://example.com/login
USERNAME=your_username
PASSWORD=your_password

# スクレイピング対象
TARGET_URL=https://example.com/data

# ブラウザ設定
HEADLESS=true    # false にすると画面が表示される
SLOW_MO=0        # 動作を遅くする（デバッグ用、ミリ秒）
```

### 4. スクレイパーのカスタマイズ

`src/scraper.ts` を編集して、対象サイトに合わせたセレクタを設定してください。

## 使い方

### スクレイピング実行

```bash
npm run scrape
```

### デバッグモード（ブラウザ表示）

`.env` で以下を設定：
```env
HEADLESS=false
SLOW_MO=100
```

## 出力

- `data/scraped_data.json` - 抽出データ
- `data/*.png` - スクリーンショット

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `npm run scrape` | スクレイパーを実行 |
| `npm run build` | TypeScript をコンパイル |
| `npm start` | エントリーポイントを実行 |
| `npm test` | テストを実行 |
| `npm run test:ui` | テストを UI モードで実行 |
| `npm run install:browsers` | Chromium をインストール |

## プロジェクト構造

```
src/
├── index.ts     # エントリーポイント
├── config.ts    # 設定管理
└── scraper.ts   # メインのスクレイパークラス
```

## トラブルシューティング

### ブラウザが見つからない

```bash
npm run install:browsers
```

### タイムアウトエラー

- URL が正しいか確認
- ネットワーク接続を確認
- `HEADLESS=false` で実際の画面を確認

### ログイン失敗

- `.env` の認証情報を確認
- セレクタが正しいか確認
- CAPTCHA やレート制限がないか確認

## ライセンス

ISC
