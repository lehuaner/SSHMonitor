import json, shutil, subprocess, time

CFG = '/data/data/com.termux/files/home/sb-config.json'
BAK = '/data/data/com.termux/files/home/sb-config.json.bak_dnsfix3'

shutil.copy(CFG, BAK)
with open(CFG, 'r', encoding='utf-8') as f:
    c = json.load(f)

dns = c['dns']

# 1. dns server: 改回 dns.alidns.com (用户要求"改回来"), detour=direct
# 2. local server: 加 detour=direct (治本: 防止 UDP DNS 查询被路由回 sing-box 形成 loopback)
for s in dns['servers']:
    if s['tag'] == 'dns':
        s['address'] = 'https://dns.alidns.com/dns-query'
        s['detour'] = 'direct'
        print('dns server ->', s['address'])
    elif s['tag'] == 'local':
        s['detour'] = 'direct'
        print('local server ->', s['address'], 'detour=direct')

# 3. 新订阅专线节点域名加入 DNS rules -> 走 dns DoH
suffixes = ['.byteprivatelink.com', '.smartprivatelink.com']
found = False
for r in dns.get('rules', []):
    if r.get('server') == 'dns' and 'domain_suffix' in r:
        r['domain_suffix'] = list(dict.fromkeys(r['domain_suffix'] + suffixes))
        found = True
if not found:
    dns['rules'].append({'domain_suffix': suffixes, 'server': 'dns'})
print('dns rules suffixes now:', [x for r in dns.get('rules', []) if r.get('server')=='dns' for x in r.get('domain_suffix', [])])

with open(CFG, 'w', encoding='utf-8') as f:
    json.dump(c, f, ensure_ascii=False, indent=2)
json.load(open(CFG, 'r', encoding='utf-8'))
print('config saved & valid')

# restart via sv full path
r = subprocess.run(['sv', '-w', '60', 'restart', '/data/data/com.termux/files/usr/var/service/sing-box'], capture_output=True, text=True)
print('sv restart rc=', r.returncode, r.stdout[:120], r.stderr[:120])
time.sleep(6)
r = subprocess.run(['pgrep', '-f', 'sing-box run'], capture_output=True, text=True)
print('sing-box procs:', r.stdout.strip())
