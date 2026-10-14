from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "install-test-broker.sh"


class BrokerInstallationTests(unittest.TestCase):
    def test_invalid_pin_and_existing_output_refuse_before_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            result = subprocess.run(
                ["bash", str(SCRIPT), "invalid", "0" * 64, str(output)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())
            output.mkdir()
            marker = output / "keep"
            marker.write_bytes(b"preserve existing files")
            result = subprocess.run(
                ["bash", str(SCRIPT), "2.12.7", "0" * 64, str(output)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(marker.read_bytes(), b"preserve existing files")

    def test_wrong_download_digest_cannot_install_or_change_github_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            commands = root / "commands"
            commands.mkdir()
            # curl is the external HTTP boundary. The real digest utility runs.
            curl = commands / "curl"
            curl.write_text(
                "#!/usr/bin/env bash\nset -eu\n"
                "while [[ $# -gt 0 ]]; do\n"
                '  if [[ $1 == -o ]]; then printf "untrusted bytes" > "$2"; exit 0; fi\n'
                "  shift\ndone\nexit 2\n"
            )
            curl.chmod(0o755)
            github_path = root / "github-path"
            env = dict(
                os.environ,
                PATH=str(commands) + os.pathsep + os.environ["PATH"],
                GITHUB_PATH=str(github_path),
            )
            output = root / "output"
            result = subprocess.run(
                ["bash", str(SCRIPT), "2.12.7", "0" * 64, str(output)],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("broker archive digest mismatch", result.stderr)
            self.assertFalse((output / "bin").exists())
            self.assertFalse(github_path.exists())


if __name__ == "__main__":
    unittest.main()
