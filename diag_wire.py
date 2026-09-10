import socket, struct, random, json, subprocess

# Craft a binary DNS query (wire format) for a hostname
def build_query(hostname):
    txid = random.randint(0, 0xFFFF)
    header = struct.pack('>HHHHHH', txid, 0x0100, 1, 0, 0, 0)
    qname = b''.join(bytes([len(p)]) + p.encode() for p in hostname.split('.')) + b'\x00'
    question = qname + struct.pack('>HH', 1, 1)  # A, IN
    return txid, header + question

def parse_answers(data):
    if len(data) < 12:
        return ('short', data)
    txid, flags, qd, an, ns, ar = struct.unpack('>HHHHHH', data[:12])
    if flags & 0x8000 == 0:
        return ('no-flag', None)
    # skip question
    idx = 12
    for _ in range(qd):
        while idx < len(data) and data[idx] != 0:
            idx += 1
        idx += 5
    answers = []
    def read_name(i):
        labels = []
        while True:
            if i >= len(data):
                return None, i
            l = data[i]
            if l == 0:
                i += 1
                break
            if l & 0xC0 == 0xC0:
                i += 2
                break
            i += 1
            labels.append(data[i:i+l].decode('latin1'))
            i += l
        return '.'.join(labels), i
    for _ in range(an):
        name, i = read_name(idx)
        if i is None:
            break
        rtype, rclass, ttl, rdlen = struct.unpack('>HHIH', data[i:i+10])
        i += 10
        rdata = data[i:i+rdlen]
        i += rdlen
        if rtype == 1 and rdlen == 4:
            answers.append('.'.join(str(b) for b in rdata))
        else:
            answers.append(f'type{rtype}:{rdata.hex()}')
        idx = i
    return ('ok', answers)

for host in ['hkt1.nekohub.xyz', 'hkt2.nekohub.xyz', 'cf-no.nekohub.xyz']:
    txid, q = build_query(host)
    # POST wire format to 1.12.12.12/dns-query
    r = subprocess.run(['curl', '-s', '--max-time', '8',
        '-H', 'Content-Type: application/dns-message',
        '--data-binary', '@-', 'https://1.12.12.12/dns-query'],
        input=q, capture_output=True)
    print(f'{host}: rc={r.returncode} len={len(r.stdout)}')
    if r.stdout:
        status, ans = parse_answers(r.stdout)
        print(f'  parsed: {status} answers={ans}')
        print(f'  raw[:80]: {r.stdout[:80]!r}')
    else:
        print(f'  stderr: {r.stderr[:200]}')
