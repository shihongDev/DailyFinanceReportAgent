import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

import Logger from '../twitter/Logger.js';
import TwitterPipeline from '../twitter/TwitterPipeline.js';
import { loadState, saveState, getStateFilePath } from './stateManager.js';
import { buildEmailContent } from './reportBuilder.js';
import { sendEmail } from './mailer.js';

process.on('unhandledRejection', (error) => {
  Logger.error(`Unhandled rejection in agent: ${error.message}`);
});

process.on('uncaughtException', (error) => {
  Logger.error(`Uncaught exception in agent: ${error.message}`);
});

const DEFAULT_ACCOUNTS = ['FL0WG0D', 'unusual_whales'];
const DEFAULT_WINDOW_HOURS = Number(process.env.AGENT_WINDOW_HOURS || 4);
const DEFAULT_INTERVAL_MINUTES = Number(
  process.env.AGENT_INTERVAL_MINUTES || DEFAULT_WINDOW_HOURS * 60
);
const TWEET_LIMIT = Number(process.env.AGENT_TWEET_LIMIT || 0);

function parseAccounts() {
  const raw = process.env.AGENT_ACCOUNTS;
  if (!raw) {
    return DEFAULT_ACCOUNTS;
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^@/, ''));
}

function ensurePositiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function collectTweetsForAccount(username, sinceTimestamp) {
  const options = {
    since: sinceTimestamp,
    interactive: false,
    windowHours: DEFAULT_WINDOW_HOURS,
  };

  if (Number.isFinite(TWEET_LIMIT) && TWEET_LIMIT > 0) {
    options.limit = TWEET_LIMIT;
  }

  const pipeline = new TwitterPipeline(username, options);
  const analytics = await pipeline.run();
  const rawTweets = pipeline.getCollectedTweets() || [];
  const seenIds = new Set();
  const filtered = [];
  const cutoff = Date.now() + 5 * 60 * 1000;

  for (const tweet of rawTweets) {
    if (!tweet || !tweet.id) continue;
    if (seenIds.has(tweet.id)) continue;
    if (tweet.timestamp && tweet.timestamp < sinceTimestamp) continue;
    if (tweet.timestamp && tweet.timestamp > cutoff) continue;
    seenIds.add(tweet.id);
    filtered.push(tweet);
  }

  filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return { tweets: filtered, analytics };
}

async function runOnce() {
  const accounts = parseAccounts();
  if (accounts.length === 0) {
    Logger.warn('No Twitter accounts configured for agent run.');
    return;
  }

  Logger.info(`Running agent for accounts: ${accounts.map((a) => `@${a}`).join(', ')}`);

  const state = await loadState();
  const stateUpdates = [];
  const results = [];
  const now = Date.now();
  const windowMs = ensurePositiveNumber(DEFAULT_WINDOW_HOURS, 4) * 60 * 60 * 1000;

  for (const username of accounts) {
    const lastRun = state.lastRun?.[username];
    const parsedLastRun = lastRun ? Date.parse(lastRun) : NaN;
    const sinceTimestamp = Number.isFinite(parsedLastRun)
      ? parsedLastRun
      : now - windowMs;

    Logger.info(
      `Collecting tweets for @${username} starting ${new Date(sinceTimestamp).toISOString()}`
    );

    try {
      const accountStart = Date.now();
      const { tweets, analytics } = await collectTweetsForAccount(
        username,
        sinceTimestamp
      );
      const windowEnd = Date.now();

      Logger.success(
        `Collected ${tweets.length} tweets for @${username} (elapsed ${(
          (windowEnd - accountStart) /
          1000
        ).toFixed(1)}s)`
      );

      results.push({
        username,
        tweets,
        analytics,
        windowStart: sinceTimestamp,
        windowEnd,
      });

      stateUpdates.push({ username, timestamp: new Date(windowEnd).toISOString() });
    } catch (error) {
      Logger.error(`Failed to collect tweets for @${username}: ${error.message}`);
    }
  }

  if (results.length === 0) {
    Logger.warn('Agent collected no tweets; skipping email dispatch.');
    return;
  }

  const emailContent = await buildEmailContent({
    results,
    windowHours: DEFAULT_WINDOW_HOURS,
    aiApiKey: process.env.GOOGLE_AI_API_KEY,
    aiModel: process.env.GOOGLE_AI_MODEL,
  });

  const recipients = (process.env.REPORT_RECIPIENT || 'lsh98dev@gmail.com')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(', ');

  const senderName = process.env.REPORT_SENDER_NAME || 'Finance Twitter Agent';
  const defaultFrom = process.env.SMTP_USER
    ? `${senderName} <${process.env.SMTP_USER}>`
    : undefined;
  const from = process.env.REPORT_FROM || defaultFrom;

  await sendEmail({
    ...emailContent,
    to: recipients,
    from,
  });

  const nextState = {
    lastRun: { ...(state.lastRun || {}) },
  };

  for (const update of stateUpdates) {
    nextState.lastRun[update.username] = update.timestamp;
  }

  await saveState(nextState);
  Logger.info(`State saved to ${getStateFilePath()}`);
}

async function startWatchMode() {
  const intervalMinutes = ensurePositiveNumber(DEFAULT_INTERVAL_MINUTES, 60);
  Logger.info(
    `Starting agent in watch mode (interval ${intervalMinutes} minutes, window ${DEFAULT_WINDOW_HOURS} hours)`
  );

  let running = false;

  const execute = async () => {
    if (running) {
      Logger.warn('Previous agent run still in progress. Skipping this interval.');
      return;
    }

    running = true;
    try {
      await runOnce();
    } catch (error) {
      Logger.error(`Agent run failed: ${error.message}`);
    } finally {
      running = false;
      const nextRun = new Date(Date.now() + intervalMinutes * 60 * 1000);
      Logger.info(`Next run scheduled for ${nextRun.toLocaleString()}`);
    }
  };

  await execute();
  setInterval(execute, intervalMinutes * 60 * 1000);
}

if (process.argv.includes('--watch')) {
  startWatchMode().catch((error) => {
    Logger.error(`Agent could not start in watch mode: ${error.message}`);
  });
} else {
  runOnce().catch((error) => {
    Logger.error(`Agent run failed: ${error.message}`);
    process.exitCode = 1;
  });
}
