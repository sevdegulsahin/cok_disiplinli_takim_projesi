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
  updated_at TIMESTAMPTZ DEFAULT NOW()
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

-- Route plans: generated collection routes
CREATE TABLE IF NOT EXISTS route_plans (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  route_order JSONB NOT NULL DEFAULT '[]',  -- array of bin_ids in collection order
  total_fill_score NUMERIC(5,2) DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed'))
);

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

-- -------------------------------------------------------
-- REALTIME + Row Level Security (PUBLIC ACCESS FOR DEMO)
-- -------------------------------------------------------
ALTER TABLE bins ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON bins FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON waste_categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON collection_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all" ON route_plans FOR ALL USING (true) WITH CHECK (true);
-- ── STUDENTS (GAMIFICATION) ──
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    card_id VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    total_points INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── WASTE TRANSACTIONS (GAMIFICATION) ──
CREATE TABLE waste_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    bin_id UUID REFERENCES bins(id) ON DELETE CASCADE,
    waste_category waste_type NOT NULL,
    points_awarded INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS for gamification tables
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_transactions ENABLE ROW LEVEL SECURITY;

-- Allow anonymous access for the sake of the frontend demo
CREATE POLICY "Public read access for students" ON students FOR SELECT USING (true);
CREATE POLICY "Public insert access for students" ON students FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update access for students" ON students FOR UPDATE USING (true);

CREATE POLICY "Public read access for waste_transactions" ON waste_transactions FOR SELECT USING (true);
CREATE POLICY "Public insert access for waste_transactions" ON waste_transactions FOR INSERT WITH CHECK (true);

-- Seed Data for Gamification
INSERT INTO students (card_id, full_name, total_points) VALUES
('CARD-001', 'Ahmet Yılmaz', 45),
('CARD-002', 'Ayşe Demir', 20),
('CARD-003', 'Mehmet Kaya', 12);
