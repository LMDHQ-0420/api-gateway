import importlib.util
from pathlib import Path
import socket
import struct
import threading
import unittest
from unittest.mock import MagicMock, patch
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location('direct_egress', Path(__file__).parents[1] / 'scripts/direct-egress.py')
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


def packet(transaction=42, flags=0x8180, address='39.106.105.100', hostname='open.bigmodel.cn'):
    question = b''.join(bytes([len(label)]) + label.encode() for label in hostname.split('.')) + b'\0' + struct.pack('!HH', 1, 1)
    answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 5, 4) + socket.inet_aton(address)
    return struct.pack('!6H', transaction, flags, 1, 1, 0, 0) + question + answer


class DirectEgressTests(unittest.TestCase):
    def test_dns_ipv4_ttl_and_compression(self):
        self.assertEqual(egress.decode_answer(packet(), 42, 'open.bigmodel.cn'), (['39.106.105.100'], 5))

    def test_dns_rejects_other_transaction_truncation_errors_and_names(self):
        for data, ident, name in [(packet(), 43, 'open.bigmodel.cn'),
                                  (packet(flags=0x8380), 42, 'open.bigmodel.cn'),
                                  (packet(flags=0x8183), 42, 'open.bigmodel.cn'),
                                  (packet(), 42, 'other.test'),
                                  (packet()[:-1], 42, 'open.bigmodel.cn')]:
            with self.assertRaises((ValueError, struct.error)):
                egress.decode_answer(data, ident, name)

    def test_dns_pointer_cycle_rejected(self):
        with self.assertRaises(ValueError):
            egress.read_name(b'\xc0\x00', 0)

    def test_interface_binding_literal_connection(self):
        resolver = egress.Resolver('eth-test', '127.0.0.1')
        with patch.object(egress.socket, 'socket') as constructor:
            sock = constructor.return_value
            self.assertIs(resolver.connect('127.0.0.1', 443), sock)
            sock.setsockopt.assert_any_call(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b'eth-test\0')
            sock.connect.assert_called_once_with(('127.0.0.1', 443))

    def test_dns_failure_is_temporarily_cached(self):
        resolver = egress.Resolver('eth-test', '127.0.0.1')
        with patch.object(egress.socket, 'socket') as constructor:
            constructor.return_value.__enter__.return_value.recv.side_effect = OSError('test dns failure')
            for _ in range(2):
                with self.assertRaises(OSError):
                    resolver.resolve('open.bigmodel.cn')
            self.assertEqual(constructor.call_count, 1)

    def test_dns_slow_provider_does_not_block_another_provider(self):
        resolver = egress.Resolver('eth-test', '127.0.0.1')
        entered, release = threading.Event(), threading.Event()
        def make_socket(*_args):
            context = MagicMock()
            sock = context.__enter__.return_value
            def answer(_size):
                query = sock.send.call_args.args[0]
                hostname, _ = egress.read_name(query, 12)
                if hostname == 'slow.test':
                    entered.set()
                    if not release.wait(2):
                        raise OSError('test lookup not released')
                return packet(transaction=struct.unpack_from('!H', query)[0], hostname=hostname)
            sock.recv.side_effect = answer
            return context
        with patch.object(egress.socket, 'socket', side_effect=make_socket) as constructor:
            with ThreadPoolExecutor(max_workers=2) as pool:
                slow = pool.submit(resolver.resolve, 'slow.test')
                self.assertTrue(entered.wait(1))
                try:
                    fast = pool.submit(resolver.resolve, 'fast.test')
                    self.assertEqual(fast.result(timeout=1), ['39.106.105.100'])
                    self.assertEqual(resolver.resolve('fast.test'), ['39.106.105.100'])
                finally:
                    release.set()
                self.assertEqual(slow.result(timeout=1), ['39.106.105.100'])
            self.assertEqual(constructor.call_count, 2)

    def test_simultaneous_same_host_lookups_share_one_dns_query(self):
        resolver = egress.Resolver('eth-test', '127.0.0.1')
        entered, release = threading.Event(), threading.Event()
        with patch.object(egress.socket, 'socket') as constructor:
            sock = constructor.return_value.__enter__.return_value
            def answer(_size):
                entered.set()
                if not release.wait(2):
                    raise OSError('test lookup not released')
                query = sock.send.call_args.args[0]
                return packet(transaction=struct.unpack_from('!H', query)[0])
            sock.recv.side_effect = answer
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = [pool.submit(resolver.resolve, 'open.bigmodel.cn') for _ in range(8)]
                try:
                    self.assertTrue(entered.wait(1))
                finally:
                    release.set()
                for future in futures:
                    self.assertEqual(future.result(timeout=1), ['39.106.105.100'])
            self.assertEqual(constructor.call_count, 1)

    def test_forward_preserves_large_binary_bytes_and_fin(self):
        client, bridge_client = socket.socketpair()
        bridge_upstream, upstream = socket.socketpair()
        for sock in [client, bridge_client, bridge_upstream, upstream]:
            self.addCleanup(sock.close)
            sock.settimeout(3)
        def bridge():
            try:
                egress.forward(bridge_client, bridge_upstream)
            finally:
                bridge_client.close()
                bridge_upstream.close()
        worker = threading.Thread(target=bridge, daemon=True)
        worker.start()
        payload = bytes(range(256)) * 1024
        sent = threading.Thread(target=lambda: upstream.sendall(payload), daemon=True)
        sent.start()
        data = bytearray()
        while len(data) < len(payload):
            data.extend(client.recv(65536))
        self.assertEqual(bytes(data), payload)
        upstream.shutdown(socket.SHUT_WR)
        self.assertEqual(client.recv(1), b'')
        worker.join(3)
        self.assertFalse(worker.is_alive())

    def test_connect_allowlist_and_opaque_bytes(self):
        origin = socket.socket()
        self.addCleanup(origin.close)
        origin.bind(('127.0.0.1', 0))
        origin.listen()
        port = origin.getsockname()[1]
        relay = egress.Server(('127.0.0.1', 0), egress.Handler)
        self.addCleanup(relay.server_close)
        relay.allowed = {('127.0.0.1', port)}
        relay.resolver = egress.Resolver('lo', '127.0.0.1')
        # WSL mirrored localhost uses a virtual interface; exercise the relay
        # on loopback while separately asserting device binding above.
        relay.resolver.bind = lambda _sock: None
        worker = threading.Thread(target=relay.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(relay.shutdown)
        with socket.create_connection(relay.server_address, timeout=3) as client:
            client.sendall(b'CONNECT disallowed.test:443 HTTP/1.1\r\nHost: disallowed.test\r\n\r\n')
            self.assertIn(b'403 Forbidden', client.recv(4096))
        with socket.create_connection(relay.server_address, timeout=3) as client:
            request = f'CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'.encode()
            client.sendall(request)
            self.assertIn(b'200 Connection Established', client.recv(4096))
            remote, _ = origin.accept()
            with remote:
                client.sendall(b'opaque-tls-like-bytes\x00\xff')
                self.assertEqual(remote.recv(4096), b'opaque-tls-like-bytes\x00\xff')
                remote.sendall(b'response\x00\xff')
                self.assertEqual(client.recv(4096), b'response\x00\xff')


if __name__ == '__main__':
    unittest.main()
