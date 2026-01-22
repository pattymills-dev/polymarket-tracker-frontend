# Manual Populate and Sync

Since fetch-trades is timing out, let's manually trigger the populate and resolution sync:

## Step 1: Populate markets from existing trades
Open this URL in your browser:
```
https://smuktlgclwvaxnduuinm.supabase.co/functions/v1/populate-markets-from-trades
```

You'll get a 401 error. That's expected - we need to call it with auth.

## Step 2: Call it via browser console
Open your live site, open browser console (F12), and paste this:

```javascript
const SUPABASE_URL = 'https://smuktlgclwvaxnduuinm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdWt0bGdjbHd2YXhuZHV1aW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzI0MTQsImV4cCI6MjA4MzkwODQxNH0.tZMxayi3YL7DzUeG2_YcAfZzZDxMsO16RGurS-MiBUo';

// Step 1: Populate markets from trades
fetch(`${SUPABASE_URL}/functions/v1/populate-markets-from-trades`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  }
})
.then(r => r.json())
.then(data => {
  console.log('Populate result:', data);

  // Step 2: Sync resolutions
  return fetch(`${SUPABASE_URL}/functions/v1/sync-market-resolutions?batch=500`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    }
  });
})
.then(r => r.json())
.then(data => {
  console.log('Resolutions result:', data);
  alert('Done! Check console for results.');
})
.catch(err => console.error('Error:', err));
```

## Step 3: Check results
After running the above, you should see in console:
- `Populate result: { success: true, inserted: XXXX }` - number of markets added
- `Resolutions result: { ok: true, processed: XXX, updated: XXX }` - number resolved

Then refresh your page and you should see multiple traders!
