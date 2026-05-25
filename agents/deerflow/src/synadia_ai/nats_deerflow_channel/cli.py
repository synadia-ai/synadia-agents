"""Command-line entry point for the DeerFlow NATS channel."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .config import ChannelConfig, resolve_config
from .doctor import run_doctor
from .host import run_channel


def _add_config_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config-file", type=Path, help="Path to channel TOML config")
    parser.add_argument("--agent", help="Synadia Agent Protocol token; default: df")
    parser.add_argument("--owner", help="Protocol owner token")
    parser.add_argument("--session", help="Protocol session name; default: default")
    parser.add_argument("--deerflow-url", help="DeerFlow Gateway URL")
    parser.add_argument("--nats-context", help="NATS CLI context name")
    parser.add_argument("--nats-url", help="Direct NATS server URL")


def _resolve_from_args(args: argparse.Namespace) -> ChannelConfig:
    return resolve_config(
        config_file=args.config_file,
        agent=args.agent,
        owner=args.owner,
        session=args.session,
        deerflow_url=args.deerflow_url,
        nats_context=args.nats_context,
        nats_url=args.nats_url,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deerflow-nats-channel",
        description="Expose DeerFlow as a Synadia Agent Protocol host on NATS.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="Check resolved configuration")
    _add_config_flags(doctor)

    start = subparsers.add_parser("start", help="Start the channel wrapper")
    _add_config_flags(start)

    configure = subparsers.add_parser("configure", help="Print the default config location")
    _add_config_flags(configure)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    config = _resolve_from_args(args)

    if args.command == "doctor":
        report = run_doctor(config)
        print(report.to_json())
        return 0 if report.ok else 1

    if args.command == "configure":
        print(config.config_file)
        return 0

    if args.command == "start":
        report = run_doctor(config)
        if not report.ok:
            print(report.to_json(), file=sys.stderr)
            return 1
        try:
            asyncio.run(run_channel(config))
        except KeyboardInterrupt:
            return 130
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
