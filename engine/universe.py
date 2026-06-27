"""The investable universe: major indices mapped to a liquid, US-listed ETF proxy.

Why ETF proxies? Using one provider family (mostly iShares MSCI / SPDR) means each
market's P/E, P/B, P/S is computed with the SAME methodology — the apples-to-apples
comparability naive multi-site scraping destroys. Each proxy also gives free daily
price history for momentum and the market-feedback loop.

`kind` groups comparable things so scoring is done WITHIN a peer group (countries vs
countries, sectors vs sectors). Big markets carry up to ~5 distinct indices, per the
"max 5 index per country" spec.

Phase 2 will replace `proxy` with full constituent lists behind this same `Index`
interface, so nothing downstream changes.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Index:
    key: str
    name: str
    proxy: str          # US-listed ETF proxy (Phase 1)
    country: str
    region: str
    development: str     # Developed | Emerging | Frontier | Global
    kind: str            # Country | Sector | Style | Region | Broad


def _ix(key, name, proxy, country, region, development, kind="Country"):
    return Index(key, name, proxy, country, region, development, kind)


UNIVERSE: list[Index] = [
    # ===================== COUNTRIES =====================
    # -- North America --
    _ix("us_sp500", "US S&P 500", "IVV", "United States", "North America", "Developed"),
    _ix("us_nasdaq", "US Nasdaq 100", "QQQ", "United States", "North America", "Developed"),
    _ix("us_russell2k", "US Russell 2000", "IWM", "United States", "North America", "Developed"),
    _ix("us_dow", "US Dow 30", "DIA", "United States", "North America", "Developed"),
    _ix("us_midcap", "US S&P MidCap 400", "IJH", "United States", "North America", "Developed"),
    _ix("canada", "Canada", "EWC", "Canada", "North America", "Developed"),
    _ix("mexico", "Mexico", "EWW", "Mexico", "Latin America", "Emerging"),
    # -- Latin America --
    _ix("brazil", "Brazil", "EWZ", "Brazil", "Latin America", "Emerging"),
    _ix("chile", "Chile", "ECH", "Chile", "Latin America", "Emerging"),
    _ix("peru", "Peru", "EPU", "Peru", "Latin America", "Emerging"),
    _ix("colombia", "Colombia", "GXG", "Colombia", "Latin America", "Emerging"),
    _ix("argentina", "Argentina", "ARGT", "Argentina", "Latin America", "Emerging"),
    # -- Western Europe --
    _ix("uk", "United Kingdom", "EWU", "United Kingdom", "Europe", "Developed"),
    _ix("germany", "Germany", "EWG", "Germany", "Europe", "Developed"),
    _ix("france", "France", "EWQ", "France", "Europe", "Developed"),
    _ix("italy", "Italy", "EWI", "Italy", "Europe", "Developed"),
    _ix("spain", "Spain", "EWP", "Spain", "Europe", "Developed"),
    _ix("netherlands", "Netherlands", "EWN", "Netherlands", "Europe", "Developed"),
    _ix("switzerland", "Switzerland", "EWL", "Switzerland", "Europe", "Developed"),
    _ix("sweden", "Sweden", "EWD", "Sweden", "Europe", "Developed"),
    _ix("belgium", "Belgium", "EWK", "Belgium", "Europe", "Developed"),
    _ix("austria", "Austria", "EWO", "Austria", "Europe", "Developed"),
    _ix("ireland", "Ireland", "EIRL", "Ireland", "Europe", "Developed"),
    _ix("norway", "Norway", "NORW", "Norway", "Europe", "Developed"),
    _ix("denmark", "Denmark", "EDEN", "Denmark", "Europe", "Developed"),
    _ix("finland", "Finland", "EFNL", "Finland", "Europe", "Developed"),
    _ix("portugal", "Portugal", "PGAL", "Portugal", "Europe", "Developed"),
    # -- Emerging Europe --
    _ix("poland", "Poland", "EPOL", "Poland", "Emerging Europe", "Emerging"),
    _ix("greece", "Greece", "GREK", "Greece", "Emerging Europe", "Emerging"),
    _ix("turkey", "Turkey", "TUR", "Turkey", "Emerging Europe", "Emerging"),
    # -- Africa / Middle East --
    _ix("south_africa", "South Africa", "EZA", "South Africa", "Africa/MEA", "Emerging"),
    _ix("saudi", "Saudi Arabia", "KSA", "Saudi Arabia", "Africa/MEA", "Emerging"),
    _ix("uae", "UAE", "UAE", "United Arab Emirates", "Africa/MEA", "Emerging"),
    _ix("qatar", "Qatar", "QAT", "Qatar", "Africa/MEA", "Emerging"),
    _ix("israel", "Israel", "EIS", "Israel", "Africa/MEA", "Developed"),
    _ix("egypt", "Egypt", "EGPT", "Egypt", "Africa/MEA", "Frontier"),
    _ix("nigeria", "Nigeria", "NGE", "Nigeria", "Africa/MEA", "Frontier"),
    # -- Asia-Pacific Developed --
    _ix("japan", "Japan", "EWJ", "Japan", "Asia-Pacific", "Developed"),
    _ix("japan_hedged", "Japan (yen-hedged)", "DXJ", "Japan", "Asia-Pacific", "Developed"),
    _ix("australia", "Australia", "EWA", "Australia", "Asia-Pacific", "Developed"),
    _ix("hongkong", "Hong Kong", "EWH", "Hong Kong", "Asia-Pacific", "Developed"),
    _ix("singapore", "Singapore", "EWS", "Singapore", "Asia-Pacific", "Developed"),
    _ix("newzealand", "New Zealand", "ENZL", "New Zealand", "Asia-Pacific", "Developed"),
    # -- Asia Emerging --
    _ix("china_broad", "China (MSCI)", "MCHI", "China", "Asia-Pacific", "Emerging"),
    _ix("china_lc", "China Large Cap", "FXI", "China", "Asia-Pacific", "Emerging"),
    _ix("china_ashares", "China A-shares (CSI 300)", "ASHR", "China", "Asia-Pacific", "Emerging"),
    _ix("china_internet", "China Internet", "KWEB", "China", "Asia-Pacific", "Emerging"),
    _ix("india_broad", "India (MSCI)", "INDA", "India", "Asia-Pacific", "Emerging"),
    _ix("india_nifty", "India Nifty 50", "INDY", "India", "Asia-Pacific", "Emerging"),
    _ix("india_small", "India Small Cap", "SMIN", "India", "Asia-Pacific", "Emerging"),
    _ix("korea", "South Korea", "EWY", "South Korea", "Asia-Pacific", "Emerging"),
    _ix("taiwan", "Taiwan", "EWT", "Taiwan", "Asia-Pacific", "Emerging"),
    _ix("malaysia", "Malaysia", "EWM", "Malaysia", "Asia-Pacific", "Emerging"),
    _ix("indonesia", "Indonesia", "EIDO", "Indonesia", "Asia-Pacific", "Emerging"),
    _ix("thailand", "Thailand", "THD", "Thailand", "Asia-Pacific", "Emerging"),
    _ix("philippines", "Philippines", "EPHE", "Philippines", "Asia-Pacific", "Emerging"),
    _ix("vietnam", "Vietnam", "VNM", "Vietnam", "Asia-Pacific", "Frontier"),
    _ix("pakistan", "Pakistan", "PAK", "Pakistan", "Asia-Pacific", "Frontier"),

    # ===================== US SECTORS =====================
    _ix("sec_tech", "US Technology", "XLK", "United States", "North America", "Developed", "Sector"),
    _ix("sec_fin", "US Financials", "XLF", "United States", "North America", "Developed", "Sector"),
    _ix("sec_health", "US Health Care", "XLV", "United States", "North America", "Developed", "Sector"),
    _ix("sec_discr", "US Consumer Discretionary", "XLY", "United States", "North America", "Developed", "Sector"),
    _ix("sec_staples", "US Consumer Staples", "XLP", "United States", "North America", "Developed", "Sector"),
    _ix("sec_energy", "US Energy", "XLE", "United States", "North America", "Developed", "Sector"),
    _ix("sec_indu", "US Industrials", "XLI", "United States", "North America", "Developed", "Sector"),
    _ix("sec_util", "US Utilities", "XLU", "United States", "North America", "Developed", "Sector"),
    _ix("sec_mat", "US Materials", "XLB", "United States", "North America", "Developed", "Sector"),
    _ix("sec_re", "US Real Estate", "XLRE", "United States", "North America", "Developed", "Sector"),
    _ix("sec_comm", "US Communication Svcs", "XLC", "United States", "North America", "Developed", "Sector"),
    _ix("sec_semi", "Semiconductors", "SMH", "Global", "Global", "Developed", "Sector"),
    _ix("sec_biotech", "Biotech", "XBI", "United States", "North America", "Developed", "Sector"),
    _ix("sec_banks", "US Regional Banks", "KBE", "United States", "North America", "Developed", "Sector"),
    _ix("sec_goldminers", "Gold Miners", "GDX", "Global", "Global", "Developed", "Sector"),

    # ===================== STYLES / FACTORS =====================
    _ix("sty_value", "US Value", "IVE", "United States", "North America", "Developed", "Style"),
    _ix("sty_growth", "US Growth", "IVW", "United States", "North America", "Developed", "Style"),
    _ix("sty_highdiv", "US High Dividend", "VYM", "United States", "North America", "Developed", "Style"),
    _ix("sty_momentum", "US Momentum", "MTUM", "United States", "North America", "Developed", "Style"),
    _ix("sty_quality", "US Quality", "QUAL", "United States", "North America", "Developed", "Style"),
    _ix("sty_minvol", "US Min Volatility", "USMV", "United States", "North America", "Developed", "Style"),

    # ===================== REGIONS =====================
    _ix("reg_eurozone", "Eurozone (EMU)", "EZU", "Regional", "Europe", "Developed", "Region"),
    _ix("reg_europe", "Europe (broad)", "VGK", "Regional", "Europe", "Developed", "Region"),
    _ix("reg_eurostoxx", "Euro Stoxx 50", "FEZ", "Regional", "Europe", "Developed", "Region"),
    _ix("reg_asia_exjp", "Asia ex-Japan", "AAXJ", "Regional", "Asia-Pacific", "Emerging", "Region"),
    _ix("reg_pac_exjp", "Pacific ex-Japan", "EPP", "Regional", "Asia-Pacific", "Developed", "Region"),
    _ix("reg_latam", "Latin America", "ILF", "Regional", "Latin America", "Emerging", "Region"),
    _ix("reg_africa", "Africa", "AFK", "Regional", "Africa/MEA", "Frontier", "Region"),
    _ix("reg_gcc", "Gulf / Middle East", "GULF", "Regional", "Africa/MEA", "Emerging", "Region"),

    # ===================== BROAD BENCHMARKS =====================
    _ix("broad_world", "World (ACWI)", "ACWI", "Global", "Global", "Global", "Broad"),
    _ix("broad_dev_exus", "Developed ex-US (EAFE)", "EFA", "Global", "Global", "Developed", "Broad"),
    _ix("broad_dev_core", "Developed ex-US (core)", "IEFA", "Global", "Global", "Developed", "Broad"),
    _ix("broad_em", "Emerging Markets", "IEMG", "Global", "Global", "Emerging", "Broad"),
    _ix("broad_em_vwo", "Emerging Markets (FTSE)", "VWO", "Global", "Global", "Emerging", "Broad"),
    _ix("broad_frontier", "Frontier Markets", "FM", "Global", "Global", "Frontier", "Broad"),
]

BY_KEY = {ix.key: ix for ix in UNIVERSE}


def all_symbols() -> list[str]:
    return [ix.proxy for ix in UNIVERSE]
