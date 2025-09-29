import { format } from 'date-fns';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Logger from '../twitter/Logger.js';

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
  return String(value).replace(/[&<>\"']/g, (char) => htmlEscapes[char] || char);
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
    .slice(0, MAX_TOP_TWEETS);

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

  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({ model: model || DEFAULT_AI_MODEL });

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

  const response = await generativeModel.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 400,
    },
  });

  const text = response?.response?.text()?.trim();
  if (!text) {
    throw new Error(`AI summary returned no content for @${account}`);
  }
  return text;
}

export async function buildEmailContent({ results, windowHours, aiApiKey, aiModel }) {
  if (!aiApiKey) {
    throw new Error('GOOGLE_AI_API_KEY must be set to build the report.');
  }

  const now = new Date();
  const subject = `Finance Twitter Report - ${format(now, 'MMM d yyyy HH:mm')}`;
  const textLines = [
    `Finance Twitter report covering the last ${windowHours} hours`,
    '',
  ];
  const htmlSections = [
    '<h1>Finance Twitter Report</h1>',
    `<p>Coverage window: last ${windowHours} hours</p>`,
  ];

  for (const result of results) {
    const metrics = computeMetrics(result.tweets);
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

    textLines.push(`=== @${result.username} ===`);
    textLines.push(
      `Window: ${formatWindow(result.windowStart)} to ${formatWindow(result.windowEnd)}`
    );
    textLines.push(
      `Tweets collected: ${metrics.total} (originals: ${metrics.originals}, replies: ${metrics.replies}, retweets: ${metrics.retweets})`
    );
    textLines.push(
      `Engagement totals - likes: ${toLocaleNumber(metrics.likes)}, retweets: ${toLocaleNumber(
        metrics.retweetCount
      )}, replies: ${toLocaleNumber(metrics.repliesCount)}`
    );
    textLines.push('AI Highlights:');
    textLines.push(aiSummary);

    if (metrics.topTweets.length > 0) {
      textLines.push('Top tweets:');
      metrics.topTweets.forEach((tweet, idx) => {
        const timeLabel = format(new Date(tweet.timestamp), 'MMM d HH:mm');
        const cleanText = tweet.text.replace(/\s+/g, ' ').trim();
        const link = tweet.permanentUrl ? ` => ${tweet.permanentUrl}` : '';
        textLines.push(
          `${idx + 1}. [${timeLabel}] ${cleanText} (likes ${toLocaleNumber(
            tweet.likes
          )}, retweets ${toLocaleNumber(tweet.retweetCount)}, replies ${toLocaleNumber(
            tweet.replies
          )})${link}`
        );
      });
    }

    textLines.push('');

    const htmlSection = [
      '<section>',
      `<h2>@${escapeHtml(result.username)}</h2>`,
      `<p><strong>Window:</strong> ${escapeHtml(formatWindow(result.windowStart))} to ${escapeHtml(
        formatWindow(result.windowEnd)
      )}</p>`,
      `<p><strong>Tweets:</strong> ${metrics.total} (originals: ${metrics.originals}, replies: ${metrics.replies}, retweets: ${metrics.retweets})</p>`,
      `<p><strong>Engagement totals:</strong> likes ${toLocaleNumber(
        metrics.likes
      )} &middot; retweets ${toLocaleNumber(metrics.retweetCount)} &middot; replies ${toLocaleNumber(
        metrics.repliesCount
      )}</p>`,
      `<h3>AI Highlights</h3><p>${escapeHtml(aiSummary)}</p>`,
    ];

    if (metrics.topTweets.length > 0) {
      const listItems = metrics.topTweets
        .map((tweet) => {
          const timeLabel = format(new Date(tweet.timestamp), 'MMM d HH:mm');
          const engagement = `likes ${toLocaleNumber(tweet.likes)} &middot; retweets ${toLocaleNumber(
            tweet.retweetCount
          )} &middot; replies ${toLocaleNumber(tweet.replies)}`;
          const link = tweet.permanentUrl
            ? `<a href="${escapeHtml(tweet.permanentUrl)}">Open</a>`
            : '';
          return `<li><strong>${escapeHtml(timeLabel)}</strong> - ${escapeHtml(
            tweet.text
          )} <br/><span>${engagement}</span> ${link}</li>`;
        })
        .join('');

      htmlSection.push(`<h3>Top Tweets</h3><ul>${listItems}</ul>`);
    }

    htmlSection.push('</section>');
    htmlSections.push(htmlSection.join('\n'));
  }

  return {
    subject,
    text: textLines.join('\n'),
    html: htmlSections.join('\n'),
  };
}
