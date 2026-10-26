import os
from typing import Any, cast

import pytest

from app.core.secrets import load_ssm_parameters

PATH = "/farewatch/prod/"


class FakeSSM:
    def __init__(self, pages: list[dict[str, Any]] | Exception) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    def get_parameters_by_path(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if isinstance(self.pages, Exception):
            raise self.pages
        return self.pages[len(self.calls) - 1]


def _param(name: str, value: str) -> dict[str, str]:
    return {"Name": PATH + name, "Value": value}


def _load(fake: FakeSSM) -> int:
    return load_ssm_parameters(cast(Any, fake))


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("JWT_SECRET", "SERPAPI_KEY", "SMTP_PASSWORD"):
        monkeypatch.delenv(name, raising=False)


def test_no_path_does_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SSM_PARAMETER_PATH", raising=False)
    fake = FakeSSM([])
    assert _load(fake) == 0
    assert fake.calls == []


def test_loads_and_uppercases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSM_PARAMETER_PATH", PATH)
    fake = FakeSSM([{"Parameters": [_param("jwt_secret", "abc"), _param("serpapi_key", "k1")]}])
    assert _load(fake) == 2
    assert os.environ["JWT_SECRET"] == "abc"
    assert os.environ["SERPAPI_KEY"] == "k1"
    assert fake.calls[0]["Path"] == PATH
    assert fake.calls[0]["WithDecryption"] is True


def test_reads_all_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSM_PARAMETER_PATH", PATH)
    fake = FakeSSM(
        [
            {"Parameters": [_param("jwt_secret", "abc")], "NextToken": "t1"},
            {"Parameters": [_param("smtp_password", "pw")]},
        ]
    )
    assert _load(fake) == 2
    assert fake.calls[1]["NextToken"] == "t1"
    assert os.environ["JWT_SECRET"] == "abc"
    assert os.environ["SMTP_PASSWORD"] == "pw"


def test_existing_env_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSM_PARAMETER_PATH", PATH)
    monkeypatch.setenv("JWT_SECRET", "local")
    _load(FakeSSM([{"Parameters": [_param("jwt_secret", "abc")]}]))
    assert os.environ["JWT_SECRET"] == "local"


def test_client_error_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SSM_PARAMETER_PATH", PATH)
    with pytest.raises(RuntimeError):
        _load(FakeSSM(RuntimeError("AccessDenied")))
