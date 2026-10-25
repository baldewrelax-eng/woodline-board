#!/usr/bin/env python3
"""Provision Woodline using the owner's Supabase Management API token.
Only public browser configuration is written. No token, API secret or database
password is printed or committed. Uses HTTPS proxy settings through urllib.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.supabase.com/v1'
ROOT = Path(__file__).resolve().parent.parent
SITE = 'https://baldewrelax-eng.github.io/woodline-board/'


class Management:
    def __init__(self, token):
        self.token = token

    def request(self, path, method='GET', body=None):
        request = urllib.request.Request(API + path, method=method,
            headers={'Authorization': 'Bearer ' + self.token,
                     'Content-Type': 'application/json'},
            data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            # Error bodies may contain secrets echoed by the service. Do not log them.
            raise RuntimeError(f'Management API {method} {path}: HTTP {error.code}. '
                               'Check token permissions, organization quotas and network access.') from None


def provision(api, *, write_config=True, wait=time.sleep):
    orgs = api.request('/organizations')
    named = [org for org in orgs if org['name'] == 'Woodline Free']
    if len(named) > 1:
        raise RuntimeError('Multiple Woodline Free organizations found; choose the intended one explicitly before continuing.')
    org = named[0] if named else api.request('/organizations', 'POST', {'name': 'Woodline Free'})
    slug = org.get('slug') or org['id']
    details = api.request('/organizations/' + slug)
    if details.get('plan') != 'free':
        raise RuntimeError('Organization is not confirmed free. No project created, no billing plan changed.')
    projects = [p for p in api.request('/projects') if p.get('organization_id') == org['id'] and p['name'] == 'woodline-board']
    if len(projects) > 1:
        raise RuntimeError('Multiple matching projects; no project chosen automatically.')
    if projects:
        project = projects[0]
    else:
        project = api.request('/projects', 'POST', {
            'name': 'woodline-board', 'organization_slug': slug,
            'db_pass': secrets.token_urlsafe(40),
            'region_selection': {'type': 'smartGroup', 'code': 'emea'}
        })
        # Password is intentionally not retained; owner can reset it in Supabase.
    ref = project['id']
    for attempt in range(40):
        state = api.request('/projects/' + ref)
        if state.get('status') == 'ACTIVE_HEALTHY':
            break
        wait(3)
    else:
        raise RuntimeError('Project still provisioning. Rerun later; the existing project will be reused.')
    api.request('/projects/' + ref + '/database/query', 'POST',
                {'query': (ROOT / 'supabase/schema.sql').read_text(), 'read_only': False})
    # Verify the intended guardrails through the live database before publishing its configuration.
    checks = api.request('/projects/' + ref + '/database/query', 'POST', {'read_only': True, 'query': """
select (select relrowsecurity from pg_class where oid='public.woodline_boards'::regclass) as board_rls,
(select relrowsecurity from pg_class where oid='public.woodline_board_history'::regclass) as history_rls,
not has_table_privilege('anon','public.woodline_boards','SELECT') as anon_denied,
not has_table_privilege('authenticated','public.woodline_boards','UPDATE') as direct_write_denied;
"""})
    if not checks or not all(checks[0].get(k) is True for k in ['board_rls','history_rls','anon_denied','direct_write_denied']):
        raise RuntimeError('Live database guardrail check failed. Browser config was not published.')
    auth_path = '/projects/' + ref + '/config/auth'
    auth = api.request(auth_path)
    redirects = set(filter(None, (auth.get('uri_allow_list') or '').split(',')))
    redirects.add(SITE)
    api.request(auth_path, 'PATCH', {'site_url': SITE, 'uri_allow_list': ','.join(sorted(redirects))})
    keys = api.request('/projects/' + ref + '/api-keys')
    public = next((key.get('api_key') for key in keys if key.get('type') == 'publishable' and key.get('api_key')), None)
    if not public:
        public = next((key.get('api_key') for key in keys if key.get('name') == 'anon'), None)
    if not public or public.startswith('sb_secret_'):
        raise RuntimeError('Public browser key not found. No secret key will be used.')
    config = {'supabaseUrl': 'https://' + ref + '.supabase.co', 'supabaseAnonKey': public}
    if write_config:
        (ROOT / 'app-config.js').write_text('// Public configuration only; private data is protected by Auth and RLS.\nwindow.WOODLINE_CONFIG = ' + json.dumps(config, indent=2) + ';\n')
        subprocess.run(['node', str(ROOT/'scripts/update-shell-version.cjs')], check=True)
    return {'project': ref, 'organization': slug, 'site': SITE, 'schema_verified': True}


if __name__ == '__main__':
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        sys.exit('Missing SUPABASE_ACCESS_TOKEN. Add it securely in environment settings, not in chat or command arguments.')
    try:
        result = provision(Management(token))
        print(json.dumps(result, ensure_ascii=False))
        print('Public app configuration written. Commit and publish it; then verify signup and sign-in on the actual site.')
    except Exception as error:
        sys.exit(str(error))
