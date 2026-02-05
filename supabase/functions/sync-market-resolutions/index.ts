// Deno Edge Function to sync Polymarket market resolutions
import { createClient } from 'supabase'

console.log('sync-market-resolutions v3 starting')

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
    const batchSize = parseInt(url.searchParams.get('batch') || '50', 10)
    const mode = url.searchParams.get('mode') || 'recent' // 'recent' prioritizes traded markets, 'all' does oldest first

    console.log(`Processing batch of ${batchSize} markets in ${mode} mode`)

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    let unresolvedMarkets: any[] = []
    let marketsError: any = null

    if (mode === 'recent') {
      // PRIORITY MODE: Get markets that have trades in the last 7 days
      // These are the ones users actually care about
      const { data, error } = await supabase.rpc('get_unresolved_markets_with_recent_trades', {
        p_days: 7,
        p_limit: batchSize
      })

      if (error) {
        // Fallback if RPC doesn't exist - use a join query approach
        console.log('RPC not found, using fallback query')
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('markets')
          .select(`
            id, question, slug, resolved, winning_outcome,
            trades!inner(timestamp)
          `)
          .or('resolved.eq.false,winning_outcome.is.null')
          .gte('trades.timestamp', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .limit(batchSize)

        if (fallbackError) {
          // Final fallback - just get unresolved markets ordered by most recent update
          console.log('Fallback query failed, using simple query')
          const { data: simpleData, error: simpleError } = await supabase
            .from('markets')
            .select('id, question, slug, resolved, winning_outcome')
            .or('resolved.eq.false,winning_outcome.is.null')
            .order('updated_at', { ascending: false }) // Most recently updated first
            .limit(batchSize)

          unresolvedMarkets = simpleData || []
          marketsError = simpleError
        } else {
          // Dedupe markets (join may return duplicates)
          const seen = new Set()
          unresolvedMarkets = (fallbackData || []).filter((m: any) => {
            if (seen.has(m.id)) return false
            seen.add(m.id)
            return true
          })
        }
      } else {
        unresolvedMarkets = data || []
      }
    } else {
      // ALL MODE: Process oldest unresolved markets first (for backfill)
      const { data, error } = await supabase
        .from('markets')
        .select('id, question, slug, resolved, winning_outcome')
        .or('resolved.eq.false,winning_outcome.is.null')
        .order('updated_at', { ascending: true, nullsFirst: true })
        .limit(batchSize)

      unresolvedMarkets = data || []
      marketsError = error
    }

    if (marketsError) {
      console.error('Error fetching markets:', marketsError)
      return new Response(JSON.stringify({ error: marketsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const markets = unresolvedMarkets || []

    console.log(`Fetched ${markets.length} markets needing resolution updates`)

    if (markets.length === 0) {
      console.log('No markets needing resolution updates found')
      return new Response(JSON.stringify({ ok: true, processed: 0, updated: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let updatedCount = 0
    let checkedCount = 0
    let errorCount = 0

    // Process markets in parallel batches of 10 to speed things up
    const parallelBatchSize = 10
    for (let i = 0; i < markets.length; i += parallelBatchSize) {
      const batch = markets.slice(i, i + parallelBatchSize)

      const results = await Promise.allSettled(batch.map(async (market: any) => {
        try {
          let gammaMarket: any = null

          if (market.slug) {
            const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${market.slug}`
            const gammaResponse = await fetch(gammaUrl, {
              headers: { 'Accept': 'application/json' }
            })

            if (gammaResponse.ok) {
              gammaMarket = await gammaResponse.json()
            }
          }

          if (!gammaMarket && market.id) {
            // Fallback: fetch by conditionId (Gamma accepts single condition_ids)
            const byIdUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${market.id}`
            const byIdResponse = await fetch(byIdUrl, {
              headers: { 'Accept': 'application/json' }
            })

            if (byIdResponse.ok) {
              const byIdMarkets = await byIdResponse.json()
              if (Array.isArray(byIdMarkets) && byIdMarkets.length > 0) {
                gammaMarket = byIdMarkets[0]
              }
            }
          }

          if (!gammaMarket) {
            console.log(`Market ${market.slug || market.id} not found in Gamma API`)
            return { checked: true, updated: false }
          }

          // Check if market is resolved
          if (gammaMarket.closed && gammaMarket.outcomePrices) {
            // Parse outcomes and prices - they come as JSON strings from the API
            const outcomes = typeof gammaMarket.outcomes === 'string'
              ? JSON.parse(gammaMarket.outcomes)
              : gammaMarket.outcomes
            const outcomePrices = typeof gammaMarket.outcomePrices === 'string'
              ? JSON.parse(gammaMarket.outcomePrices).map(Number)
              : gammaMarket.outcomePrices.map(Number)

            // Find winning outcome (highest price)
            const maxPrice = Math.max(...outcomePrices)
            const winningIndex = outcomePrices.indexOf(maxPrice)
            const winningOutcome = outcomes[winningIndex]

            console.log(`Market ${market.slug} resolved: winner = ${winningOutcome}`)

            // Update market as resolved
            const { error: updateError } = await supabase
              .from('markets')
              .update({
                resolved: true,
                resolved_at: gammaMarket.closed_time || new Date().toISOString(),
                winning_outcome: winningOutcome,
                slug: market.slug || gammaMarket.slug || null,
                question: market.question || gammaMarket.question || gammaMarket.title || null,
                updated_at: new Date().toISOString()
              })
              .eq('id', market.id)

            if (updateError) {
              console.error(`Error updating market ${market.id}:`, updateError)
              return { checked: true, updated: false, error: true }
            }

            return { checked: true, updated: true }
          } else {
            // Market not yet resolved, update timestamp so it moves down the queue
            await supabase
              .from('markets')
              .update({
                updated_at: new Date().toISOString(),
                slug: market.slug || gammaMarket.slug || null,
                question: market.question || gammaMarket.question || gammaMarket.title || null
              })
              .eq('id', market.id)

            return { checked: true, updated: false }
          }
        } catch (error) {
          console.error(`Error processing market ${market.slug}:`, error)
          return { checked: true, updated: false, error: true }
        }
      }))

      // Tally results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.checked) checkedCount++
          if (result.value.updated) updatedCount++
          if (result.value.error) errorCount++
        } else {
          errorCount++
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + parallelBatchSize < markets.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    console.log(`Checked ${checkedCount} markets, resolved ${updatedCount}, errors ${errorCount}`)

    return new Response(JSON.stringify({
      ok: true,
      processed: checkedCount,
      updated: updatedCount,
      errors: errorCount,
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
