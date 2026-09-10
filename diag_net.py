import socket, subprocess

def resolve(host):
    try:
        return socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
    except Exception as e:
        return f'ERR {e}'

hosts = ['cf-no.nekohub.xyz', 'hkt1.nekohub.xyz', 'hkt2.nekohub.xyz', 'aws-sg1.nekohub.xyz']
print('=== system DNS resolution ===')
for h in hosts:
    print(h, '->', resolve(h))

def tcp_test(host, port, timeout=6):
    try:
        ip = resolve(host)
        s = socket.create_connection((ip, port), timeout=timeout)
        s.close()
        return f'TCP {host}:{port} -> OK'
    except Exception as e:
        return f'TCP {host}:{port} -> FAIL {e}'

print('=== TCP tests (vless endpoints) ===')
print(tcp_test('cf-no.nekohub.xyz', 443))
print(tcp_test('cf-no.nekohub.xyz', 8443))
print(tcp_test('hkt1.nekohub.xyz', 443))
print(tcp_test('aws-sg1.nekohub.xyz', 443))

print('=== UDP test via python (hysteria2) ===')
import time
def udp_test(host, port, timeout=6):
    try:
        ip = resolve(host)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        # send a hysteria2 client hello-ish probe (just any UDP bytes)
        s.sendto(b'ping probe', (ip, port))
        try:
            data, _ = s.recvfrom(1024)
            return f'UDP {host}:{port} -> GOT REPLY {data[:16]!r}'
        except socket.timeout:
            return f'UDP {host}:{port} -> NO REPLY (timeout)'
        except ConnectionRefusedError:
            return f'UDP {host}:{port} -> CONNECTION REFUSED'
        except Exception as e:
            return f'UDP {host}:{port} -> ERR {e}'
    except Exception as e:
        return f'UDP {host}:{port} -> RESOLVE FAIL {e}'

for hp in [('hkt1.nekohub.xyz', 20006), ('hkt2.nekohub.xyz', 20005), ('hkt1.nekohub.xyz', 20005), ('hkt2.nekohub.xyz', 20006)]:
    print(udp_test(*hp))
