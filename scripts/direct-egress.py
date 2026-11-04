#!/usr/bin/env python3
"""Optional Linux CONNECT relay: real DNS and TCP pinned to one physical NIC.

No API credentials, TLS interception, remote proxy, or payload logging. Targets
must match HTTPS origins in the configured provider file. Python stdlib only.
"""
import argparse
import ipaddress
import json
import os
import secrets
import select
import socket
import socketserver
import struct
import threading
import time
from urllib.parse import urlsplit


def read_name(data, offset, seen=None):
    seen = set() if seen is None else seen
    labels = []
    end = None
    while True:
        if offset >= len(data) or offset in seen:
            raise ValueError('invalid_dns_name')
        seen.add(offset)
        length = data[offset]
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise ValueError('invalid_dns_pointer')
            pointer = ((length & 0x3F) << 8) | data[offset + 1]
            name, _ = read_name(data, pointer, seen)
            labels.append(name)
            end = offset + 2 if end is None else end
            break
        if length & 0xC0 or length > 63:
            raise ValueError('invalid_dns_label')
        offset += 1
        if not length:
            end = offset if end is None else end
            break
        if offset + length > len(data):
            raise ValueError('truncated_dns_name')
        labels.append(data[offset:offset + length].decode('ascii'))
        offset += length
    return '.'.join(labels).lower(), end


def decode_answer(data, transaction, hostname):
    if len(data) < 12:
        raise ValueError('short_dns_reply')
    ident, flags, questions, answers, _, _ = struct.unpack_from('!6H', data)
    if ident != transaction or questions != 1 or not flags & 0x8000 or flags & 0x7A0F:
        raise ValueError('invalid_dns_reply')
    offset = 12
    for _ in range(questions):
        question, offset = read_name(data, offset)
        if question != hostname.lower() or data[offset:offset + 4] != struct.pack('!HH', 1, 1):
            raise ValueError('dns_question_mismatch')
        offset += 4
    records = []
    for _ in range(answers):
        name, offset = read_name(data, offset)
        kind, klass, ttl, size = struct.unpack_from('!HHIH', data, offset)
        offset += 10
        if offset + size > len(data):
            raise ValueError('truncated_dns_record')
        value = socket.inet_ntoa(data[offset:offset + 4]) if kind == 1 and size == 4 else None
        if kind == 5:
            value, _ = read_name(data, offset)
        records.append((name, kind, klass, ttl, value))
        offset += size
    names = {hostname.lower()}
    for _ in range(8):
        for name, kind, klass, _, value in records:
            if name in names and kind == 5 and klass == 1 and value:
                names.add(value)
    addresses = [(value, ttl) for name, kind, klass, ttl, value in records
                 if name in names and kind == 1 and klass == 1 and value]
    if not addresses:
        raise ValueError('no_ipv4_answer')
    return list(dict.fromkeys(ip for ip, _ in addresses)), min(ttl for _, ttl in addresses)


class Resolver:
    def __init__(self, interface, dns_server):
        self.interface = interface
        self.dns_server = dns_server
        self.cache = {}
        self.lock = threading.Lock()

    def bind(self, sock):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, self.interface.encode() + b'\0')

    def resolve(self, hostname):
        try:
            return [str(ipaddress.IPv4Address(hostname))]
        except ValueError:
            pass
        with self.lock:
            cached = self.cache.get(hostname)
            if cached and cached[0] > time.monotonic():
                if cached[1] is None:
                    raise OSError('dns_temporarily_unavailable')
                return cached[1]
            ident = secrets.randbits(16)
            labels = hostname.encode('idna').split(b'.')
            if any(not label or len(label) > 63 for label in labels):
                raise ValueError('invalid_hostname')
            query = struct.pack('!6H', ident, 0x100, 1, 0, 0, 0)
            query += b''.join(bytes([len(label)]) + label for label in labels) + b'\0' + struct.pack('!HH', 1, 1)
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    self.bind(sock)
                    sock.settimeout(3)
                    sock.connect((self.dns_server, 53))
                    sock.send(query)
                    addresses, ttl = decode_answer(sock.recv(65535), ident, hostname)
            except (OSError, ValueError, UnicodeError, struct.error):
                # Bound DNS failure fan-out instead of serializing every caller
                # behind another full resolver timeout.
                self.cache[hostname] = (time.monotonic() + 1, None)
                raise
            self.cache[hostname] = (time.monotonic() + min(ttl, 300), addresses)
            return addresses

    def connect(self, hostname, port):
        last_error = None
        deadline = time.monotonic() + 8
        for address in self.resolve(hostname):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                self.bind(sock)
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                sock.settimeout(min(3, remaining))
                sock.connect((address, port))
                return sock
            except OSError as error:
                last_error = error
                sock.close()
        raise OSError('direct_connect_failed') from last_error


