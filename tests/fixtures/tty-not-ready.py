"""A prompt alone deliberately does not imply control-character readiness."""
import os
import sys
import tty

sys.stdout.write('> ')
sys.stdout.flush()
if sys.stdin.readline() != '/help\n':
    sys.exit(10)
tty.setraw(sys.stdin.fileno())
sys.stdout.write('Show this help\n> ')
sys.stdout.flush()
sys.exit(0 if os.read(sys.stdin.fileno(), 1) == b'\x03' else 11)
