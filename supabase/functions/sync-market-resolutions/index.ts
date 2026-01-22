// Deno Edge Function to sync Polymarket market resolutions
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

console.log('sync-market-resolutions v2 starting')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    // Limit batch size to 20 to avoid 414 URL Too Large error
    // Each market ID is ~66 chars, so 20 IDs = ~1320 chars which is safe
    const requestedBatch = parseInt(url.searchParams.get('batch') || '20', 10)
    const batchSize = Math.min(requestedBatch, 20)

    console.log(`Processing batch of ${batchSize} markets`)

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch unresolved markets
    const { data: markets, error: fetchError } = await supabase
      .from('markets')
      .select('id, question')
      .eq('resolved', false)
      .limit(batchSize)

    if (fetchError) {
      console.error('Error fetching markets:', fetchError)
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!markets || markets.length === 0) {
      console.log('No unresolved markets found')
      return new Response(JSON.stringify({ ok: true, processed: 0, updated: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Found ${markets.length} unresolved markets to check`)

    // Fetch resolution data from Gamma API
    const conditionIds = markets.map(m => m.id)
    const gammaUrl = 'https://gamma-api.polymarket.com/markets'
    const gammaParams = new URLSearchParams()
    conditionIds.forEach(id => gammaParams.append('condition_ids', id))

    console.log(`Gamma request: ${gammaUrl}?${gammaParams.toString().substring(0, 200)}...`)

    const gammaResponse = await fetch(`${gammaUrl}?${gammaParams.toString()}`, {
      headers: { 'Accept': 'application/json' }
    })

    if (!gammaResponse.ok) {
      const errorText = await gammaResponse.text()
      console.error(`Gamma API error: ${gammaResponse.status} - ${errorText}`)
      return new Response(JSON.stringify({
        error: `Gamma API returned ${gammaResponse.status}`,
        details: errorText
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const gammaMarkets = await gammaResponse.json()
    console.log(`Gamma returned ${gammaMarkets.length} market records`)

    let updatedCount = 0

    // Process each market
    for (const gammaMarket of gammaMarkets) {
      if (gammaMarket.closed && gammaMarket.outcome !== null && gammaMarket.outcome !== undefined) {
        const conditionId = gammaMarket.condition_id

        // Update market as resolved
        const { error: updateError } = await supabase
          .from('markets')
          .update({
            resolved: true,
            resolved_at: new Date().toISOString(),
            winning_outcome: gammaMarket.outcome,
            updated_at: new Date().toISOString()
          })
          .eq('id', conditionId)

        if (updateError) {
          console.error(`Error updating market ${conditionId}:`, updateError)
        } else {
          updatedCount++
          console.log(`✓ Resolved market ${conditionId}: outcome = ${gammaMarket.outcome}`)
        }
      }
    }

    console.log(`Sync complete: processed ${markets.length}, updated ${updatedCount}`)

    return new Response(JSON.stringify({
      ok: true,
      processed: markets.length,
      updated: updatedCount
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({
      error: error.message || 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