def forward(client, upstream, initial=b''):
    """Bounded full-duplex buffers; inactivity is shared across both directions."""
    client.setblocking(False)
    upstream.setblocking(False)
    peers = {client: upstream, upstream: client}
    buffers = {client: bytearray(), upstream: bytearray(initial)}
    last_activity = time.monotonic()
    ended = False
    while True:
        if ended and not any(buffers.values()):
            return
        if time.monotonic() - last_activity > 180:
            return
        readable = [] if ended else [s for s in peers if len(buffers[peers[s]]) < 65536]
        writable = [s for s in peers if buffers[s]]
        reads, writes, errors = select.select(readable, writable, list(peers), 1)
        if errors:
            return
        for sock in writes:
            try:
                sent = sock.send(buffers[sock])
                if not sent:
                    return
                del buffers[sock][:sent]
                last_activity = time.monotonic()
            except BlockingIOError:
                pass
        for sock in reads:
            try:
                data = sock.recv(min(65536 - len(buffers[peers[sock]]), 65536))
                if not data:
                    if sock is client:
                        return
                    ended = True
                    break
                buffers[peers[sock]].extend(data)
                last_activity = time.monotonic()
            except BlockingIOError:
                pass


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        established = False
        try:
            self.request.settimeout(5)
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            data = bytearray()
            header_deadline = time.monotonic() + 5
            while b'\r\n\r\n' not in data:
                remaining = header_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('connect_headers_timeout')
                self.request.settimeout(remaining)
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                data.extend(chunk)
                if len(data) > 16384:
                    raise ValueError('headers_too_large')
            head, initial = bytes(data).split(b'\r\n\r\n', 1)
            method, authority, version = head.split(b'\r\n', 1)[0].decode('ascii').split(' ')
            host, separator, port = authority.rpartition(':')
            if method != 'CONNECT' or version != 'HTTP/1.1' or not separator:
                raise ValueError('connect_required')
            target = (host.lower(), int(port))
            if target not in self.server.allowed:
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                return
            upstream = self.server.resolver.connect(*target)
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            established = True
            forward(self.request, upstream, initial)
        except (OSError, ValueError, UnicodeError, struct.error):
            if not established:
                try:
                    self.request.sendall(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                except OSError:
                    pass
        finally:
            if upstream:
                upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--dns-server', required=True)
    parser.add_argument('--providers-file', default='providers.json')
    parser.add_argument('--port', type=int, default=39081)
    args = parser.parse_args()
    if not hasattr(socket, 'SO_BINDTODEVICE'):
        parser.error('physical interface binding requires Linux')
    socket.if_nametoindex(args.interface)
    ipaddress.IPv4Address(args.dns_server)
    with open(args.providers_file, encoding='utf-8') as stream:
        providers = json.load(stream)['providers']
    allowed = set()
    for provider in providers:
        origin = urlsplit(provider['origin'])
        if provider.get('enabled', True) and origin.scheme == 'https':
            allowed.add((origin.hostname.lower(), origin.port or 443))
    with Server(('127.0.0.1', args.port), Handler) as server:
        server.allowed = allowed
        server.resolver = Resolver(args.interface, args.dns_server)
        print(json.dumps({'event': 'direct_egress_ready', 'interface': args.interface,
                          'dns_server': args.dns_server, 'port': args.port,
                          'allowed_origins': len(allowed)}), flush=True)
        notify = os.environ.get('NOTIFY_SOCKET')
        if notify:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as status:
                status.connect('\0' + notify[1:] if notify.startswith('@') else notify)
                status.sendall(b'READY=1')
        server.serve_forever()


if __name__ == '__main__':
    main()
