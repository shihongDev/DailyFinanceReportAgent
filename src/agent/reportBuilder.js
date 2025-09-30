import { format } from 'date-fns';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Logger from '../twitter/Logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_AI_MODEL = process.env.GOOGLE_AI_MODEL || 'gemini-1.5-pro-latest';
const MAX_PROMPT_TWEETS = 12;
const MAX_TOP_TWEETS = 5;

const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => htmlEscapes[char] || char);
}

function toLocaleNumber(value = 0) {
  return Number(value || 0).toLocaleString();
}

function formatWindow(timestamp) {
  return format(new Date(timestamp), 'MMM d yyyy HH:mm');
}

function computeMetrics(tweets) {
  const summary = {
    total: tweets.length,
    originals: 0,
    replies: 0,
    retweets: 0,
    likes: 0,
    retweetCount: 0,
    repliesCount: 0,
  };

  const ranked = [];

  for (const tweet of tweets) {
    if (tweet.isRetweet) {
      summary.retweets += 1;
    } else if (tweet.isReply) {
      summary.replies += 1;
      ranked.push(tweet);
    } else {
      summary.originals += 1;
      ranked.push(tweet);
    }

    summary.likes += tweet.likes || 0;
    summary.retweetCount += tweet.retweetCount || 0;
    summary.repliesCount += tweet.replies || 0;
  }

  const topTweets = ranked
    .sort(
      (a, b) =>
        (b.likes || 0) + (b.retweetCount || 0) - ((a.likes || 0) + (a.retweetCount || 0))
    )
    .slice(0, MAX_TOP_TWEETS)
    .map((tweet) => ({
      timestamp: tweet.timestamp,
      text: tweet.text,
      likes: tweet.likes || 0,
      retweets: tweet.retweetCount || tweet.retweets || 0,
      replies: tweet.replies || 0,
      url: tweet.permanentUrl || '',
    }));

  return {
    ...summary,
    topTweets,
  };
}

function formatTweetForPrompt(tweet, index) {
  const timestamp = format(new Date(tweet.timestamp), 'MMM d HH:mm');
  const engagement = `likes:${tweet.likes || 0}, retweets:${tweet.retweetCount || 0}, replies:${tweet.replies || 0}`;
  const text = tweet.text.replace(/\s+/g, ' ').trim();
  return `${index + 1}. (${timestamp}) ${text}\n   engagement: ${engagement}`;
}

async function generateAiSummary({ apiKey, model, account, tweets, windowStart, windowEnd }) {
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY is required for report generation.');
  }

  if (tweets.length === 0) {
    return 'No tweets were posted in this window.';
  }

  const limitedTweets = tweets
    .slice()
    .sort(
      (a, b) =>
        (b.likes || 0) + (b.retweetCount || 0) - ((a.likes || 0) + (a.retweetCount || 0))
    )
    .slice(0, Math.min(MAX_PROMPT_TWEETS, tweets.length));

  const prompt = [
    'Role: Senior financial markets analyst.',
    `Task: Provide at most three concise bullet points summarizing @${account} activity.`,
    'Focus on actionable market insight, positioning changes, notable sentiment, and catalysts.',
    'Do not repeat tweet text verbatim or invent information not implied by the tweets.',
    `Time window: ${format(new Date(windowStart), 'MMM d yyyy HH:mm')} to ${format(
      new Date(windowEnd),
      'MMM d yyyy HH:mm'
    )}.`,
    '',
    'Tweets:',
    limitedTweets.map((tweet, idx) => formatTweetForPrompt(tweet, idx)).join('\n'),
  ].join('\n');

  try {
    return await generateAiSummaryViaPython({
      model: model || DEFAULT_AI_MODEL,
      prompt,
    });
  } catch (error) {
    Logger.warn(`Python AI summary failed for @${account}: ${error.message}`);
  }

  try {
    return await generateAiSummaryViaRest({
      apiKey,
      model: model || DEFAULT_AI_MODEL,
      prompt,
    });
  } catch (error) {
    Logger.warn(`REST AI summary failed for @${account}: ${error.message}`);
    throw error;
  }
}

