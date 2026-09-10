import json, shutil, time, subprocess

CFG = '/data/data/com.termux/files/home/sb-config.json'
BAK = '/data/data/com.termux/files/home/sb-config.json.bak_dnsfix2'
OLD = 'https://dns.alidns.com/dns-query'
NEW = 'https://223.5.5.5/dns-query'

# 1. backup
shutil.copy(CFG, BAK)
print('backup ->', BAK)

# 2. read + fix dns server address
with open(CFG, 'r', encoding='utf-8') as f:
    c = json.load(f)

changed = False
for s in c.get('dns', {}).get('servers', []):
    if s.get('address') == OLD:
        s['address'] = NEW
        s['detour'] = 'direct'   # ensure IP-based DoH goes direct (no proxy loop)
        changed = True
        print('fixed server tag:', s.get('tag'), '|', OLD, '->', NEW, '| detour=direct')

if not changed:
    print('WARN: target address not found. current servers:')
    for s in c.get('dns', {}).get('servers', []):
        print('  ', s.get('tag'), s.get('address'), 'detour=', s.get('detour'))

with open(CFG, 'w', encoding='utf-8') as f:
    json.dump(c, f, ensure_ascii=False, indent=2)
print('config saved.')

# 3. validate json
with open(CFG, 'r', encoding='utf-8') as f:
    json.load(f)
print('config JSON valid.')

# 4. restart sing-box (via runsv controlled service)
print('restarting sing-box...')
r = subprocess.run(['sv', 'restart', 'sing-box'], capture_output=True, text=True)
print('sv restart rc=', r.returncode, r.stdout[:200], r.stderr[:200])
time.sleep(6)

# 5. verify process
r = subprocess.run(['pgrep', '-f', 'sing-box run'], capture_output=True, text=True)
print('sing-box procs:', r.stdout.strip())
