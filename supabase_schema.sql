-- Smart Campus Waste Management System
-- Supabase Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Bins table: stores each bin location and overall info
CREATE TABLE IF NOT EXISTS bins (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  location_icon TEXT NOT NULL,
  capacity_liters INTEGER NOT NULL DEFAULT 120,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Waste categories for each bin (plastic, paper, organic, glass, metal)
CREATE TABLE IF NOT EXISTS waste_categories (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  bin_id UUID REFERENCES bins(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('plastic', 'paper', 'organic', 'glass', 'metal')),
  current_level NUMERIC(5,2) DEFAULT 0 CHECK (current_level >= 0 AND current_level <= 100),
  color_hex TEXT NOT NULL,
  icon TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bin_id, category)
);

-- Collection events: history of waste collections
CREATE TABLE IF NOT EXISTS collection_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  bin_id UUID REFERENCES bins(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  collected_by TEXT DEFAULT 'Sistem',
  notes TEXT,
  levels_before JSONB NOT NULL DEFAULT '{}'
);

-- Level history: periodic snapshots of bin fill levels for charts
CREATE TABLE IF NOT EXISTS bin_level_history (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  snapshot JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_bin_level_history_time ON bin_level_history (recorded_at DESC);

-- Route plans: generated collection routes
CREATE TABLE IF NOT EXISTS route_plans (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  route_order JSONB NOT NULL DEFAULT '[]',  -- array of bin_ids in collection order
  total_fill_score NUMERIC(5,2) DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed'))
);

-- Industrial engineering metric: daily estimated collection time.
CREATE TABLE IF NOT EXISTS daily_collection_time_metrics (
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
  ON daily_collection_time_metrics (metric_date DESC, calculated_at DESC);

-- Gamification: students and recycling transactions
CREATE TABLE IF NOT EXISTS students (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  card_id TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0 CHECK (total_points >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS waste_transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  bin_id UUID REFERENCES bins(id) ON DELETE SET NULL,
  waste_category TEXT NOT NULL CHECK (waste_category IN ('plastic', 'paper', 'organic', 'glass', 'metal')),
  points_awarded INTEGER NOT NULL CHECK (points_awarded > 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_students_points ON students (total_points DESC);
CREATE INDEX IF NOT EXISTS idx_waste_transactions_created_at ON waste_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waste_transactions_student ON waste_transactions (student_id);

-- -------------------------------------------------------
-- INSERT DEFAULT DATA
-- -------------------------------------------------------

-- Insert the 3 bins
INSERT INTO bins (id, name, location, location_icon, capacity_liters) VALUES
  ('a1b2c3d4-0001-0001-0001-000000000001', 'Kütüphane Çöp Kovası',   'Kütüphane',   '📚', 120),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'Ders Binası Çöp Kovası', 'Ders Binası', '🏫', 120),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'Yemekhane Çöp Kovası',  'Yemekhane',   '🍽️', 120)
ON CONFLICT (id) DO NOTHING;

-- Insert waste categories for Kütüphane
INSERT INTO waste_categories (bin_id, category, current_level, color_hex, icon) VALUES
  ('a1b2c3d4-0001-0001-0001-000000000001', 'plastic',  15, '#3B82F6', '♳'),
  ('a1b2c3d4-0001-0001-0001-000000000001', 'paper',    45, '#F59E0B', '📄'),
  ('a1b2c3d4-0001-0001-0001-000000000001', 'organic',   5, '#10B981', '🌿'),
  ('a1b2c3d4-0001-0001-0001-000000000001', 'glass',    10, '#8B5CF6', '🍶'),
  ('a1b2c3d4-0001-0001-0001-000000000001', 'metal',     8, '#6B7280', '🥫')
ON CONFLICT DO NOTHING;

-- Insert waste categories for Ders Binası
INSERT INTO waste_categories (bin_id, category, current_level, color_hex, icon) VALUES
  ('a1b2c3d4-0002-0002-0002-000000000002', 'plastic',  65, '#3B82F6', '♳'),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'paper',    78, '#F59E0B', '📄'),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'organic',  20, '#10B981', '🌿'),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'glass',    30, '#8B5CF6', '🍶'),
  ('a1b2c3d4-0002-0002-0002-000000000002', 'metal',    55, '#6B7280', '🥫')
ON CONFLICT DO NOTHING;

-- Insert waste categories for Yemekhane
INSERT INTO waste_categories (bin_id, category, current_level, color_hex, icon) VALUES
  ('a1b2c3d4-0003-0003-0003-000000000003', 'plastic',  40, '#3B82F6', '♳'),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'paper',    25, '#F59E0B', '📄'),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'organic',  92, '#10B981', '🌿'),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'glass',    60, '#8B5CF6', '🍶'),
  ('a1b2c3d4-0003-0003-0003-000000000003', 'metal',    35, '#6B7280', '🥫')
ON CONFLICT DO NOTHING;

-- Seed students for gamification; keep existing points if already present.
INSERT INTO students (card_id, full_name, total_points) VALUES
  ('CARD-001', 'Ahmet Yılmaz', 45),
  ('CARD-002', 'Ayşe Demir', 20),
  ('CARD-003', 'Mehmet Kaya', 12)
ON CONFLICT (card_id) DO UPDATE
SET full_name = EXCLUDED.full_name,
    updated_at = NOW();

-- -------------------------------------------------------
-- REALTIME + Row Level Security (PUBLIC ACCESS FOR DEMO)
-- -------------------------------------------------------
ALTER TABLE bins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bin_level_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_collection_time_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE students          ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all" ON bins;
DROP POLICY IF EXISTS "Allow all" ON waste_categories;
DROP POLICY IF EXISTS "Allow all" ON collection_events;
DROP POLICY IF EXISTS "Allow all" ON route_plans;
DROP POLICY IF EXISTS "Allow all" ON bin_level_history;
DROP POLICY IF EXISTS "Allow all" ON daily_collection_time_metrics;
DROP POLICY IF EXISTS "Allow all" ON students;
DROP POLICY IF EXISTS "Allow all" ON waste_transactions;

CREATE POLICY "Allow all" ON bins              FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON waste_categories  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON collection_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON route_plans       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON bin_level_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON daily_collection_time_metrics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON students          FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON waste_transactions FOR ALL USING (true) WITH CHECK (true);
