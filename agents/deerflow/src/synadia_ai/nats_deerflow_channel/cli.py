"""Command-line entry point for the DeerFlow NATS channel."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .config import ChannelConfig, resolve_config
from .doctor import run_doctor
from .host import run_channel


def _positive_float(value: str) -> float:
    try:
        result = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive number") from exc
    if result <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return result


def _add_config_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config-file", type=Path, help="Path to channel TOML config")
    parser.add_argument("--agent", help="Synadia Agent Protocol token; default: df")
    parser.add_argument("--owner", help="Protocol owner token")
    parser.add_argument("--session", help="Protocol session name; default: default")
    parser.add_argument("--deerflow-url", help="DeerFlow Gateway URL")
    parser.add_argument("--nats-context", help="NATS CLI context name")
    parser.add_argument("--nats-url", help="Direct NATS server URL")
    parser.add_argument(
        "--deerflow-timeout-s",
        type=_positive_float,
        help="HTTP connect/read timeout for DeerFlow Gateway calls; default: 60",
    )
    parser.add_argument(
        "--query-timeout-s",
        type=_positive_float,
        help="Seconds to wait for protocol query replies to DeerFlow clarifications; default: 300",
    )
    parser.add_argument(
        "--max-payload",
        help="Advertised prompt max_payload metadata; default: 1MB, clamped by NATS server",
    )
    parser.add_argument(
        "--deerflow-cookie",
        help=(
            "Cookie header for authenticated DeerFlow Gateway calls; "
            "may include access_token and csrf_token"
        ),
    )
    parser.add_argument(
        "--deerflow-csrf-token",
        help="CSRF token sent as X-CSRF-Token for DeerFlow Gateway POST calls",
    )
    parser.add_argument(
        "--deerflow-username",
        help="DeerFlow local-login email/username; enables automatic session login",
    )


def _resolve_from_args(args: argparse.Namespace) -> ChannelConfig:
    return resolve_config(
        config_file=args.config_file,
        agent=args.agent,
        owner=args.owner,
        session=args.session,
        deerflow_url=args.deerflow_url,
        nats_context=args.nats_context,
        nats_url=args.nats_url,
        deerflow_timeout_s=args.deerflow_timeout_s,
        query_timeout_s=args.query_timeout_s,
        max_payload=args.max_payload,
        deerflow_cookie=args.deerflow_cookie,
        deerflow_csrf_token=args.deerflow_csrf_token,
        deerflow_username=args.deerflow_username,
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
