# Check if sing-box can resolve DNS internally
# The issue: DNS rule routes .nekohub.xyz to DoH (1.12.12.12, detour:direct)
# But sing-box returns "lookup ... empty result"

import json

with open('/data/data/com.termux/files/home/sb-config.json') as f:
    c = json.load(f)

# Check DNS detailed config
dns = c.get('dns', {})

# Check if the DNS server is reachable directly
import subprocess
r = subprocess.run(['curl', '-s', '--max-time', '10', 
    '-H', 'accept: application/dns-json',
    'https://1.12.12.12/dns-query?name=cf-no.nekohub.xyz&type=A'],
    capture_output=True, text=True)
print('=== DoH test (direct) ===')
print(r.stdout[:500])

# Check if local DNS works
import socket
try:
    ip = socket.getaddrinfo('cf-no.nekohub.xyz', None, socket.AF_INET)[0][4][0]
    print(f'=== system DNS works: {ip} ===')
except Exception as e:
    print(f'system DNS: {e}')

# Test sing-box DNS via its API
# sing-box has a DNS API endpoint
r2 = subprocess.run(['curl', '-s', '--max-time', '5',
    'http://127.0.0.1:9090/dns/query?name=cf-no.nekohub.xyz'],
    capture_output=True, text=True)
print('=== sing-box API /dns/query ===')
print(r2.stdout[:500])
print(f'stderr: {r2.stderr[:200]}')
print(f'rc: {r2.returncode}')

# Check the Sniff config
print('=== inbounds sniff ===')
for ib in c.get('inbounds', []):
    print(ib.get('tag', 'NO TAG'), 'sniff:', ib.get('sniff', 'NOT SET'), 'sniff_override_destination:', ib.get('sniff_override_destination', 'NOT SET'))

# Check route DNS rules
print('=== route rules ===')
for r in c.get('route', {}).get('rules', []):
    print(json.dumps(r, indent=2))