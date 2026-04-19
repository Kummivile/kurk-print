#!/usr/bin/env python3
"""Send plotter commands from a text file and wait for OK/ERR after each line."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

try:
    import serial
except ImportError:
    print("Missing dependency: pyserial. Install with `python3 -m pip install pyserial`.", file=sys.stderr)
    sys.exit(1)


DEFAULT_BAUD_RATE = 115200
DEFAULT_RESPONSE_TIMEOUT = 10.0
DEFAULT_STARTUP_WAIT = 2.0
COMMENT_PREFIXES = ("#", ";", "//")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send plotter commands from a text file over serial."
    )
    parser.add_argument("port", help="Serial port, for example /dev/tty.usbmodem1101")
    parser.add_argument("commands_file", help="Path to a text file with one command per line")
    parser.add_argument(
        "--baud",
        type=int,
        default=DEFAULT_BAUD_RATE,
        help=f"Serial baud rate. Default: {DEFAULT_BAUD_RATE}",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_RESPONSE_TIMEOUT,
        help=f"Seconds to wait for OK/ERR after each command. Default: {DEFAULT_RESPONSE_TIMEOUT}",
    )
    parser.add_argument(
        "--startup-wait",
        type=float,
        default=DEFAULT_STARTUP_WAIT,
        help=f"Seconds to wait after opening the port. Default: {DEFAULT_STARTUP_WAIT}",
    )
    return parser.parse_args()


def load_commands(path: Path) -> list[str]:
    commands: list[str] = []

    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
      line = raw_line.strip()
      if not line:
        continue
      if any(line.startswith(prefix) for prefix in COMMENT_PREFIXES):
        continue

      commands.append(line)

    if not commands:
        raise ValueError(f"No commands found in {path}")

    return commands


def wait_for_ready_banner(connection: serial.Serial, startup_wait: float) -> None:
    time.sleep(startup_wait)
    deadline = time.time() + 4.0
    while time.time() < deadline:
        line = connection.readline().decode("utf-8", errors="replace").strip()
        if not line:
            continue
        print(f"< {line}")
        if line == "OK":
            return


def send_command(connection: serial.Serial, command: str, timeout: float) -> None:
    print(f"> {command}")
    connection.write(f"{command}\n".encode("ascii"))
    connection.flush()

    deadline = time.time() + timeout
    while time.time() < deadline:
        line = connection.readline().decode("utf-8", errors="replace").strip()
        if not line:
            continue

        print(f"< {line}")
        if line == "OK":
            return
        if line.startswith("ERR:"):
            raise RuntimeError(f"Device rejected command `{command}` with {line}")

    raise TimeoutError(f"Timed out waiting for response to `{command}`")


def main() -> int:
    args = parse_args()
    commands_path = Path(args.commands_file)
    commands = load_commands(commands_path)

    with serial.Serial(args.port, args.baud, timeout=1) as connection:
        wait_for_ready_banner(connection, args.startup_wait)
        for command in commands:
            send_command(connection, command, args.timeout)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, TimeoutError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