async function renderWithPython(payload) {
  const rendererPath = path.join(process.cwd(), 'scripts', 'render_report.py');
  try {
    await fs.access(rendererPath);
  } catch {
    throw new Error('Report renderer script not found.');
  }

  const payloadPath = path.join(tmpdir(), `finance-report-${randomUUID()}.json`);
  const htmlPath = path.join(tmpdir(), `finance-report-${randomUUID()}.html`);
  const textPath = path.join(tmpdir(), `finance-report-${randomUUID()}.txt`);

  await fs.writeFile(payloadPath, JSON.stringify(payload), 'utf-8');

  let renderSucceeded = false;
  let lastError = null;
  for (const executable of ['python3', 'python']) {
    try {
      await execFileAsync(executable, [
        rendererPath,
        '--input',
        payloadPath,
        '--html-output',
        htmlPath,
        '--text-output',
        textPath,
      ], { env: process.env });
      renderSucceeded = true;
      break;
    } catch (error) {
      lastError = error;
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  if (!renderSucceeded) {
    throw lastError || new Error('Unable to execute Python renderer.');
  }

  try {
    const [htmlOutput, textOutput] = await Promise.all([
      fs.readFile(htmlPath, 'utf-8'),
      fs.readFile(textPath, 'utf-8'),
    ]);
    return { html: htmlOutput, text: textOutput };
  } finally {
    await Promise.allSettled([
      fs.unlink(payloadPath),
      fs.unlink(htmlPath),
      fs.unlink(textPath),
    ]);
  }
}

function buildPlainTextFallback(payload) {
  const lines = [
    `Finance Twitter report covering the last ${payload.windowHours} hours`,
    '',
    '=== Run Overview ===',
    `Accounts: ${payload.overview.accounts}`,
    `Total tweets: ${payload.overview.totalTweets}`,
    `Engagement totals - likes: ${payload.overview.totalLikes.toLocaleString()}, retweets: ${payload.overview.totalRetweets.toLocaleString()}, replies: ${payload.overview.totalReplies.toLocaleString()}`,
  ];

  if (payload.overview.earliestStart && payload.overview.latestEnd) {
    lines.push(
      `Overall window: ${formatWindow(payload.overview.earliestStart)} to ${formatWindow(payload.overview.latestEnd)}`
    );
  }
  lines.push('');

  for (const account of payload.accounts) {
    lines.push(`=== @${account.username} ===`);
    lines.push(
      `Window: ${formatWindow(account.windowStart)} to ${formatWindow(account.windowEnd)}`
    );
    const m = account.metrics;
    lines.push(
      `Tweets collected: ${m.total} (originals: ${m.originals}, replies: ${m.replies}, retweets: ${m.retweets})`
    );
    lines.push(
      `Engagement totals - likes: ${toLocaleNumber(m.likes)}, retweets: ${toLocaleNumber(m.engagementRetweets)}, replies: ${toLocaleNumber(m.engagementReplies)}`
    );
    lines.push('AI Highlights:');
    if (account.aiSummary) {
      account.aiSummary.split('\n').forEach((line) => {
        lines.push(`  ${line}`);
      });
    } else {
      lines.push('  No highlights available.');
    }

    if (account.topTweets.length > 0) {
      lines.push('Top tweets:');
      account.topTweets.forEach((tweet, idx) => {
        lines.push(
          `  ${idx + 1}. [${formatWindow(tweet.timestamp)}] ${tweet.text}`
        );
        lines.push(
          `    likes ${toLocaleNumber(tweet.likes)} | retweets ${toLocaleNumber(tweet.retweets)} | replies ${toLocaleNumber(tweet.replies)}`
        );
        if (tweet.url) {
          lines.push(`    link: ${tweet.url}`);
        }
      });
    } else {
      lines.push('Top tweets: none in this window.');
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}



async function generateAiSummaryViaPython({ model, prompt }) {
  const scriptPath = path.join(process.cwd(), 'scripts', 'ai_summary.py');
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error('AI summary script not found.');
  }

  const payloadPath = path.join(tmpdir(), `ai-summary-${randomUUID()}.json`);

  await fs.writeFile(payloadPath, JSON.stringify({ model, prompt }), 'utf-8');

  let lastError = null;
  try {
    for (const executable of ['python3', 'python']) {
      try {
        const { stdout } = await execFileAsync(executable, [
          scriptPath,
          '--input',
          payloadPath,
        ], { env: process.env });
        const textOutput = stdout.trim();
        if (!textOutput) {
          throw new Error('AI summary script returned empty output.');
        }
        return textOutput;
      } catch (error) {
        lastError = error;
        if (error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('Python executable not found on PATH.');
  } finally {
    await fs.unlink(payloadPath).catch(() => undefined);
  }
}

async function generateAiSummaryViaRest({ apiKey, model, prompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`REST API call failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const textParts = data?.candidates?.[0]?.content?.parts || [];
  const text = textParts
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('REST API call returned no text.');
  }
  return text;
}

export async function buildEmailContent({ results, windowHours, aiApiKey, aiModel }) {
  const now = new Date();
  const subject = `Finance Twitter Report - ${format(now, 'MMM d yyyy HH:mm')}`;

  const aggregate = {
    accounts: results.length,
    totalTweets: 0,
    totalLikes: 0,
    totalRetweets: 0,
    totalReplies: 0,
    earliestStart: null,
    latestEnd: null,
  };

  const accountsPayload = [];

  for (const result of results) {
    const metrics = computeMetrics(result.tweets);

    aggregate.totalTweets += metrics.total;
    aggregate.totalLikes += metrics.likes;
    aggregate.totalRetweets += metrics.retweetCount;
    aggregate.totalReplies += metrics.repliesCount;

    if (!aggregate.earliestStart || result.windowStart < aggregate.earliestStart) {
      aggregate.earliestStart = result.windowStart;
    }
    if (!aggregate.latestEnd || result.windowEnd > aggregate.latestEnd) {
      aggregate.latestEnd = result.windowEnd;
    }

    let aiSummary;
    try {
      aiSummary = await generateAiSummary({
        apiKey: aiApiKey,
        model: aiModel,
        account: result.username,
        tweets: result.tweets,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
      });
    } catch (error) {
      Logger.warn(`AI summary failed for @${result.username}: ${error.message}`);
      aiSummary = 'AI summary unavailable.';
    }

    accountsPayload.push({
      username: result.username,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      metrics: {
        total: metrics.total,
        originals: metrics.originals,
        replies: metrics.replies,
        retweets: metrics.retweets,
        likes: metrics.likes,
        engagementRetweets: metrics.retweetCount,
        engagementReplies: metrics.repliesCount,
      },
      aiSummary,
      topTweets: metrics.topTweets,
    });
  }

  const payload = {
    generatedAt: now.getTime(),
    windowHours,
    overview: aggregate,
    accounts: accountsPayload,
  };

  try {
    const rendered = await renderWithPython(payload);
    return {
      subject,
      text: rendered.text,
      html: rendered.html,
    };
  } catch (error) {
    Logger.warn(`Python renderer failed, falling back to plain layout: ${error.message}`);
    const fallbackText = buildPlainTextFallback(payload);
    const fallbackHtml = `<pre style="font-family: 'SFMono-Regular', Consolas, monospace; white-space: pre-wrap;">${escapeHtml(fallbackText)}</pre>`;
    return {
      subject,
      text: fallbackText,
      html: fallbackHtml,
    };
  }
}
