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

    // Fetch unresolved markets that have slugs in trades
    // Join with trades to ensure we only get markets with slugs
    const { data: marketsWithSlugs, error: fetchError } = await supabase
      .from('trades')
      .select('market_id, market_slug')
      .not('market_slug', 'is', null)
      .limit(batchSize * 10) // Get more to account for duplicates

    if (fetchError) {
      console.error('Error fetching trades:', fetchError)
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Get unique market IDs with their slugs
    const uniqueMarkets = new Map()
    marketsWithSlugs?.forEach(t => {
      if (!uniqueMarkets.has(t.market_id)) {
        uniqueMarkets.set(t.market_id, t.market_slug)
      }
    })

    const marketIdsToCheck = Array.from(uniqueMarkets.keys()).slice(0, batchSize)

    // Fetch market details - get both unresolved markets AND resolved markets missing winning_outcome
    const { data: marketsRaw, error: marketsError } = await supabase
      .from('markets')
      .select('id, question, resolved, winning_outcome')
      .in('id', marketIdsToCheck)
      .or('resolved.eq.false,winning_outcome.is.null')

    if (marketsError) {
      console.error('Error fetching markets:', marketsError)
      return new Response(JSON.stringify({ error: marketsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Add slugs to markets
    const markets = marketsRaw?.map(m => ({
      ...m,
      slug: uniqueMarkets.get(m.id)
    })).filter(m => m.slug) || []

    if (!markets || markets.length === 0) {
      console.log('No markets needing resolution updates found')
      return new Response(JSON.stringify({ ok: true, processed: 0, updated: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Found ${markets.length} markets to check (unresolved or missing winning_outcome)`)

    let updatedCount = 0
    let checkedCount = 0

    // Query each market by slug individually
    for (const market of markets) {
      try {
        const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${market.slug}`
        console.log(`Checking market slug: ${market.slug}`)

        const gammaResponse = await fetch(gammaUrl, {
          headers: { 'Accept': 'application/json' }
        })

        if (!gammaResponse.ok) {
          console.log(`Market ${market.slug} not found in Gamma API (${gammaResponse.status})`)
          continue
        }

        const gammaMarket = await gammaResponse.json()
        checkedCount++

        // Check if market is resolved
        if (gammaMarket.closed && gammaMarket.outcomePrices) {
          // Find winning outcome (highest price)
          const maxPrice = Math.max(...gammaMarket.outcomePrices)
          const winningIndex = gammaMarket.outcomePrices.indexOf(maxPrice)
          const winningOutcome = gammaMarket.outcomes[winningIndex]

          console.log(`Market ${market.slug} resolved: winner = ${winningOutcome}`)

          // Update market as resolved
          const { error: updateError } = await supabase
            .from('markets')
            .update({
              resolved: true,
              resolved_at: gammaMarket.closed_time || new Date().toISOString(),
              winning_outcome: winningOutcome,
              updated_at: new Date().toISOString()
            })
            .eq('id', market.id)

          if (updateError) {
            console.error(`Error updating market ${market.id}:`, updateError)
          } else {
            updatedCount++
          }
        }
      } catch (error) {
        console.error(`Error processing market ${market.slug}:`, error)
      }
    }

    console.log(`Checked ${checkedCount} markets, resolved ${updatedCount}`)

    return new Response(JSON.stringify({
      ok: true,
      processed: checkedCount,
      updated: updatedCount,
      total_queried: markets.length
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
