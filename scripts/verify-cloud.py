#!/usr/bin/env python3
"""Read-only live checks using the public browser key. No account or data writes."""
import json
from pathlib import Path
import re
import sys
import urllib.request
import urllib.error

config = (Path(__file__).resolve().parent.parent / 'app-config.js').read_text()
url = re.search(r'supabaseUrl:\s*"([^"]+)"', config).group(1)
key = re.search(r'supabaseAnonKey:\s*"([^"]+)"', config).group(1)
if not key.startswith('sb_publishable_') or not url.startswith('https://'):
    sys.exit('Public cloud configuration is missing or invalid.')


def get(path):
    req = urllib.request.Request(url + path, headers={'apikey': key, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read())
        except ValueError:
            body = {}
        return error.code, body


try:
    status, data = get('/auth/v1/settings')
    if status != 200 or not isinstance(data, dict):
        sys.exit(f'FAIL Auth settings: HTTP {status}. Check the public project URL/key.')
    print('PASS public project key and Auth endpoint')
    for table in ['woodline_boards', 'woodline_board_history']:
        status, data = get('/rest/v1/' + table + '?select=revision&limit=1')
        # SQL explicitly revokes anon SELECT. Invalid keys and missing schema must not pass.
        if status not in [401, 403] or not isinstance(data, dict) or data.get('code') != '42501':
            code = data.get('code', 'none') if isinstance(data, dict) else 'unexpected data'
            sys.exit(f'FAIL anonymous guard for {table}: HTTP {status}, code {code}. No board data is printed.')
        print(f'PASS {table}: anonymous SELECT denied by database permissions')
    print('Read-only live checks passed. Authenticated account sync and email redirects require separate verification.')
except (urllib.error.URLError, TimeoutError) as error:
    sys.exit('Network check failed: ' + str(error))
