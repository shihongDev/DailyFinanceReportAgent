# DailyFinanceReportAgent

## Environment Setup

1. Create an isolated environment (requested) and install Node:
   ```ps1
   conda create -n finance-agent nodejs=20 -y
   conda activate finance-agent
   ```

2. Install project dependencies:
   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and provide the required values (Twitter credentials, SMTP details, optional Google AI key).

## Twitter Collection Pipeline

- Run the collector for a specific account:
  ```bash
  npm run twitter -- unusual_whales
  ```
- Extra CLI options:
  - `--since <iso|unix>` - only keep tweets newer than the timestamp.
  - `--hours <n>` - convenience shortcut for `now - n hours`.
  - `--limit <n>` - cap the number of tweets to retain.
  - `--no-interactive` - skip CLI prompts (useful for automation).

Results are stored under `pipeline/<username>/<timestamp>/` (raw tweets, analytics, exports, meta, cookies). The timestamp uses the `yyyy-MM-dd_HH-mm` format so each run gets a unique folder.

## Finance Report Agent

The agent collects the latest tweets for configured accounts every 4 hours, builds a report, and emails it to `lsh98dev@gmail.com` (configurable).

1. Configure the agent section in `.env` (see `.env.example`).
2. Run once:
   ```bash
   npm run agent
   ```
3. Keep it running with an internal scheduler (every `AGENT_INTERVAL_MINUTES`, default 240):
   ```bash
   npm run agent:watch
   ```

State is tracked in `agent_data/state.json`, letting each run resume from the previous successful timestamp.

### Email Delivery

Provide SMTP credentials (e.g., Gmail app password). Defaults:
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `REPORT_RECIPIENT` can include multiple comma-separated addresses.

### Optional AI Highlights

Set `GOOGLE_AI_API_KEY` (and optional `GOOGLE_AI_MODEL`) to add Gemini-based bullet summaries of each account’s activity.

## Project Scripts

| Script                | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `npm run twitter`     | Collect tweets for an account (supports filtering options) |
| `npm run agent`       | Run the finance report agent once                          |
| `npm run agent:watch` | Run the agent continuously on the configured interval      |

## Data & Logs

- Twitter artifacts: `pipeline/<account>/<timestamp>/`
- Agent state: `agent_data/state.json`
- Cookies maintained in `cookies/`



