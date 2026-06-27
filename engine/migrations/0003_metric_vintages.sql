-- Keep restatement vintages: a later-filed value for the same period is a NEW row,
-- not an overwrite — so a point-in-time backtest can pick the latest vintage whose
-- filed_date <= as-of date. (Table is empty at this point, so this is safe.)
alter table fundamental_metrics alter column filed_date set default current_date;
update fundamental_metrics set filed_date = current_date where filed_date is null;
alter table fundamental_metrics alter column filed_date set not null;
alter table fundamental_metrics drop constraint if exists fundamental_metrics_pkey;
alter table fundamental_metrics
  add primary key (security_id, period_end, fiscal_period, metric_code, source, filed_date);
