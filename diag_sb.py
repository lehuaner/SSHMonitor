import sys, json, socket

def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

c = load('/data/data/com.termux/files/home/sb-config.json')

print('=== DNS Servers ===')
for s in c.get('dns', {}).get('servers', []):
    print(json.dumps(s, indent=2))
print('=== DNS Strategy ===', c.get('dns', {}).get('strategy', 'default'))
print('=== DNS Final ===', c.get('dns', {}).get('final', 'default'))
print('=== DNS Rules ===')
for r in c.get('dns', {}).get('rules', []):
    print(json.dumps(r, indent=2))

print('=== Route Rules ===')
for r in c.get('route', {}).get('rules', []):
    print(json.dumps(r, indent=2))

print('=== outbound types ===')
from collections import Counter
cnt = Counter(o.get('type') for o in c.get('outbounds', []))
print(cnt)

print('=== sample outbounds ===')
outs = c.get('outbounds', [])
for o in outs:
    t = o.get('type')
    if t in ('vless', 'hysteria2', 'vmess', 'trojan'):
        if t == 'hysteria2':
            print(o.get('tag'), '| server:', o.get('server'), '| port:', o.get('server_port'))
        else:
            tlssn = o.get('tls', {}).get('server_name', '') if isinstance(o.get('tls'), dict) else ''
            print(o.get('tag'), '| server:', o.get('server'), '| port:', o.get('server_port'), '| sni:', tlssn)
