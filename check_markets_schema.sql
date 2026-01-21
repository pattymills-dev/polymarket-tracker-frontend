-- Check the actual schema of the markets table
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'markets'
ORDER BY ordinal_position;
