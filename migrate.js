const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://postgres.pzlvydymgtjrxywziygg:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});
const SQL = `
CREATE TABLE IF NOT EXISTS public.bin_level_history (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  snapshot JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_blh_time ON public.bin_level_history (recorded_at DESC);
ALTER TABLE public.bin_level_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON public.bin_level_history FOR ALL USING (true) WITH CHECK (true);
`;
c.connect()
  .then(() => c.query(SQL))
  .then(r => { console.log('OK - table created', r.rowCount); c.end(); })
  .catch(e => { console.error('ERR:', e.message); c.end(); });
