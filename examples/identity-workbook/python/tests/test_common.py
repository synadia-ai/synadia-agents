from __future__ import annotations

from typing import Any, cast

import pytest

from _common import ConnectedUser


@pytest.mark.asyncio
async def test_connected_user_retains_bundle_until_close_succeeds() -> None:
    class Connection:
        attempts = 0

        async def close(self) -> None:
            self.attempts += 1
            if self.attempts == 1:
                raise RuntimeError("close failed")

    class Bundle:
        wiped = False

        def wipe(self) -> None:
            self.wiped = True

    connection = Connection()
    bundle = Bundle()
    user = ConnectedUser(nc=cast(Any, connection), bundle=cast(Any, bundle))

    with pytest.raises(RuntimeError, match="close failed"):
        await user.close()
    assert bundle.wiped is False

    await user.close()
    assert connection.attempts == 2
    assert bundle.wiped is True
