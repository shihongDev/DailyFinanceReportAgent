#!/usr/bin/env python3
"""Generate AI summary text using Google Generative Language REST API."""
import argparse
import json
import os
import sys
from pathlib import Path

import requests


def main() -> None:
    parser = argparse.ArgumentParser(description="Call Gemini to produce a summary")
    parser.add_argument('--input', required=True, help='Path to JSON payload file')
    args = parser.parse_args()

    api_key = os.getenv('GOOGLE_AI_API_KEY')
    if not api_key:
        raise SystemExit('GOOGLE_AI_API_KEY environment variable is required')

    data = json.loads(Path(args.input).read_text(encoding='utf-8'))
    model = data.get('model') or 'gemini-1.5-pro-latest'
    prompt = data.get('prompt')
    if not prompt:
        raise SystemExit('Payload missing "prompt" field')

    endpoint = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'

    response = requests.post(
        endpoint,
        params={'key': api_key},
        json={
            'contents': [
                {
                    'role': 'user',
                    'parts': [{'text': prompt}],
                }
            ]
        },
        timeout=60,
    )
    response.raise_for_status()

    payload = response.json()
    candidates = payload.get('candidates') or []
    if not candidates:
        raise RuntimeError('No candidates returned by Gemini API')

    parts = candidates[0].get('content', {}).get('parts', [])
    output = ''.join(part.get('text', '') for part in parts).strip()
    if not output:
        raise RuntimeError('Gemini response contained no text')

    print(output)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f'AI summary renderer failed: {exc}', file=sys.stderr)
        sys.exit(1)
