#!/usr/bin/env python3
"""Render finance report into HTML and plain text."""
import argparse
import html
import json
import sys
from datetime import datetime
from pathlib import Path
from textwrap import indent, wrap


def fmt_number(value):
    if isinstance(value, (int, float)):
        return f"{value:,}"
    return str(value)


def fmt_window(ts):
    if ts is None:
        return "N/A"
    dt = datetime.fromtimestamp(ts / 1000)
    return dt.strftime('%b %d %Y %H:%M')


def parse_ai_summary(summary):
    if not summary:
        return [], []
    lines = [line.strip() for line in summary.splitlines() if line.strip()]
    bullets = []
    paragraphs = []
    for line in lines:
        if line.startswith(('- ', '* ')):
            bullets.append(line[2:].strip())
        elif line[:2].isdigit() and line[2:3] in {'.', ')'}:
            bullets.append(line[3:].strip())
        else:
            paragraphs.append(line)
    return bullets, paragraphs


def build_overview_html(overview, window_hours):
    rows = [
        ('Accounts', fmt_number(overview['accounts'])),
        ('Total tweets', fmt_number(overview['totalTweets'])),
        ('Total likes', fmt_number(overview['totalLikes'])),
        ('Total retweets', fmt_number(overview['totalRetweets'])),
        ('Total replies', fmt_number(overview['totalReplies'])),
    ]
    if overview['earliestStart'] and overview['latestEnd']:
        rows.append(
            (
                'Overall window',
                f"{fmt_window(overview['earliestStart'])} to {fmt_window(overview['latestEnd'])}"
            )
        )
    table_rows = '\n'.join(
        f"<tr><th>{html.escape(label)}</th><td>{html.escape(value)}</td></tr>"
        for label, value in rows
    )
    return (
        "<section class=\"card overview\">"
        "<h2>Run Overview</h2>"
        f"<p class=\"meta\">Coverage window: last {window_hours} hours</p>"
        f"<table>{table_rows}</table>"
        "</section>"
    )


def build_account_html(account):
    bullets, paragraphs = parse_ai_summary(account['aiSummary'])
    summary_parts = []
    if bullets:
        summary_parts.append(
            '<ul>' + ''.join(f"<li>{html.escape(item)}</li>" for item in bullets) + '</ul>'
        )
    for paragraph in paragraphs:
        summary_parts.append(f"<p>{html.escape(paragraph)}</p>")
    if not summary_parts:
        summary_parts.append('<p>No highlights available.</p>')

    m = account['metrics']
    metrics_rows = [
        ('Total tweets', m['total']),
        ('Originals', m['originals']),
        ('Replies', m['replies']),
        ('Retweets', m['retweets']),
        ('Likes', m['likes']),
        ('Retweets (engagement)', m['engagementRetweets']),
        ('Replies (engagement)', m['engagementReplies']),
    ]
    metrics_table = '\n'.join(
        f"<tr><th>{html.escape(label)}</th><td>{fmt_number(value)}</td></tr>"
        for label, value in metrics_rows
    )

    if account['topTweets']:
        top_tweets_html = '<ol class="tweet-list">' + ''.join(
            (
                '<li>'
                f"<div class=\"tweet-meta\">{html.escape(fmt_window(tweet['timestamp']))}</div>"
                f"<div class=\"tweet-text\">{html.escape(tweet['text'])}</div>"
                f"<div class=\"tweet-engagement\">likes {fmt_number(tweet['likes'])} &middot; "
                f"retweets {fmt_number(tweet['retweets'])} &middot; "
                f"replies {fmt_number(tweet['replies'])}</div>"
                + (
                    f"<div class=\"tweet-link\"><a href=\"{html.escape(tweet['url'])}\">Open</a></div>"
                    if tweet['url'] else ''
                )
                + '</li>'
            )
            for tweet in account['topTweets']
        ) + '</ol>'
    else:
        top_tweets_html = '<p class="empty">No top tweets in this window.</p>'

    return (
        "<section class=\"card account\">"
        f"<h2>@{html.escape(account['username'])}</h2>"
        f"<p class=\"meta\">{fmt_window(account['windowStart'])} to {fmt_window(account['windowEnd'])}</p>"
        f"<table>{metrics_table}</table>"
        '<div class="section-block">'
        '<h3>AI Highlights</h3>'
        + ''.join(summary_parts)
        + '</div>'
        '<div class="section-block">'
        '<h3>Top Tweets</h3>'
        + top_tweets_html
        + '</div>'
        '</section>'
    )


def render_html(payload):
    overview_html = build_overview_html(payload['overview'], payload['windowHours'])
    accounts_html = '\n'.join(build_account_html(acc) for acc in payload['accounts'])

    return f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\" />
