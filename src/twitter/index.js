// index.js
import dotenv from 'dotenv';
dotenv.config();

import TwitterPipeline from './TwitterPipeline.js';
import Logger from './Logger.js';

process.on('unhandledRejection', (error) => {
  Logger.error(`❌ Unhandled promise rejection: ${error.message}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  Logger.error(`❌ Uncaught exception: ${error.message}`);
  process.exit(1);
});

const args = process.argv.slice(2);

const options = {};
let username;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (!arg.startsWith('--')) {
    if (!username) {
      username = arg;
    }
    continue;
  }

  const [flag, valueFromEquals] = arg.split('=');
  const consume = () => {
    if (valueFromEquals !== undefined) {
      return valueFromEquals;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      i += 1;
      return next;
    }
    return null;
  };

  switch (flag) {
    case '--since': {
      const value = consume();
      if (!value) {
        Logger.warn('Option --since requires a value.');
      } else {
        options.since = value;
      }
      break;
    }
    case '--until': {
      const value = consume();
      if (!value) {
        Logger.warn('Option --until requires a value.');
      } else {
        options.until = value;
      }
      break;
    }
    case '--hours':
    case '--window-hours': {
      const value = consume();
      const parsed = Number(value);
      if (!value || Number.isNaN(parsed)) {
        Logger.warn(`Option ${flag} requires a numeric value.`);
      } else {
        options.windowHours = parsed;
      }
      break;
    }
    case '--limit': {
      const value = consume();
      const parsed = Number(value);
      if (!value || Number.isNaN(parsed)) {
        Logger.warn('Option --limit requires a numeric value.');
      } else {
        options.limit = parsed;
      }
      break;
    }
    case '--max-tweets': {
      const value = consume();
      const parsed = Number(value);
      if (!value || Number.isNaN(parsed)) {
        Logger.warn('Option --max-tweets requires a numeric value.');
      } else {
        options.maxTweets = parsed;
      }
      break;
    }
    case '--no-interactive': {
      options.interactive = false;
      break;
    }
    case '--interactive': {
      options.interactive = true;
      break;
    }
    default: {
      Logger.warn(`Unknown option: ${flag}`);
      break;
    }
  }
}

if (!username) {
  username = 'degenspartan';
}

username = username.replace(/^@/, '');

const pipeline = new TwitterPipeline(username, options);

const cleanup = async () => {
  Logger.warn('\n🛑 Received termination signal. Cleaning up...');
  try {
    if (pipeline.scraper) {
      await pipeline.scraper.logout();
      Logger.success('🔒 Logged out successfully.');
    }
  } catch (error) {
    Logger.error(`❌ Error during cleanup: ${error.message}`);
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

pipeline.run().catch(() => process.exit(1));
