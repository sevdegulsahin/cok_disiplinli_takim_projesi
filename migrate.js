const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://postgres.pzlvydymgtjrxywziygg:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});
const SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.bin_level_history (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  snapshot JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_blh_time ON public.bin_level_history (recorded_at DESC);
ALTER TABLE public.bin_level_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.bin_level_history;
CREATE POLICY "Allow all" ON public.bin_level_history FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.daily_collection_time_metrics (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'planned' CHECK (source IN ('planned', 'completed', 'auto')),
  route_order JSONB NOT NULL DEFAULT '[]',
  stop_count INTEGER NOT NULL DEFAULT 0,
  route_distance_m NUMERIC(8,2) NOT NULL DEFAULT 0,
  drive_minutes NUMERIC(8,2) NOT NULL DEFAULT 0,
  service_minutes NUMERIC(8,2) NOT NULL DEFAULT 0,
  fixed_minutes NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_minutes NUMERIC(8,2) NOT NULL DEFAULT 0,
  total_fill_score NUMERIC(8,2) NOT NULL DEFAULT 0,
  algorithm JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_daily_collection_metrics_date
  ON public.daily_collection_time_metrics (metric_date DESC, calculated_at DESC);
ALTER TABLE public.daily_collection_time_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.daily_collection_time_metrics;
CREATE POLICY "Allow all" ON public.daily_collection_time_metrics FOR ALL USING (true) WITH CHECK (true);
`;
c.connect()
  .then(() => c.query(SQL))
  .then(r => { console.log('OK - table created', r.rowCount); c.end(); })
  .catch(e => { console.error('ERR:', e.message); c.end(); });
