#!/usr/bin/env python3
"""Reset the ESP32 and print its serial output for N seconds (default 5).

Usage: python3 firmware/serial_read.py [seconds] [--no-reset]
`arduino-cli monitor` sometimes returns only junk bytes on this Mac; this doesn't.
"""
import fcntl, os, struct, sys, termios, time

PORT = '/dev/cu.usbserial-0001'
secs = float(next((a for a in sys.argv[1:] if not a.startswith('-')), 5))

fd = os.open(PORT, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
attrs = termios.tcgetattr(fd)
attrs[0] = attrs[1] = attrs[3] = 0
attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
attrs[4] = attrs[5] = termios.B115200
termios.tcsetattr(fd, termios.TCSANOW, attrs)

TIOCMBIS, TIOCMBIC, DTR, RTS = 0x8004746C, 0x8004746B, 0x002, 0x004
fcntl.ioctl(fd, TIOCMBIC, struct.pack('I', DTR))
if '--no-reset' not in sys.argv:
    fcntl.ioctl(fd, TIOCMBIS, struct.pack('I', RTS))  # RTS pulls EN low = reset
    time.sleep(0.2)
fcntl.ioctl(fd, TIOCMBIC, struct.pack('I', RTS))

end = time.time() + secs
while time.time() < end:
    try:
        sys.stdout.write(os.read(fd, 4096).decode('utf-8', 'replace'))
        sys.stdout.flush()
    except BlockingIOError:
        time.sleep(0.05)
os.close(fd)
