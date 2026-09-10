import json, subprocess

def sb_dns(host):
    r = subprocess.run(['curl', '-s', '--max-time', '5',
        f'http://127.0.0.1:9090/dns/query?name={host}'],
        capture_output=True, text=True)
    return r.stdout

def doh_json(host, server='https://1.12.12.12/dns-query'):
    r = subprocess.run(['curl', '-s', '--max-time', '8',
        '-H', 'accept: application/dns-json', f'{server}?name={host}&type=A'],
        capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
        ans = [a.get('data') for a in d.get('Answer', [])]
        return ans
    except Exception as e:
        return f'ERR {e}: {r.stdout[:200]}'

for h in ['cf-no.nekohub.xyz', 'hkt1.nekohub.xyz', 'hkt2.nekohub.xyz']:
    print(f'===== {h} =====')
    print('sing-box /dns/query (truncated 900):')
    print(sb_dns(h)[:900])
    print()
    print('DoH JSON 1.12.12.12:', doh_json(h))
    print('DoH JSON doh.pub   :', doh_json(h, 'https://doh.pub/dns-query'))
    print()
