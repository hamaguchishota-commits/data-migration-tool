# CLAUDE.md - AI Assistant Guidelines

This document provides essential context for AI assistants working with this codebase.

## Project Overview

**Name:** data-migration-tool
**Purpose:** Web scraping framework using Playwright for automated browser automation and data extraction
**Language:** TypeScript
**Runtime:** Node.js

## Repository Structure

```
data-migration-tool/
├── src/                    # Source code
│   ├── index.ts           # Entry point (exports config, startup message)
│   ├── config.ts          # Configuration management (env variables)
│   └── scraper.ts         # Main WebScraper class
├── data/                   # Output directory (gitignored)
│   ├── scraped_data.json  # Extracted data output
│   └── *.png              # Screenshots
├── dist/                   # Compiled JavaScript (gitignored)
├── .env                    # Environment variables (gitignored)
├── .env.example           # Environment template
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

## Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| TypeScript | ^5.9.3 | Type-safe JavaScript development |
| Playwright | ^1.58.0 | Browser automation (Chromium) |
| ts-node | ^10.9.2 | Direct TypeScript execution |
| dotenv | ^17.2.3 | Environment variable management |

## Development Commands

```bash
# Install dependencies
npm install

# Install browser binaries (required first-time)
npm run install:browsers

# Run the scraper
npm run scrape

# Compile TypeScript to JavaScript
npm run build

# Run entry point
npm start
```

## Key Files

### `src/config.ts`
Configuration module that loads environment variables:
- `loginUrl` - Target website login URL
- `username`, `password` - Login credentials
- `targetUrl` - URL to scrape data from
- `headless` - Run browser in headless mode (default: true)
- `slowMo` - Slow down browser actions in milliseconds
- `navigationTimeout` - 30 seconds
- `actionTimeout` - 10 seconds

### `src/scraper.ts`
Main `WebScraper` class with methods:
- `init()` - Launch Chromium browser with custom viewport (1280x720)
- `login()` - Navigate and authenticate (requires customization)
- `scrapeData()` - Extract data from target page (requires customization)
- `saveData()` - Write JSON to `data/scraped_data.json`
- `screenshot()` - Capture full-page screenshot
- `close()` - Clean up browser resources

## Environment Variables

Create `.env` file from `.env.example`:

```bash
LOGIN_URL=https://example.com/login
USERNAME=your_username
PASSWORD=your_password
TARGET_URL=https://example.com/data
HEADLESS=true
SLOW_MO=0
```

## Code Conventions

### TypeScript
- Strict mode enabled (`strict: true` in tsconfig)
- ES2022 target with CommonJS modules
- Type declarations generated in `dist/`
- Source maps enabled for debugging

### Error Handling
- Use try-catch-finally pattern
- Always ensure browser cleanup in finally block
- Throw errors with descriptive messages

### File I/O
- Use `path.join(__dirname, ...)` for relative paths
- Auto-create output directories with `fs.mkdirSync(..., { recursive: true })`
- JSON output uses 2-space indentation

### Browser Automation
- Custom user agent to mimic real browser
- Viewport: 1280x720 pixels
- Wait for network idle after navigation
- Use CSS selectors for element targeting

## Customization Points

When adapting this scraper for a new target website:

1. **Login Flow** (`scraper.ts` lines ~33-38):
   - Update form selectors (input names, button types)
   - Add wait conditions for login completion
   - Handle post-login navigation

2. **Data Extraction** (`scraper.ts` lines ~50-57):
   - Define CSS selectors for data elements
   - Map DOM properties to JavaScript objects
   - Handle pagination if needed

## Testing

**Current Status:** No testing framework configured

**Recommended Setup:**
- Use `@playwright/test` for E2E testing
- Add test script to package.json
- Create `tests/` directory for test files

## Git Workflow

### Ignored Files
- `node_modules/` - Dependencies
- `dist/` - Compiled output
- `.env` - Sensitive credentials
- `data/*.json`, `data/*.csv` - Output data
- `playwright-report/`, `test-results/` - Test artifacts

### Commit Guidelines
- Use descriptive commit messages
- Don't commit sensitive credentials
- Don't commit scraped data files

## Common Tasks

### Adding a New Scraping Target
1. Copy `scraper.ts` or create a new scraper module
2. Update selectors for login form elements
3. Update selectors for data extraction
4. Configure environment variables
5. Test with `HEADLESS=false` to visually debug

### Debugging Scraper Issues
1. Set `HEADLESS=false` in `.env` to see browser
2. Add `SLOW_MO=100` to slow down actions
3. Use `screenshot()` method at problem points
4. Check browser console for JavaScript errors

### Handling Authentication
- Credentials stored in `.env` (never commit)
- Session cookies persist in browser context
- Add wait conditions for login redirects

## Architecture Notes

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   config.ts │────▶│  scraper.ts  │────▶│  data/*.json│
│  (env vars) │     │ (WebScraper) │     │ (output)    │
└─────────────┘     └──────────────┘     └─────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  Playwright  │
                    │  (Chromium)  │
                    └──────────────┘
```

## Troubleshooting

### "Browser not installed"
Run `npm run install:browsers` to download Chromium.

### "Navigation timeout"
- Check if URL is accessible
- Increase `navigationTimeout` in config
- Verify network connectivity

### "Element not found"
- Verify CSS selectors match target page
- Add explicit waits with `page.waitForSelector()`
- Check if content is dynamically loaded

### "Login failed"
- Verify credentials in `.env`
- Check if login flow has changed
- Look for CAPTCHA or rate limiting

## Security Considerations

- Never commit `.env` files with real credentials
- Use environment variables for all sensitive data
- Respect robots.txt and rate limits
- Only scrape data you have permission to access
