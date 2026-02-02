// Deno Edge Function to backfill missing 'side' field on existing trades
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

console.log('backfill-trade-sides starting')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const batchSize = parseInt(url.searchParams.get('batch') || '100', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)

    console.log(`Processing batch of ${batchSize} trades with offset ${offset}`)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Get trades with null side field
    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .select('tx_hash, timestamp')
      .is('side', null)
      .order('timestamp', { ascending: false })
      .range(offset, offset + batchSize - 1)

    if (tradesError) {
      console.error('Error fetching trades:', tradesError)
      return new Response(JSON.stringify({ error: tradesError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!trades || trades.length === 0) {
      console.log('No trades needing side backfill')
      return new Response(JSON.stringify({ ok: true, processed: 0, updated: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Found ${trades.length} trades to backfill`)

    let updatedCount = 0
    let checkedCount = 0

    // Fetch trades from Polymarket API by timestamp range to find matching trades
    // We'll fetch a window around each trade's timestamp
    for (const trade of trades) {
      try {
        // Query Polymarket API for recent trades and find by tx_hash
        const txHash = trade.tx_hash

        // The Polymarket data API allows querying by transaction hash
        const apiUrl = `https://data-api.polymarket.com/trades?transactionHash=${txHash}`

        const response = await fetch(apiUrl)

        if (!response.ok) {
          console.log(`API error for tx ${txHash}: ${response.status}`)
          checkedCount++
          continue
        }

        const apiTrades = await response.json()

        if (!Array.isArray(apiTrades) || apiTrades.length === 0) {
          console.log(`No API result for tx ${txHash}`)
          checkedCount++
          continue
        }

        // Find the matching trade
        const apiTrade = apiTrades[0]
        const side = apiTrade.side ? apiTrade.side.toUpperCase() : null

        if (side) {
          const { error: updateError } = await supabase
            .from('trades')
            .update({ side })
            .eq('tx_hash', txHash)

          if (updateError) {
            console.error(`Error updating trade ${txHash}:`, updateError)
          } else {
            updatedCount++
          }
        }

        checkedCount++

        // Small delay to avoid rate limiting
        if (checkedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }

      } catch (error) {
        console.error(`Error processing trade ${trade.tx_hash}:`, error)
        checkedCount++
      }
    }

    console.log(`Checked ${checkedCount} trades, updated ${updatedCount}`)

    return new Response(JSON.stringify({
      ok: true,
      processed: checkedCount,
      updated: updatedCount,
      total_queried: trades.length
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