<title>Finance Twitter Report</title>
<style>
  :root {{
    color-scheme: light dark;
    font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
    --bg: #f8fafc;
    --card-bg: #ffffff;
    --text: #111827;
    --muted: #6b7280;
    --accent: #2563eb;
    --border: #e5e7eb;
  }}
  body {{
    margin: 0;
    background: var(--bg);
    color: var(--text);
  }}
  .container {{
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 20px 48px;
  }}
  h1 {{
    font-size: 28px;
    margin-bottom: 12px;
  }}
  .card {{
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 24px;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
  }}
  .card h2 {{
    margin-top: 0;
    margin-bottom: 8px;
    font-size: 22px;
  }}
  .meta {{
    color: var(--muted);
    font-size: 14px;
    margin-top: 0;
    margin-bottom: 16px;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 18px;
  }}
  th {{
    text-align: left;
    font-weight: 600;
    padding: 6px 0;
    color: var(--muted);
    width: 45%;
  }}
  td {{
    padding: 6px 0;
  }}
  ul {{
    padding-left: 20px;
  }}
  .section-block {{
    margin-top: 16px;
  }}
  .section-block h3 {{
    margin-bottom: 8px;
    font-size: 18px;
  }}
  .tweet-list {{
    padding-left: 18px;
  }}
  .tweet-list li {{
    margin-bottom: 14px;
  }}
  .tweet-meta {{
    font-size: 13px;
    color: var(--muted);
  }}
  .tweet-text {{
    margin: 4px 0;
  }}
  .tweet-engagement {{
    font-size: 13px;
    color: var(--muted);
  }}
  .tweet-link a {{
    color: var(--accent);
    text-decoration: none;
  }}
  .tweet-link a:hover {{
    text-decoration: underline;
  }}
  .empty {{
    color: var(--muted);
  }}
</style>
</head>
<body>
  <div class=\"container\">
    <h1>Finance Twitter Report</h1>
    {overview_html}
    {accounts_html}
  </div>
</body>
</html>"""


def render_text(payload):
    lines = [
        f"Finance Twitter report covering the last {payload['windowHours']} hours",
        ''
    ]
    overview = payload['overview']
    lines.append('=== Run Overview ===')
    lines.append(f"Accounts: {overview['accounts']}")
    lines.append(f"Total tweets: {overview['totalTweets']}")
    lines.append(
        "Engagement totals - likes: "
        f"{overview['totalLikes']:,}, retweets: {overview['totalRetweets']:,},"
        f" replies: {overview['totalReplies']:,}"
    )
    if overview['earliestStart'] and overview['latestEnd']:
        lines.append(
            f"Overall window: {fmt_window(overview['earliestStart'])} to "
            f"{fmt_window(overview['latestEnd'])}"
        )
    lines.append('')

    for account in payload['accounts']:
        lines.append(f"=== @{account['username']} ===")
        lines.append(
            f"Window: {fmt_window(account['windowStart'])} to {fmt_window(account['windowEnd'])}"
        )
        m = account['metrics']
        lines.append(
            "Tweets collected: {} (originals: {}, replies: {}, retweets: {})".format(
                m['total'], m['originals'], m['replies'], m['retweets']
            )
        )
        lines.append(
            "Engagement totals - likes: {}, retweets: {}, replies: {}".format(
                fmt_number(m['likes']), fmt_number(m['engagementRetweets']), fmt_number(m['engagementReplies'])
            )
        )
        lines.append('AI Highlights:')
        summary_lines = account['aiSummary'].splitlines() if account['aiSummary'] else []
        if summary_lines:
            for item in summary_lines:
                wrapped = wrap(item.strip(), width=90)
                lines.append(indent('\n'.join(wrapped) or item, '  '))
        else:
            lines.append('  No highlights available.')

        if account['topTweets']:
            lines.append('Top tweets:')
            for idx, tweet in enumerate(account['topTweets'], 1):
                header = f"  {idx}. [{fmt_window(tweet['timestamp'])}] {tweet['text']}"
                lines.append(header)
                engagement = (
                    "    likes {} | retweets {} | replies {}".format(
                        fmt_number(tweet['likes']), fmt_number(tweet['retweets']), fmt_number(tweet['replies'])
                    )
                )
                lines.append(engagement)
                if tweet['url']:
                    lines.append(f"    link: {tweet['url']}")
        else:
            lines.append('Top tweets: none in this window.')
        lines.append('')

    return '\n'.join(lines).strip() + '\n'


def main():
    parser = argparse.ArgumentParser(description='Render finance report outputs.')
    parser.add_argument('--input', required=True, help='Path to JSON payload.')
    parser.add_argument('--html-output', required=True, help='Destination HTML file.')
    parser.add_argument('--text-output', required=True, help='Destination text file.')
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding='utf-8'))
    html_output = render_html(payload)
    text_output = render_text(payload)

    Path(args.html_output).write_text(html_output, encoding='utf-8')
    Path(args.text_output).write_text(text_output, encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Report renderer failed: {exc}', file=sys.stderr)
        sys.exit(1)
