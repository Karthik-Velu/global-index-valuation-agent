#!/usr/bin/env python3
"""PreToolUse gate for mcp__Supabase__execute_sql: auto-approve provably READ-ONLY SQL.

Why: the owner gave standing approval for read-only database queries (2026-10-19) but
not for writes. The Supabase MCP tool runs arbitrary SQL, so a plain permission rule
cannot tell a SELECT from an UPDATE. This hook approves a query only when it can PROVE
the query is read-only; anything it cannot prove (writes, DDL, multi-statement text,
EXPLAIN ANALYZE, dollar quoting, or ANY function not on a known-safe built-in list —
because `select some_volatile_fn()` can write) falls through to the normal permission
prompt. It never denies: silence = "ask as usual". Stdlib only; fails open to the prompt.
"""
import json
import re
import sys

LEADING = {"select", "with", "explain", "show", "values", "table"}

# Words that can only appear in a statement that writes, locks, or changes session state.
WRITE_WORDS = {
    "insert", "update", "delete", "merge", "upsert", "create", "alter", "drop", "truncate",
    "grant", "revoke", "copy", "call", "do", "execute", "prepare", "deallocate", "set",
    "reset", "lock", "vacuum", "analyze", "analyse", "cluster", "reindex", "refresh",
    "comment", "security", "listen", "notify", "unlisten", "discard", "checkpoint", "load",
    "import", "into", "begin", "commit", "rollback", "savepoint", "release", "start",
    "transaction", "abort", "returning", "share", "nowait",
}

# Built-in functions that only read. Anything else followed by "(" is treated as unsafe.
SAFE_FUNCS = set("""
count sum avg min max string_agg array_agg json_agg jsonb_agg json_object_agg jsonb_object_agg
bool_and bool_or every stddev stddev_pop stddev_samp variance var_pop var_samp corr covar_pop
covar_samp percentile_cont percentile_disc mode regr_slope regr_intercept regr_r2
row_number rank dense_rank lag lead first_value last_value nth_value ntile cume_dist percent_rank
lower upper length char_length character_length octet_length bit_length substr substring left
right trim btrim ltrim rtrim replace split_part concat concat_ws format position strpos
regexp_replace regexp_matches regexp_match regexp_split_to_array regexp_split_to_table lpad rpad
initcap md5 encode decode to_char to_number to_date to_timestamp quote_ident quote_literal
quote_nullable starts_with translate reverse repeat ascii chr
abs round ceil ceiling floor trunc power sqrt cbrt ln log log10 exp mod sign random width_bucket
greatest least div pi degrees radians
now date_trunc date_part extract age make_date make_time make_timestamp make_timestamptz
make_interval timezone generate_series clock_timestamp statement_timestamp
json_build_object jsonb_build_object json_build_array jsonb_build_array jsonb_array_length
json_array_length jsonb_each json_each jsonb_each_text json_each_text jsonb_array_elements
json_array_elements jsonb_array_elements_text json_array_elements_text jsonb_object_keys
json_object_keys jsonb_typeof json_typeof jsonb_pretty to_json to_jsonb row_to_json
array_to_json jsonb_path_query jsonb_path_exists jsonb_path_query_first jsonb_extract_path
jsonb_extract_path_text json_extract_path json_extract_path_text jsonb_strip_nulls
array_length unnest cardinality array_to_string string_to_array array_position array_positions
array_remove array_cat array_append array_prepend array_dims array_upper array_lower
coalesce nullif cast exists
pg_size_pretty pg_total_relation_size pg_relation_size pg_table_size pg_indexes_size
pg_database_size pg_column_size current_setting has_table_privilege has_schema_privilege
has_column_privilege has_function_privilege pg_get_functiondef pg_get_function_arguments
pg_get_function_result pg_get_viewdef pg_get_constraintdef pg_get_indexdef pg_get_triggerdef
pg_get_userbyid pg_get_expr format_type obj_description col_description shobj_description
to_regclass to_regproc to_regtype pg_typeof version current_database current_schema
pg_relation_filenode pg_get_serial_sequence
""".split())

# SQL keywords / type names that are legitimately followed by "(".
PAREN_KEYWORDS = set("""
as in any all some over filter values from join on and or not where select by when then else
case between having using lateral partition within group order row array distinct union
intersect except limit offset with recursive is like ilike similar escape interval numeric
decimal varchar char character timestamp timestamptz time timetz date float double precision
bit varbit extract position overlay trim collate at zone tablesample rows range preceding
following current materialized exclude window explain
""".split())


def _strip(sql):
    """Remove comments, string literals and quoted identifiers so keyword scans see only code.
    Returns None if the text uses constructs we refuse to reason about (dollar quoting)."""
    if re.search(r"\$[A-Za-z_0-9]*\$", sql):
        return None
    out, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
            out.append(" ")
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            if j < 0:
                return None
            i = j + 2
            out.append(" ")
        elif c in ("'", '"'):
            q, j = c, i + 1
            while j < n:
                if sql[j] == q:
                    if j + 1 < n and sql[j + 1] == q:  # doubled quote = escaped
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                return None
            out.append(" '' " if q == "'" else " qident ")
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def is_read_only(sql):
    if not isinstance(sql, str) or not sql.strip() or len(sql) > 20000:
        return False
    code = _strip(sql)
    if code is None:
        return False
    stmts = [s for s in code.split(";") if s.strip()]
    if len(stmts) != 1:
        return False
    code = stmts[0].lower()
    words = re.findall(r"[a-z_][a-z0-9_$]*", code)
    if not words or words[0] not in LEADING:
        return False
    if WRITE_WORDS.intersection(words):
        return False
    if re.search(r"\bfor\s+(update|share|no\s+key|key)\b", code):
        return False
    for m in re.finditer(r"([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)*)\s*\(", code):
        name = re.sub(r"\s+", "", m.group(1))
        if name.startswith("pg_catalog."):
            name = name[len("pg_catalog."):]
        if "." in name:            # schema-qualified user function: cannot prove it is pure
            return False
        if name not in SAFE_FUNCS and name not in PAREN_KEYWORDS:
            return False
    return True


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return  # malformed input: fall through to the normal prompt
    if payload.get("tool_name") != "mcp__Supabase__execute_sql":
        return
    query = (payload.get("tool_input") or {}).get("query")
    if is_read_only(query):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "read-only SQL — auto-approved under the owner's standing approval for read queries (2026-10-19)",
        }}))


if __name__ == "__main__":
    main()
