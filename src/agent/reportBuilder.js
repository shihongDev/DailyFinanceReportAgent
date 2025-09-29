import { format } from 'date-fns';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Logger from '../twitter/Logger.js';

const DEFAULT_AI_MODEL = process.env.GOOGLE_AI_MODEL || 'gemini-1.5-pro-latest';

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

  const originalTweets = [];

  for (const tweet of tweets) {
    if (tweet.isRetweet) {
      summary.retweets += 1;
    } else if (tweet.isReply) {
      summary.replies += 1;
      originalTweets.push(tweet);
    } else {
      summary.originals += 1;
      originalTweets.push(tweet);
    }

    summary.likes += tweet.likes || 0;
    summary.retweetCount += tweet.retweetCount || 0;
    summary.repliesCount += tweet.replies || 0;
  }

  const ranked = [...tweets]
    .sort(
      (a, b) =>
        (b.likes || 0) + (b.retweetCount || 0) - ((a.likes || 0) + (a.retweetCount || 0))
    )
    .slice(0, 3);

  return {
    ...summary,
    topTweets: ranked,
  };
}

function formatTweetForPrompt(tweet, index) {
  const timestamp = format(new Date(tweet.timestamp), 'MMM d HH:mm');
  const engagement = `likes:${tweet.likes || 0}, retweets:${tweet.retweetCount || 0}, replies:${tweet.replies || 0}`;
  const text = tweet.text.replace(/\s+/g, ' ').trim();
  return `${index + 1}. (${timestamp}) ${text}\n   engagement: ${engagement}`;
}

async function maybeGenerateAiSummary({ apiKey, model, account, tweets, windowStart, windowEnd }) {
  if (!apiKey || tweets.length === 0) {
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const generativeModel = genAI.getGenerativeModel({ model: model || DEFAULT_AI_MODEL });

    const limitedTweets = tweets
      .slice()
      .sort(
        (a, b) =>
          (b.likes || 0) + (b.retweetCount || 0) - ((a.likes || 0) + (a.retweetCount || 0))
      )
      .slice(0, Math.min(12, tweets.length));

    const promptHeader = `You are a financial markets analyst. Summarize the most important takeaways from ${account}'s tweets between ${format(
      new Date(windowStart),
      'MMM d yyyy HH:mm'
    )} and ${format(new Date(windowEnd), 'MMM d yyyy HH:mm')} (local time). Focus on actionable market insights, unusual sentiment shifts, or notable positions. Provide at most three concise bullet points.`;

    const promptTweets = limitedTweets
      .map((tweet, index) => formatTweetForPrompt(tweet, index))
      .join('\n');

    const response = await generativeModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${promptHeader}\n\nTweets:\n${promptTweets}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    });

    const text = response?.response?.text()?.trim();
    return text || null;
  } catch (error) {
    Logger.warn(`AI summary unavailable (${account}): ${error.message}`);
    return null;
  }
}

export async function buildEmailContent({ results, windowHours, aiApiKey, aiModel }) {
  const now = new Date();
  const subject = `Finance Twitter Report ¨C ${format(now, 'MMM d yyyy HH:mm')}`;
  const textLines = [
    `Finance Twitter report covering the last ${windowHours} hours`,
    '',
  ];
  let htmlContent = `<h1>Finance Twitter Report</h1><p>Coverage window: last ${windowHours} hours</p>`;

  for (const result of results) {
    const metrics = computeMetrics(result.tweets);
    const aiSummary = await maybeGenerateAiSummary({
      apiKey: aiApiKey,
      model: aiModel,
      account: `@${result.username}`,
      tweets: result.tweets,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
    });

    textLines.push(`Account: @${result.username}`);
    textLines.push(
      `Window: ${formatWindow(result.windowStart)} ¨C ${formatWindow(result.windowEnd)}`
    );
    textLines.push(
      `Tweets collected: ${metrics.total} (originals: ${metrics.originals}, replies: ${metrics.replies}, retweets: ${metrics.retweets})`
    );
    textLines.push(
      `Engagement totals ¡ª likes: ${toLocaleNumber(metrics.likes)}, retweets: ${toLocaleNumber(metrics.retweetCount)}, replies: ${toLocaleNumber(metrics.repliesCount)}`
    );

    if (aiSummary) {
      textLines.push('AI Highlights:');
      textLines.push(aiSummary);
    }

    if (metrics.topTweets.length > 0) {
      textLines.push('Top tweets:');
      metrics.topTweets.forEach((tweet, idx) => {
        const timeLabel = format(new Date(tweet.timestamp), 'MMM d HH:mm');
        textLines.push(
          `${idx + 1}. [${timeLabel}] ${tweet.text.replace(/\s+/g, ' ').trim()} (?? ${toLocaleNumber(
            tweet.likes
          )}, ?? ${toLocaleNumber(tweet.retweetCount)}, ?? ${toLocaleNumber(tweet.replies)}) ${
            tweet.permanentUrl ? `¡ú ${tweet.permanentUrl}` : ''
          }`
        );
      });
    }

    textLines.push('');

    const htmlSection = [
      `<h2>@${escapeHtml(result.username)}</h2>`,
      `<p><strong>Window:</strong> ${escapeHtml(formatWindow(result.windowStart))} ¨C ${escapeHtml(
        formatWindow(result.windowEnd)
      )}</p>`,
      `<p><strong>Tweets:</strong> ${metrics.total} (originals: ${metrics.originals}, replies: ${metrics.replies}, retweets: ${metrics.retweets})</p>`,
      `<p><strong>Engagement totals:</strong> ?? ${toLocaleNumber(metrics.likes)} ¡¤ ?? ${toLocaleNumber(
        metrics.retweetCount
      )} ¡¤ ?? ${toLocaleNumber(metrics.repliesCount)}</p>`,
    ];

    if (aiSummary) {
      htmlSection.push(`<h3>AI Highlights</h3><p>${escapeHtml(aiSummary)}</p>`);
    }

    if (metrics.topTweets.length > 0) {
      const listItems = metrics.topTweets
        .map((tweet) => {
          const timeLabel = format(new Date(tweet.timestamp), 'MMM d HH:mm');
          const engagement = `?? ${toLocaleNumber(tweet.likes)} ¡¤ ?? ${toLocaleNumber(
            tweet.retweetCount
          )} ¡¤ ?? ${toLocaleNumber(tweet.replies)}`;
          const link = tweet.permanentUrl
            ? `<a href="${escapeHtml(tweet.permanentUrl)}">${escapeHtml('Open')}</a>`
            : '';
          return `<li><strong>${escapeHtml(timeLabel)}</strong> ¡ª ${escapeHtml(
            tweet.text
          )} <br/><span>${engagement}</span> ${link}</li>`;
        })
        .join('');

      htmlSection.push(`<h3>Top Tweets</h3><ul>${listItems}</ul>`);
    }

    htmlContent += htmlSection.join('\n');
  }

  return {
    subject,
    text: textLines.join('\n'),
    html: htmlContent,
  };
}
