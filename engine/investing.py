"""How to actually act on a recommendation — the "can I buy this, and how" layer.

The scoreboard ranks MARKETS, but every market is represented by a US-listed ETF
proxy (see engine/universe.py). So "how do I invest in this" always reduces to
"how do I buy this US-listed ticker" — which for the primary audience here (an
India-based investor) has a specific, non-obvious answer: the RBI Liberalised
Remittance Scheme route through a platform that offers US equity investing.

Design constraints this module respects (ADR-027):

* **No fabricated URLs.** Issuer product pages are NOT derivable from a ticker —
  iShares deep links carry an opaque numeric product id (EWY is /products/239681/,
  nothing in "EWY" produces that), and issuer sites 403 automated lookups, so a
  generated deep link cannot be verified before shipping. We therefore link only
  to issuer ROOT domains, which are stable and certain to resolve, and surface the
  ticker prominently so the user's own search is one step. Deep per-fund links are
  a deliberate follow-up needing an id-resolver run from an environment with
  issuer-site access.
* **No issuer guessing.** An ETF's issuer is stable metadata, but asserting the
  wrong one is a factual error shown to a user making money decisions. `_ISSUERS`
  covers the families we are confident about; anything absent renders ticker-only
  rather than attributed to a guess. Absence here is a coverage gap to fill from a
  verified source, never a licence to infer.
* **No broker recommendation.** We name the ACCESS ROUTE (LRS + a US-investing
  platform), not a provider. Picking a broker for the user is advice we are not
  positioned — or licensed — to give.
"""
from __future__ import annotations

# ticker-family -> (issuer display name, issuer root domain). Root domains only,
# by design: see the module docstring. Families are matched longest-prefix-first
# via _issuer_for(), with explicit single-ticker entries taking precedence.
_ISSUER_ISHARES = ("iShares (BlackRock)", "https://www.ishares.com")
_ISSUER_SPDR = ("SPDR (State Street)", "https://www.ssga.com")
_ISSUER_VANGUARD = ("Vanguard", "https://investor.vanguard.com")
_ISSUER_VANECK = ("VanEck", "https://www.vaneck.com")
_ISSUER_INVESCO = ("Invesco", "https://www.invesco.com")

# Explicit per-ticker attribution. Only tickers whose issuer is unambiguous are
# listed; see the docstring on why we do not infer the rest.
_ISSUERS: dict[str, tuple[str, str]] = {}

# -- iShares: the MSCI single-country (EW*) and core/sector (I*) families --
for _t in ("EWA", "EWC", "EWD", "EWG", "EWH", "EWI", "EWJ", "EWK", "EWL", "EWM",
           "EWN", "EWO", "EWP", "EWQ", "EWS", "EWT", "EWU", "EWW", "EWY", "EWZ",
           "EZA", "EZU", "EIS", "EIRL", "EPHE", "EPOL", "EPU", "ECH", "EDEN",
           "EFNL", "ENZL", "EIDO", "EPP", "EEMS", "EFA", "EFG", "EFV", "IEFA",
           "IEMG", "IEUS", "SCZ", "ILF", "FM", "IDV", "IQLT", "AAXJ", "ACWI",
           "ACWX", "URTH", "AIA", "INDA", "INDY", "SMIN", "THD", "TUR", "FXI",
           "MCHI", "IVV", "IVE", "IVW", "IJH", "IWM", "USMV", "QUAL", "MTUM",
           "ITA", "ITB", "IGV", "IYT", "IXC", "IXG", "IXJ", "IXN", "IXP", "JXI",
           "KXI", "MXI", "RXI", "EXI"):
    _ISSUERS[_t] = _ISSUER_ISHARES

# -- SPDR / State Street: Select Sector (XL*) + industry (X*/K*) families --
for _t in ("XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV",
           "XLY", "XBI", "XME", "XOP", "XRT", "KBE", "KIE", "KRE", "DIA", "FEZ"):
    _ISSUERS[_t] = _ISSUER_SPDR

# -- Vanguard --
for _t in ("VGK", "VT", "VWO", "VIG", "VYM"):
    _ISSUERS[_t] = _ISSUER_VANGUARD

# -- VanEck --
for _t in ("SMH", "GDX", "MOAT", "OIH", "VNM", "AFK", "EGPT"):
    _ISSUERS[_t] = _ISSUER_VANECK

# -- Invesco --
for _t in ("QQQ", "TAN"):
    _ISSUERS[_t] = _ISSUER_INVESCO

del _t


def issuer_for(ticker: str) -> dict | None:
    """(name, url) for a proxy ticker, or None when we have no CONFIRMED issuer.

    None is a real answer meaning "not attributed" — callers must render the
    ticker alone rather than substituting a guess.
    """
    hit = _ISSUERS.get((ticker or "").upper())
    return {"name": hit[0], "url": hit[1]} if hit else None


# The access route, not a product pitch. Kept as data (not prose baked into the
# front-end) so the disclaimer text and the UI stay in one place, and so a future
# non-India audience can be added as a sibling entry rather than a rewrite.
ACCESS_ROUTES = {
    "IN": {
        "label": "Investing from India",
        "summary": (
            "Every market on this scoreboard is tracked via a US-listed ETF, so acting on "
            "any of these means buying a US-listed ticker. From India that runs through the "
            "RBI Liberalised Remittance Scheme (LRS): open a US-investing account with a "
            "platform that supports it, remit under LRS, then buy the ticker."
        ),
        "points": [
            "LRS caps outward remittance at USD 250,000 per financial year, per person.",
            "TCS applies on LRS remittances above the current threshold — it is creditable "
            "against your income tax, not a sunk cost, but it affects timing of cash.",
            "US-listed ETF gains are taxed in India as per your applicable capital-gains "
            "rules for foreign assets; foreign holdings must be reported in your ITR "
            "(Schedule FA). Rules change — confirm current treatment with a tax adviser.",
            "US estate-tax exposure can apply to US-situs assets above certain thresholds "
            "for non-resident holders — worth understanding before large positions.",
        ],
        # Deliberately NOT a broker recommendation — see module docstring.
        "note": (
            "This names the route, not a provider. Any SEBI-registered platform offering US "
            "equity investing under LRS can execute it; comparing them is your call."
        ),
    },
}


def invest_block(ticker: str, country_code: str = "IN") -> dict:
    """Everything the UI needs to answer "how do I act on this" for one proxy.

    `listing` is a fact from our own universe (every proxy is US-listed by
    construction); `issuer` may be None (see issuer_for).
    """
    return {
        "ticker": (ticker or "").upper(),
        "listing": "US-listed ETF",
        "issuer": issuer_for(ticker),
        "access": ACCESS_ROUTES.get(country_code),
    }


def coverage() -> dict:
    """Issuer-attribution coverage, for the pipeline report — makes the gap
    visible and measurable instead of silently thin."""
    from .universe import UNIVERSE
    total = len(UNIVERSE)
    known = sum(1 for ix in UNIVERSE if issuer_for(ix.proxy))
    return {"proxies": total, "issuer_attributed": known,
            "unattributed": total - known,
            "pct": round(100.0 * known / total, 1) if total else 0.0}
