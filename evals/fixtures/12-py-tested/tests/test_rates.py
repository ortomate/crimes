"""Real tests for billing.rates — these assert."""

from billing.rates import DEFAULT_RATE, is_zero_rated, rate_for


def test_known_region_returns_its_rate():
    assert rate_for("GB") == 0.20
    assert rate_for("DE") == 0.19


def test_unknown_region_falls_back_to_default():
    assert rate_for("ZZ") == DEFAULT_RATE


def test_zero_rated_is_false_for_every_known_region():
    assert not is_zero_rated("GB")
    assert not is_zero_rated("FR")
