"""Coarse SIC-code -> sector mapping (free, deterministic bootstrap for tagging).

SIC is imperfect but free and present in EDGAR submissions. We derive a broad
`sector` from the code, keep the SEC `sicDescription` as a specific `industry`
label, and leave finer `sub_sector` to the LLM refinement pass. Specific overrides
(e.g. 3674 = Semiconductors) take precedence over range rules.
"""
from __future__ import annotations

# Exact 4-digit overrides for high-value sub-sectors.
_OVERRIDE = {
    "3674": ("Technology", "Semiconductors"),
    "3711": ("Consumer Discretionary", "Autos & EVs"),
    "3712": ("Consumer Discretionary", "Autos & EVs"),
    "3713": ("Industrials", "Trucks & Commercial Vehicles"),
    "7372": ("Technology", "Software"),
    "7370": ("Technology", "Software & IT Services"),
    "7371": ("Technology", "IT Services"),
    "7373": ("Technology", "IT Services"),
    "2834": ("Healthcare", "Pharmaceuticals"),
    "2836": ("Healthcare", "Biotechnology"),
    "8731": ("Healthcare", "Biotechnology"),
    "6798": ("Real Estate", "REITs"),
    "1311": ("Energy", "Oil & Gas E&P"),
    "2911": ("Energy", "Refining"),
}

# (lo, hi) inclusive 4-digit ranges -> (sector, sub_sector or '').
_RANGES = [
    (100, 999, ("Materials", "Agriculture")),
    (1000, 1299, ("Materials", "Metals & Mining")),
    (1300, 1399, ("Energy", "Oil & Gas")),
    (1400, 1499, ("Materials", "Mining")),
    (1500, 1799, ("Industrials", "Construction")),
    (2000, 2199, ("Consumer Staples", "Food & Beverage")),
    (2200, 2399, ("Consumer Discretionary", "Apparel")),
    (2400, 2799, ("Materials", "Paper & Packaging")),
    (2800, 2899, ("Materials", "Chemicals")),
    (2900, 2999, ("Energy", "Refining")),
    (3000, 3399, ("Materials", "Industrial Materials")),
    (3400, 3569, ("Industrials", "Machinery")),
    (3570, 3579, ("Technology", "Computers & Hardware")),
    (3600, 3699, ("Technology", "Electronics")),
    (3700, 3799, ("Industrials", "Transportation Equipment")),
    (3800, 3899, ("Healthcare", "Medical Devices")),
    (3900, 3999, ("Consumer Discretionary", "Manufacturing")),
    (4000, 4799, ("Industrials", "Transportation")),
    (4800, 4899, ("Communication Services", "Telecom")),
    (4900, 4999, ("Utilities", "Utilities")),
    (5000, 5199, ("Industrials", "Wholesale")),
    (5200, 5999, ("Consumer Discretionary", "Retail")),
    (6000, 6199, ("Financials", "Banks")),
    (6200, 6299, ("Financials", "Capital Markets")),
    (6300, 6499, ("Financials", "Insurance")),
    (6500, 6599, ("Real Estate", "Real Estate")),
    (6700, 6799, ("Financials", "Diversified Financials")),
    (7000, 7299, ("Consumer Discretionary", "Consumer Services")),
    (7300, 7399, ("Technology", "IT Services & Software")),
    (7400, 7999, ("Consumer Discretionary", "Services")),
    (8000, 8099, ("Healthcare", "Healthcare Services")),
    (8200, 8999, ("Industrials", "Professional Services")),
]


def classify(sic_code: str | int | None) -> tuple[str, str]:
    """Return (sector, sub_sector) for a SIC code; ('Unknown','') if unmappable."""
    if sic_code in (None, "", "0000"):
        return ("Unknown", "")
    s = str(sic_code).strip().zfill(4)
    if s in _OVERRIDE:
        return _OVERRIDE[s]
    try:
        n = int(s)
    except ValueError:
        return ("Unknown", "")
    for lo, hi, val in _RANGES:
        if lo <= n <= hi:
            return val
    return ("Unknown", "")
