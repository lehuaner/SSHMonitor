import socket, struct, random, subprocess

def build_query(hostname):
    txid = random.randint(0, 0xFFFF)
    header = struct.pack('>HHHHHH', txid, 0x0100, 1, 0, 0, 0)
    qname = b''.join(bytes([len(p)]) + p.encode() for p in hostname.split('.')) + b'\x00'
    question = qname + struct.pack('>HH', 1, 1)
    return header + question

def parse_answers(data):
    if len(data) < 12:
        return ('short', [])
    txid, flags, qd, an, ns, ar = struct.unpack('>HHHHHH', data[:12])
    idx = 12
    for _ in range(qd):
        while idx < len(data) and data[idx] != 0:
            idx += 1
        idx += 5
    answers = []
    def read_name(i):
        while True:
            if i >= len(data):
                return i
            l = data[i]
            if l == 0:
                return i + 1
            if l & 0xC0 == 0xC0:
                return i + 2
            i += 1 + l
    for _ in range(an):
        idx = read_name(idx)
        if idx is None or idx + 10 > len(data):
            break
        rtype, rclass, ttl, rdlen = struct.unpack('>HHIH', data[idx:idx+10])
        idx += 10
        rdata = data[idx:idx+rdlen]
        idx += rdlen
        if rtype == 1 and rdlen == 4:
            answers.append('.'.join(str(b) for b in rdata))
    return ('ok', answers)

def wire_doh(url, host):
    q = build_query(host)
    r = subprocess.run(['curl', '-s', '--max-time', '8',
        '-H', 'Content-Type: application/dns-message',
        '--data-binary', '@-', url],
        input=q, capture_output=True)
    if not r.stdout:
        return f'ERR {r.stderr[:80]}'
    status, ans = parse_answers(r.stdout)
    return f'{status} ans={ans}'

hosts = ['hkt1.nekohub.xyz', 'hkt2.nekohub.xyz', 'cf-no.nekohub.xyz']
servers = {
    '1.12.12.12 (Ali IP)': 'https://1.12.12.12/dns-query',
    'dns.alidns.com': 'https://dns.alidns.com/dns-query',
    'doh.pub (Tencent)': 'https://doh.pub/dns-query',
    'dns.google': 'https://dns.google/dns-query',
    '1.1.1.1 (CF)': 'https://1.1.1.1/dns-query',
}

for sname, surl in servers.items():
    print(f'===== {sname} ({surl}) =====')
    for h in hosts:
        print(f'  {h}: {wire_doh(surl, h)}')
    print()

# UDP test to the CORRECT current IPs for hysteria2
print('===== UDP tests to CORRECT current IPs =====')
def udp_test(ip, port, timeout=6):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    s.sendto(b'ping probe', (ip, port))
    try:
        data, _ = s.recvfrom(1024)
        return f'GOT REPLY {data[:20]!r}'
    except socket.timeout:
        return 'NO REPLY (timeout)'
    except ConnectionRefusedError:
        return 'CONNECTION REFUSED'
    except Exception as e:
        return f'ERR {e}'

for ip, port in [('58.152.130.173', 20006), ('58.152.130.173', 20005),
                 ('112.120.213.169', 20005), ('112.120.213.169', 20006)]:
    print(f'UDP {ip}:{port} -> {udp_test(ip, port)}')

print('===== TCP to correct IPs (hysteria2 uses UDP only, but check TCP alt) =====')
for ip, port in [('58.152.130.173', 443), ('112.120.213.169', 443)]:
    try:
        s = socket.create_connection((ip, port), timeout=6)
        s.close()
        print(f'TCP {ip}:{port} -> OK')
    except Exception as e:
        print(f'TCP {ip}:{port} -> FAIL {e}')
