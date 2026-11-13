#!/usr/bin/env python3
"""Add (or finish) a proxy host + Let's Encrypt certificate in Nginx Proxy Manager.

Runs ON the server (NPM admin API at http://127.0.0.1:81), called by deploy.sh:
    printf 'email\npassword\n' | python3 npm_proxy.py DOMAIN FORWARD_HOST FORWARD_PORT
Login details come on stdin so they never appear in the process list. Safe to run again.
"""
import json
import sys
import urllib.error
import urllib.request

import os
API = os.environ.get('NPM_API', 'http://127.0.0.1:81/api')
domain, fwd_host, fwd_port = sys.argv[1], sys.argv[2], int(sys.argv[3])
user = sys.stdin.readline().strip()
password = sys.stdin.readline().rstrip('\n')


class ApiError(Exception):
    pass


def call(method, path, body=None, token=None, timeout=30):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='replace')
        try:
            msg = json.loads(msg)['error']['message']
        except Exception:
            pass
        raise ApiError(f'{method} {path} → {e.code}: {msg}')


try:
    token = call('POST', '/tokens', {'identity': user, 'secret': password})['token']
except ApiError as e:
    sys.exit(f'Login to Nginx Proxy Manager failed ({e}). Check the email/password you use at :81.')
except Exception as e:
    sys.exit(f'Cannot reach Nginx Proxy Manager on 127.0.0.1:81 ({e}).')

# 1) proxy host
hosts = call('GET', '/nginx/proxy-hosts', token=token)
host = next((h for h in hosts if domain in h.get('domain_names', [])), None)
if host:
    print(f'Proxy host for {domain} already exists (id {host["id"]}).')
else:
    host = call('POST', '/nginx/proxy-hosts', {
        'domain_names': [domain],
        'forward_scheme': 'http',
        'forward_host': fwd_host,
        'forward_port': fwd_port,
        'access_list_id': 0,
        'certificate_id': 0,
        'ssl_forced': False,
        'http2_support': False,
        'hsts_enabled': False,
        'hsts_subdomains': False,
        'block_exploits': True,
        'caching_enabled': False,          # never cache sw.js / index.html
        'allow_websocket_upgrade': True,
        'advanced_config': '',
        'locations': [],
        'meta': {},
    }, token=token)
    print(f'Created proxy host {domain} → http://{fwd_host}:{fwd_port} (id {host["id"]}).')

if host.get('certificate_id'):
    print('It already has an SSL certificate.')
    sys.exit(0)

# 2) Let's Encrypt certificate (reuse an existing certificate for this domain if there is one)
certs = call('GET', '/nginx/certificates', token=token)
cert = next((c for c in certs if domain in c.get('domain_names', [])), None)
if not cert:
    # Use the same Let's Encrypt email as the certificates already on this server, else the login email
    email = next((c.get('meta', {}).get('letsencrypt_email') for c in certs
                  if c.get('provider') == 'letsencrypt' and c.get('meta', {}).get('letsencrypt_email')), None) or user
    print(f"Requesting a Let's Encrypt certificate for {domain} (takes up to a minute)...")
    body = {
        'provider': 'letsencrypt',
        'nice_name': domain,
        'domain_names': [domain],
        'meta': {'letsencrypt_email': email, 'letsencrypt_agree': True, 'dns_challenge': False},
    }
    try:
        cert = call('POST', '/nginx/certificates', body, token=token, timeout=300)
    except ApiError as e:
        if 'additional' in str(e).lower() or 'email' in str(e).lower():
            body['meta'].pop('letsencrypt_email')   # newer NPM versions take the email elsewhere
            cert = call('POST', '/nginx/certificates', body, token=token, timeout=300)
        else:
            sys.exit(f'Certificate request failed: {e}\n'
                     f'The site works on http://{domain} meanwhile; you can retry from the NPM SSL tab.')

# 3) attach it and force HTTPS
call('PUT', f'/nginx/proxy-hosts/{host["id"]}', {
    'certificate_id': cert['id'],
    'ssl_forced': True,
    'http2_support': True,
}, token=token)
print(f'SSL enabled: https://{domain}')
