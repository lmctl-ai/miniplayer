"""Exercise real terminal input using acknowledgements, never startup sleeps."""
import errno
import fcntl
import os
import pty
import select
import subprocess
import sys
import termios
import time

PHASE_TIMEOUT = 20


def own_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def run():
    mode, node, cli, config, catalog, port = sys.argv[1:]
    master, slave = pty.openpty()
    env = dict(os.environ, MINIPLAYER_CONFIG=config)
    model = 'mock/Echo'
    if mode == 'turn':
        model = 'ollama/qwen2.5:14b'
        env.update(MINIPLAYER_CATALOG=catalog, OLLAMA_HOST=f'http://127.0.0.1:{port}')
    proc = subprocess.Popen(
        [node, cli, 'chat', '-m', model, '--no-wrapup', '--no-context-files'],
        stdin=slave, stdout=slave, stderr=slave, env=env,
        close_fds=True, preexec_fn=own_terminal)
    os.close(slave)
    output = bytearray()

    def wait_for(predicate, phase, notification=False):
        deadline = time.monotonic() + PHASE_TIMEOUT
        while not predicate():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'{phase}; output={bytes(output)!r}')
            readers = [master, 3] if notification else [master]
            ready, _, _ = select.select(readers, [], [], remaining)
            if notification and 3 in ready:
                if os.read(3, 1) != b'R':
                    raise RuntimeError('server readiness pipe closed without a request')
                return
            if master in ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as err:
                    if err.errno != errno.EIO:
                        raise
                    chunk = b''
                if not chunk:
                    raise RuntimeError(f'PTY closed during {phase}; output={bytes(output)!r}')
                output.extend(chunk)

    try:
        wait_for(lambda: b'> ' in output, 'initial prompt')
        # Prompt bytes only prove output readiness. Require a complete input/output
        # round trip before injecting a control character, on the real raw terminal.
        start = len(output)
        os.write(master, b'/help\n')
        wait_for(lambda: b'Show this help' in output[start:] and
                 b'> ' in output[start:].split(b'Show this help', 1)[1],
                 'REPL input readiness (/help acknowledgement)')
        flags = termios.tcgetattr(master)[3]
        if flags & (termios.ICANON | termios.ISIG):
            raise RuntimeError(f'REPL acknowledged input without raw mode: lflag={flags}')

        if mode == 'turn':
            os.write(master, b'hello slow turn\n')
            wait_for(lambda: False, 'HTTP request readiness', notification=True)
        start = len(output)
        os.write(master, b'\x03')
        if mode == 'turn':
            wait_for(lambda: b'turn cancelled' in output[start:] and
                     b'> ' in output[start:].split(b'turn cancelled', 1)[1],
                     'cancellation and returned prompt')
            os.write(master, b'/exit\n')
        # Continue draining the PTY while waiting for exit (including EOF/EIO on macOS).
        deadline = time.monotonic() + PHASE_TIMEOUT
        while proc.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'{mode} PTY exit; output={bytes(output)!r}')
            ready, _, _ = select.select([master], [], [], min(remaining, 0.1))
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as err:
                    if err.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    output.extend(chunk)
                else:
                    proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        sys.stdout.buffer.write(output)
        return proc.returncode
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        os.close(master)


if __name__ == '__main__':
    try:
        sys.exit(run())
    except (TimeoutError, RuntimeError, subprocess.TimeoutExpired) as err:
        sys.stderr.write(f'{err}\n')
        sys.exit(124)
