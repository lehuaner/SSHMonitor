import socket, struct, random, subprocess

def build_query(hostname):
    txid = random.randint(0, 0xFFFF)
    header = struct.pack('>HHHHHH', txid, 0x0100, 1, 0, 0, 0)
    qname = b''.join(bytes([len(p)]) + p.encode() for p in hostname.split('.')) + b'\x00'
    return header + qname + struct.pack('>HH', 1, 1)

def parse_answers(data):
    if len(data) < 12:
        return []
    _, _, qd, an, _, _ = struct.unpack('>HHHHHH', data[:12])
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
        rtype, _, _, rdlen = struct.unpack('>HHIH', data[idx:idx+10])
        idx += 10
        rdata = data[idx:idx+rdlen]
        idx += rdlen
        if rtype == 1 and rdlen == 4:
            answers.append('.'.join(str(b) for b in rdata))
    return answers

def wire_doh(url, host):
    q = build_query(host)
    try:
        r = subprocess.run(['curl', '-s', '--max-time', '8',
            '-H', 'Content-Type: application/dns-message',
            '--data-binary', '@-', url], input=q, capture_output=True)
        if not r.stdout:
            return f'ERR({r.returncode}) {r.stderr[:60]}'
        return parse_answers(r.stdout)
    except Exception as e:
        return f'EXC {e}'

def udp_dns(server, host, timeout=5):
    # plain UDP DNS query
    q = build_query(host)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(q, (server, 53))
        data, _ = s.recvfrom(2048)
        return parse_answers(data)
    except socket.timeout:
        return 'TIMEOUT'
    except Exception as e:
        return f'ERR {e}'

hosts = ['hkt1.nekohub.xyz', 'hkt2.nekohub.xyz', 'cf-no.nekohub.xyz']
print('===== IP-based DoH wire format =====')
for url in ['https://1.12.12.12/dns-query',
            'https://223.5.5.5/dns-query',
            'https://119.29.29.29/dns-query',
            'https://dns.alidns.com/dns-query']:
    print(f'--- {url}')
    for h in hosts:
        print(f'   {h}: {wire_doh(url, h)}')

print('===== Plain UDP DNS :53 =====')
for srv in ['223.5.5.5', '119.29.29.29', '114.114.114.114']:
    print(f'--- {srv}:53')
    for h in ['hkt1.nekohub.xyz', 'dns.alidns.com']:
        print(f'   {h}: {udp_dns(srv, h)}')
