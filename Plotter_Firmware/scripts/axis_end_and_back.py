#!/usr/bin/env python3
"""Send a simple X-axis travel test to the plotter over serial.

Default sequence:
1. Move to 100,0
2. Move to the X-axis end stop at 199,0
3. Move back to 100,0
"""

from __future__ import annotations

import argparse
import sys
import time

try:
    import serial
except ImportError:
    print("Missing dependency: pyserial. Install with `python3 -m pip install pyserial`.", file=sys.stderr)
    sys.exit(1)


PLOTTER_MAX_X = 199
PLOTTER_MAX_Y = 289
DEFAULT_BAUD_RATE = 115200
DEFAULT_DWELL_SECONDS = 0.75


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Move the plotter X axis from 100,0 to the end and back."
    )
    parser.add_argument("port", help="Serial port, for example /dev/tty.usbmodem1101")
    parser.add_argument(
        "--baud",
        type=int,
        default=DEFAULT_BAUD_RATE,
        help=f"Serial baud rate. Default: {DEFAULT_BAUD_RATE}",
    )
    parser.add_argument(
        "--start-x",
        type=int,
        default=100,
        help="Starting X coordinate. Default: 100",
    )
    parser.add_argument(
        "--y",
        type=int,
        default=0,
        help="Y coordinate to keep fixed during the test. Default: 0",
    )
    parser.add_argument(
        "--end-x",
        type=int,
        default=PLOTTER_MAX_X,
        help=f"End X coordinate. Default: {PLOTTER_MAX_X}",
    )
    parser.add_argument(
        "--pause",
        type=float,
        default=DEFAULT_DWELL_SECONDS,
        help=f"Delay between commands in seconds. Default: {DEFAULT_DWELL_SECONDS}",
    )
    parser.add_argument(
        "--home-first",
        action="store_true",
        help="Send HOME before starting the move sequence.",
    )
    return parser.parse_args()


def ensure_in_range(name: str, value: int, minimum: int, maximum: int) -> None:
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}, got {value}")


def build_commands(start_x: int, y: int, end_x: int, home_first: bool) -> list[str]:
    ensure_in_range("start-x", start_x, 0, PLOTTER_MAX_X)
    ensure_in_range("end-x", end_x, 0, PLOTTER_MAX_X)
    ensure_in_range("y", y, 0, PLOTTER_MAX_Y)

    commands: list[str] = []
    if home_first:
        commands.append("HOME")

    commands.extend(
        [
            f"MOV:{start_x},{y}",
            f"MOV:{end_x},{y}",
            f"MOV:{start_x},{y}",
        ]
    )
    return commands


def read_ready_banner(connection: serial.Serial) -> None:
    deadline = time.time() + 4.0
    while time.time() < deadline:
        line = connection.readline().decode("utf-8", errors="replace").strip()
        if not line:
            continue
        print(f"< {line}")
        if line == "OK":
            return


def main() -> int:
    args = parse_args()
    commands = build_commands(args.start_x, args.y, args.end_x, args.home_first)

    with serial.Serial(args.port, args.baud, timeout=1) as connection:
        time.sleep(2.0)
        read_ready_banner(connection)

        for command in commands:
            print(f"> {command}")
            connection.write(f"{command}\n".encode("ascii"))
            connection.flush()
            time.sleep(args.pause)

            deadline = time.time() + 5.0
            while time.time() < deadline:
                line = connection.readline().decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                print(f"< {line}")
                if line == "OK" or line.startswith("ERR:"):
                    break

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
