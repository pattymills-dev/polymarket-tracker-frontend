-- Fix function overload issue with refresh_copyable_traders
-- Drop the old 2-parameter version that conflicts with the 3-parameter version

DROP FUNCTION IF EXISTS refresh_copyable_traders(INT, INT);
